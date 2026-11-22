import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManualClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { startConfiguredHost } from "../src/runtime/application.ts";
import { createDevice, createMember } from "../src/store/identity.ts";
import { recordWorldObservation, scanCatDiary } from "../src/store/cat-diary.ts";
import { requireSharedPublisher } from "../src/store/publication.ts";
import { snapshotSchema } from "../src/world/protocol.ts";
import { ensureWorld } from "../src/store/world-state.ts";
import { dayStart, nextDay } from "../src/soul/diary-date.ts";
import { composeDailyDraft, dailyDiaryWriter } from "../src/soul/diary-writer.ts";
import { modelConfigFromEnv } from "../src/llm/config.ts";
import { HostModelRuntime } from "../src/runtime/model.ts";
import { openStore } from "../src/store/index.ts";

test("日界保留 DST 和不存在的整日", () => {
  const spring = "2026-03-08";
  const fall = "2026-11-01";
  expect(dayStart(nextDay(spring), "America/New_York") - dayStart(spring, "America/New_York")).toBe(23 * 3600000);
  expect(dayStart(nextDay(fall), "America/New_York") - dayStart(fall, "America/New_York")).toBe(25 * 3600000);
  expect(dayStart("2011-12-30", "Pacific/Apia")).toBe(dayStart("2011-12-31", "Pacific/Apia"));
});

test("日记只能引用审核的事实，拒绝假经历，模型槽位限制为本机或受控 mock", () => {
  const facts = [{ id: "pond", text: "有一会儿，我在池塘边。" }];
  expect(composeDailyDraft({ reflection: "心里软软的。", fact_ids: ["pond"] }, facts))
    .toEqual({ reflection: "心里软软的。", factIds: ["pond"] });
  for (const draft of [
    { reflection: "今天你来过。", fact_ids: [] },
    { reflection: "心里软软的。", fact_ids: ["unknown"] },
    { reflection: "心里软软的。", fact_ids: ["pond", "pond"] },
  ]) expect(() => composeDailyDraft(draft, facts)).toThrow();
  const store = openStore(":memory:");
  try {
    const model = (env: Record<string, string>) => dailyDiaryWriter(new HostModelRuntime({
      config: { dataDir: "", model: modelConfigFromEnv(env) }, hostId: "fixture",
      store, clock: new ManualClock("fixture", 0),
    }));
    expect(model({ MODEL_PROVIDER: "deepseek", EXTRACT_PROVIDER: "deepseek" })).toBeUndefined();
    expect(model({ EXTRACT_MODEL: "test", EXTRACT_BASE_URL: "https://example.com/v1" })).toBeUndefined();
    expect(model({ MODEL_PROVIDER: "deepseek", EXTRACT_MODEL: "test" })?.provider).toBe("local");
    expect(model({ MODEL_PROVIDER: "mock" })).toMatchObject({ provider: "mock", modelId: "mock-extract" });
  } finally { store.close(); }
});


test("实际观察、明确许可和撤回即时影响猫日记，同日只出版一次", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cattt-diary-"));
  const clock = new ManualClock("test", Date.parse("2026-11-22T15:00:00Z"));
  const gateway = new Gateway();
  const requests: { day: string; facts: readonly { id: string; text: string }[] }[] = [];
  const host = await startConfiguredHost({
    dataDir: dir, port: 0, clock, dailyDiaryModel: {
      provider: "mock", modelId: "controlled-diary",
      async generate({ day, facts }, { canUse }) {
        expect(canUse()).toBe(true);
        requests.push({ day, facts });
        return { fact_ids: facts.map(({ id }) => id), reflection: "心里软软的。" };
      },
    },
  }, gateway);
  try {
    const { store, hostId, householdId } = host;
    const member = createMember(store.db, clock, { householdId, homeHostId: hostId, displayName: "甲" });
    const { token } = createDevice(store.db, clock, { memberId: member, hostId, name: "手机" });
    const call = async (path: string, method = "GET", body?: unknown, authenticated = true) => {
      const headers = { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${token}` } : {}) };
      const response = await fetch(`http://127.0.0.1:${gateway.port}/v2${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };
    const day = "2026-11-22";
    store.db.transaction((tx) => {
      const proof = requireSharedPublisher(tx, householdId, host.publication);
      const { cat } = ensureWorld(tx, clock, proof);
      const snapshot = snapshotSchema.parse({
        stateVersion: 0, sceneVersion: 4, destinationIds: ["house", "pond"], currentDestinationId: "pond",
        targetDestinationId: "pond", phase: "idle", action: "idle", paused: false, runnable: true,
      });
      recordWorldObservation(tx, host, proof, cat.id, { ...snapshot, destinationIds: ["house", "pond"] }, clock.wallMs());
      recordWorldObservation(tx, host, proof, cat.id, {
        ...snapshot, destinationIds: ["house", "pond"], currentDestinationId: "house", paused: true,
      }, clock.wallMs());
    });
    const diary = (await call("/diary", "POST", {
      request_id: crypto.randomUUID(), text: "今天把小石头收好了", recorded_at: clock.wallMs(),
      local_day: day, time_zone: "Asia/Shanghai", cat_allowed: true,
    })).body.entry;
    expect((await call("/cat-diary/sources", "POST", {
      kind: "diary", id: diary.id, revision: diary.revision,
    }, false)).status).toBe(401);
    expect((await call("/cat-diary/sources", "POST", { kind: "diary", id: diary.id, revision: diary.revision })).status).toBe(200);
    clock.setWallMs(Date.parse("2026-11-22T16:04:59Z"));
    scanCatDiary(host);
    expect((await call("/cat-diary")).body.entries).toEqual([]);
    clock.advance(1000);
    scanCatDiary(host);
    const getDiary = async () => (await call("/cat-diary")).body.entries;
    let entries = await getDiary();
    for (let i = 0; !entries.length && i < 40; i++) {
      await Bun.sleep(50);
      entries = await getDiary();
    }
    expect(entries).toMatchObject([{ origin: "daily", local_day: day, time_zone: "Asia/Shanghai",
      recorded_at: Date.parse("2026-11-21T16:00:00Z"), writer: { provider: "mock", model_id: "controlled-diary" } }]);
    expect(entries[0].text).toContain("我在池塘边");
    expect(entries[0].text).toContain("小石头");
    expect(entries[0].text).not.toContain("小屋旁");
    scanCatDiary(host);
    expect(requests).toHaveLength(1);
    expect(store.raw.query("select count(*) as count from jobs where queue = 'publish-cat-diary'").get()).toEqual({ count: 1 });
    const revoked = await call(`/diary/${diary.id}/cat-allowed`, "PATCH", {
      request_id: crypto.randomUUID(), expected_revision: diary.revision, cat_allowed: false,
    });
    expect(revoked.status).toBe(200);
    expect((await getDiary())[0]).toMatchObject({ id: entries[0].id, text: "有一会儿，我在池塘边。\n把日子过慢一点，也很好。给自己留一点安静的空当，心里就软软的。" });
    expect(store.raw.query("select count(*) as count from publication_push_outbox").get()).toEqual({ count: 0 });
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
