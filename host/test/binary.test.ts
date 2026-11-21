import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("编译产物脱离 drizzle 目录运行，HTTPS mock 聊天完成并响应 SIGTERM", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-binary-"));
  const binary = join(directory, "cattt-host");
  const root = fileURLToPath(new URL("..", import.meta.url));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const build = Bun.spawn([
      process.execPath, "build", "--compile", "src/main.ts", "--outfile", binary,
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
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
    expect(existsSync(join(directory, "drizzle"))).toBe(false);
    const running = Bun.spawn([binary], {
      cwd: directory,
      env: {
        ...process.env,
        CATTT_DATA_DIR: join(directory, "data"),
        CATTT_PORT: String(port),
        CATTT_LAN_HTTPS_PORT: String(lanPort),
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
    const member = await json("/host/members", admin, { display_name: "甲" });
    const pairing = await json("/host/pairing-codes", admin, { member_id: member.member.id });
    const paired = await json("/v2/pair", "", { code: pairing.code, device_name: "手机" });
    const list = await json("/v2/conversations", paired.device_token);
    const sent = await json(`/v2/conversations/${list.conversations[1].id}/messages`, paired.device_token, { client_message_id: "compiled", text: "你好" });
    const stream = await fetch(`https://127.0.0.1:${lanPort}${sent.turn.stream_url}`, { tls: { ca }, signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${paired.device_token}` } });
    expect(await stream.text()).toContain('"status":"completed"');
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
