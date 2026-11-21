import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ManualClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { uuidv7 } from "../src/ids/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { createDevice, revokeDevice } from "../src/store/identity.ts";
import { hosts, members } from "../src/store/schema/identity.ts";
import { issueTestDevice } from "./identity-fixture.ts";

test("Hono 实服区分两成员 Actor，成员名单共享且不泄露设备秘密", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-identity-http-"));
  const gateway = new Gateway();
  const clock = new ManualClock("test", 100);
  const host = await startHost({
    dataDir: directory, port: 0, lanHttpsPort: 0, clock, householdName: "我们的家", hostName: "家里的 Mac",
  }, [gateway]);
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    const issued = [issueTestDevice(host, "甲"), issueTestDevice(host, "乙")];
    const profiles = issued.map(({ memberId }, index) => ({
      id: memberId, householdId: host.householdId, displayName: index === 0 ? "甲" : "乙", homeHostId: host.hostId,
    }));
    for (const [index, device] of issued.entries()) {
      const headers = { Authorization: `Bearer ${device.token}` };
      const me = await fetch(`${base}/v2/me`, { headers });
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({
        actor: {
          memberId: device.memberId, deviceId: device.deviceId, hostId: host.hostId, householdId: host.householdId,
        },
        member: profiles[index],
        household: { id: host.householdId, name: "我们的家" },
      });
      const response = await fetch(`${base}/v2/members`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ members: profiles });
    }
    expect((await fetch(`${base}/v2/healthz`)).status).toBe(200);
  } finally {
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("缺少或无效令牌、撤销设备、成员墓碑和远端宿主设备全部 401，SSE 也须认证", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-identity-denied-"));
  const gateway = new Gateway();
  const clock = new ManualClock("test", 100);
  const host = await startHost({ dataDir: directory, port: 0, lanHttpsPort: 0, clock }, [gateway]);
  const base = `http://127.0.0.1:${gateway.port}`;
  const unauthorized = async (authorization?: string) => {
    for (const path of ["/v2/me", "/v2/members", "/v2/conversations/unknown/turns/unknown/stream"]) {
      const response = await fetch(base + path, {
        headers: authorization ? { Authorization: authorization } : undefined,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
    }
  };
  try {
    const first = issueTestDevice(host, "甲");
    const second = issueTestDevice(host, "乙");
    await unauthorized();
    await unauthorized("Bearer invalid");
    await unauthorized(`Basic ${first.token}`);
    await unauthorized(`Bearer mm_dvc_${"a".repeat(43)}`);
    const remoteHostId = uuidv7(clock);
    const local = host.store.db.select().from(hosts).where(eq(hosts.id, host.hostId)).get()!;
    host.store.db.insert(hosts).values({ ...local, id: remoteHostId }).run();
    const remote = createDevice(host.store.db, clock, {
      memberId: first.memberId, hostId: remoteHostId, name: "另一宿主的 iPhone",
    });
    await unauthorized(`Bearer ${remote.token}`);
    revokeDevice(host.store.db, clock, first.deviceId);
    await unauthorized(`Bearer ${first.token}`);
    host.store.db.update(members).set({ deletedAt: clock.wallMs() }).where(eq(members.id, second.memberId)).run();
    await unauthorized(`Bearer ${second.token}`);
  } finally {
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
