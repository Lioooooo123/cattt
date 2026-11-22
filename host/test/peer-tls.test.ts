import "reflect-metadata";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../src/clock/index.ts";
import { initializePeerIdentity } from "../src/identity/peer-tls.ts";

const openssl = process.env.CATTT_TEST_OPENSSL ?? Bun.which("openssl");

test.skipIf(!openssl)("独立 peer CA 和双用途叶证书通过 OpenSSL strict，轮换保留 host ID 并更换指纹", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cattt-peer-tls-"));
  const hostId = "01924716-21d1-7c03-8ace-76eec1fd258c";
  const clock = new SystemClock(hostId);
  try {
    const identity = await initializePeerIdentity(dir, clock, hostId);
    const before = identity.current();
    const root = join(dir, "root.pem");
    const leaf = join(dir, "leaf.pem");
    writeFileSync(root, before.caCertificate);
    writeFileSync(leaf, before.cert);
    for (const purpose of ["sslclient", "sslserver"]) {
      const result = Bun.spawnSync([
        openssl!, "verify", "-x509_strict", "-purpose", purpose, "-CAfile", root, leaf,
      ]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
    expect(statSync(join(dir, "peer-tls")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "peer-tls", "identity.json")).mode & 0o777).toBe(0o600);
    const renewed = await identity.rotate();
    expect(renewed.fingerprint).not.toBe(before.fingerprint);
    expect((await initializePeerIdentity(dir, clock, hostId)).current()).toEqual(renewed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
