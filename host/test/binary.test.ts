import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("编译产物脱离 drizzle 目录运行并响应 SIGTERM", async () => {
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
    expect(health).toMatchObject({ ok: true, protocolVersion: 1 });
    expect((health as { hostId: string }).hostId)
      .toMatch(/^[0-9a-f-]{14}7[0-9a-f-]{21}$/);
    expect(existsSync(join(directory, "data", "cattt.db"))).toBe(true);
    const ca = readFileSync(join(directory, "data/tls/ca.crt"), "utf8");
    const secure = await fetch(`https://127.0.0.1:${lanPort}/v2/healthz`, { tls: { ca } });
    expect(await secure.json()).toEqual(health);
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
