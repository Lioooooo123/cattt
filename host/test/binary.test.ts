import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store/index.ts";
import { listWorkerReports } from "../src/store/ticket-worker.ts";

test("编译产物脱离 drizzle 目录运行，HTTPS mock 聊天、隔离计算和 SIGTERM", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-binary-"));
  const binary = join(directory, "cattt-host");
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const build = Bun.spawn([
      process.execPath, "build", "--compile", entry,
      fileURLToPath(new URL("../src/ticket-workers/compute-worker.ts", import.meta.url)), "--outfile", binary,
    ], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [buildCode, stdout, stderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    expect(buildCode, stdout + stderr).toBe(0);

    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = reservation.port;
    await reservation.stop(true);
    const lanReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const lanPort = lanReservation.port;
    await lanReservation.stop(true);
    const peerReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const peerPort = peerReservation.port;
    await peerReservation.stop(true);
    expect(existsSync(join(directory, "drizzle"))).toBe(false);
    const running = Bun.spawn([binary], {
      cwd: directory,
      env: {
        CATTT_DATA_DIR: join(directory, "data"),
        CATTT_PORT: String(port),
        CATTT_LAN_HTTPS_PORT: String(lanPort),
        CATTT_PEER_HTTPS_PORT: String(peerPort),
        MODEL_PROVIDER: "mock",
        MOCK_DELAY_MS: "0",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    child = running;
    const childErrors = new Response(running.stderr).text();
    let health: unknown;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v2/healthz`, {
          signal: AbortSignal.timeout(200),
        });
        health = await response.json();
        break;
      } catch {
        if (child.exitCode !== null) {
          throw new Error(`编译产物提前退出：${await childErrors}`);
        }
        await Bun.sleep(50);
      }
    }
    expect(health).toMatchObject({ ok: true, protocol_version: 1 });
    expect((health as { host_id: string }).host_id)
      .toMatch(/^[0-9a-f-]{14}7[0-9a-f-]{21}$/);
    expect(existsSync(join(directory, "data", "cattt.db"))).toBe(true);
    const ca = readFileSync(join(directory, "data/tls/ca.crt"), "utf8");
    const secure = await fetch(`https://127.0.0.1:${lanPort}/v2/healthz`, { tls: { ca } });
    expect(await secure.json()).toEqual(health);
    const admin = readFileSync(join(directory, "data/host-admin.token"), "utf8");
    const json = async (path: string, token: string, body?: unknown) => {
      const response = await fetch(`${path.startsWith("/host/") ? `http://127.0.0.1:${port}` : `https://127.0.0.1:${lanPort}`}${path}`, {
        method: body === undefined ? "GET" : "POST", tls: { ca }, signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const peer = await json("/host/peer-identity", admin);
    expect(peer).toMatchObject({
      host_id: (health as { host_id: string }).host_id, protocol_version: 8, address: { port: peerPort },
    });
    const member = await json("/host/members", admin, { display_name: "甲" });
    const pairing = await json("/host/pairing-codes", admin, { member_id: member.member.id });
    const paired = await json("/v2/pair", "", { code: pairing.code, device_name: "手机" });
    const list = await json("/v2/conversations", paired.device_token);
    const sent = await json(`/v2/conversations/${list.conversations[1].id}/messages`, paired.device_token, { client_message_id: "compiled", text: "你好" });
    const stream = await fetch(`https://127.0.0.1:${lanPort}${sent.turn.stream_url}`, { tls: { ca }, signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${paired.device_token}` } });
    expect(await stream.text()).toContain('"status":"completed"');
    const errand = await json("/v2/tickets", paired.device_token, {
      kind: "start", goal: "整理待确认问题", conversation_id: list.conversations[1].id,
      source_message_id: sent.message.id, source_revision: 1,
    });
    const db = openStore(join(directory, "data", "cattt.db"));
    try {
      const hostId = (health as { host_id: string }).host_id;
      for (let attempt = 0; attempt < 50 && listWorkerReports(db.db, hostId).length === 0; attempt++) {
        await Bun.sleep(20);
      }
      const reports = listWorkerReports(db.db, hostId);
      expect(reports.map(({ result }) => result.status)).toEqual(["waiting"]);
      expect(reports).toMatchObject([{
        ticketId: errand.ticket_id, conversationId: list.conversations[1].id,
        result: { status: "waiting" },
      }]);
      const status = await json(`/v2/tickets/${errand.ticket_id}`, paired.device_token);
      expect(status.ticket.stage).toBe("waiting");
    } finally {
      db.close();
    }
    child.kill("SIGTERM");
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error("SIGTERM 退出超时")), 5000);
      }),
    ]);
    expect(exitCode, await childErrors).toBe(0);
  } finally {
    clearTimeout(exitTimer);
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
