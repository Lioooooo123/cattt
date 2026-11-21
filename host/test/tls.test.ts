import "reflect-metadata";
import { afterEach, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clockDate, ManualClock, SystemClock } from "../src/clock/index.ts";
import { initializeLan } from "../src/identity/tls.ts";

const directories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "cattt-tls-"));
  directories.push(directory);
  return { directory, clock: new ManualClock("test", new SystemClock("test").wallMs()) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CA 只创建一次，指纹为 DER SHA-256，重启复用证书与管理口令并收紧权限", async () => {
  const { directory, clock } = setup();
  const options = { ips: () => ["192.168.1.5"], hostname: "test.local" };
  const first = await initializeLan(directory, clock, options);
  const ca = new X509Certificate(readFileSync(join(directory, "tls/ca.crt")));
  expect(first.fingerprint).toBe(createHash("sha256").update(ca.raw).digest("hex"));
  expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(first.fingerprintShort).toBe(first.fingerprint.slice(0, 16).match(/.{4}/g)!.join(" "));
  expect(ca.ca).toBe(true);
  expect(ca.publicKey.asymmetricKeyType).toBe("ec");
  const second = await initializeLan(directory, clock, options);
  expect(second.fingerprint).toBe(first.fingerprint);
  expect(second.adminToken).toBe(first.adminToken);
  expect(second.serverOptions()).toEqual(first.serverOptions());
  expect(first.hosts()).toEqual(["192.168.1.5", "test.local"]);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(join(directory, "tls")).mode & 0o777).toBe(0o700);
  for (const path of ["host-admin.token", "tls/ca.key", "tls/ca.crt", "tls/server.key", "tls/server.crt"]) {
    expect(statSync(join(directory, path)).mode & 0o777).toBe(0o600);
  }
});

test("IP 或证书剩余不足三十天才重签，SAN 和有效期由注入 Clock 决定", async () => {
  const { directory, clock } = setup();
  let ips = ["192.168.1.5"];
  const identity = await initializeLan(directory, clock, { ips: () => ips, hostname: "test" });
  const initial = identity.serverOptions().cert;
  const leaf = new X509Certificate(initial);
  expect(leaf.checkHost("localhost")).toBe("localhost");
  expect(leaf.checkHost("test.local")).toBe("test.local");
  expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
  expect(leaf.checkIP("192.168.1.5")).toBe("192.168.1.5");
  expect(await identity.refresh()).toBe(false);
  ips = ["192.168.1.6", "192.168.1.6"];
  expect(await identity.refresh()).toBe(true);
  expect(identity.serverOptions().cert).not.toBe(initial);
  expect(new X509Certificate(identity.serverOptions().cert).checkIP("192.168.1.6")).toBe("192.168.1.6");
  const before = identity.serverOptions().cert;
  const day = 86_400_000;
  clock.advance(335 * day - clock.wallMs() % 1000);
  expect(await identity.refresh()).toBe(false);
  clock.advance(1);
  expect(await identity.refresh()).toBe(true);
  expect(identity.serverOptions().cert).not.toBe(before);
  const after = new X509Certificate(identity.serverOptions().cert);
  expect(Date.parse(after.validTo)).toBe(Math.floor((clock.wallMs() + 365 * day) / 1000) * 1000);
  expect(identity.fingerprint).toBe(createHash("sha256")
    .update(new X509Certificate(readFileSync(join(directory, "tls/ca.crt"))).raw).digest("hex"));
});

test("残缺 CA 不能静默更换，入口首导入 reflect-metadata，日期适配不绕开 Clock", async () => {
  const { directory, clock } = setup();
  await initializeLan(directory, clock, { ips: () => [], hostname: "test" });
  const key = readFileSync(join(directory, "tls/ca.key"), "utf8");
  unlinkSync(join(directory, "tls/ca.crt"));
  await expect(initializeLan(directory, clock)).rejects.toThrow("CA 文件不完整");
  expect(readFileSync(join(directory, "tls/ca.key"), "utf8")).toBe(key);
  expect(readFileSync(new URL("../src/main.ts", import.meta.url), "utf8").split("\n")[0])
    .toBe('import "reflect-metadata";');
  expect(clockDate(clock, -1000).getTime()).toBe(clock.wallMs() - 1000);
});
