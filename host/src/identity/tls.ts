import "reflect-metadata";
import { createHash, randomBytes, webcrypto, X509Certificate as NodeCertificate } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  BasicConstraintsExtension, cryptoProvider, ExtendedKeyUsageExtension, KeyUsageFlags,
  KeyUsagesExtension, SubjectAlternativeNameExtension, X509Certificate, X509CertificateGenerator,
} from "@peculiar/x509";
import { clockDate } from "../clock/index.ts";
import type { Clock } from "../clock/index.ts";

cryptoProvider.set(webcrypto as unknown as Crypto);
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const DAY_MS = 86_400_000;

export interface LanTlsOptions {
  ips?: () => readonly string[];
  hostname?: string;
}

function ipv4Addresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
}

async function privateWrite(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function optionalRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function keyPair() {
  return webcrypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
}

async function exportKey(key: webcrypto.CryptoKey): Promise<string> {
  const raw = await webcrypto.subtle.exportKey("pkcs8", key);
  return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(raw).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

async function importKey(pem: string) {
  return webcrypto.subtle.importKey("pkcs8", Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64"),
    algorithm, true, ["sign"]);
}

export async function initializeLan(dataDir: string, clock: Clock, options: LanTlsOptions = {}) {
  const dir = join(dataDir, "tls");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  await chmod(dir, 0o700);
  const adminPath = join(dataDir, "host-admin.token");
  let adminToken = await optionalRead(adminPath);
  if (adminToken === undefined) {
    adminToken = randomBytes(32).toString("base64url");
    await privateWrite(adminPath, adminToken);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(adminToken)) {
    throw new Error("宿主管理口令文件损坏，请恢复备份");
  }
  await chmod(adminPath, 0o600);
  let caPem = await optionalRead(join(dir, "ca.crt"));
  let caKey = await optionalRead(join(dir, "ca.key"));
  if ((caPem === undefined) !== (caKey === undefined)) {
    throw new Error("CA 文件不完整，请恢复备份，不能自动更换 CA");
  }
  if (caPem === undefined && caKey === undefined) {
    const keys = await keyPair();
    const ca = await X509CertificateGenerator.createSelfSigned({
      serialNumber: randomBytes(16).toString("hex"),
      name: "CN=Cattt Local CA",
      keys: keys as unknown as CryptoKeyPair,
      signingAlgorithm: algorithm,
      notBefore: clockDate(clock, -DAY_MS),
      notAfter: clockDate(clock, 3650 * DAY_MS),
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
      ],
    });
    caPem = ca.toString("pem");
    caKey = await exportKey(keys.privateKey);
    await privateWrite(join(dir, "ca.key"), caKey);
    await privateWrite(join(dir, "ca.crt"), caPem);
  }
  await chmod(join(dir, "ca.key"), 0o600);
  await chmod(join(dir, "ca.crt"), 0o600);
  const ca = new X509Certificate(caPem!);
  const signingKey = await importKey(caKey!);
  const fingerprint = createHash("sha256").update(new NodeCertificate(caPem!).raw).digest("hex");
  const fingerprintShort = fingerprint.slice(0, 16).match(/.{4}/g)!.join(" ");
  const hosts = () => [
    ...new Set((options.ips ?? ipv4Addresses)().filter((ip) => isIP(ip) === 4)),
  ].sort().concat(`${(options.hostname ?? hostname()).replace(/\.local$/, "")}.local`);
  let cert = await optionalRead(join(dir, "server.crt"));
  let key = await optionalRead(join(dir, "server.key"));
  async function refresh(): Promise<boolean> {
    const desired = [...new Set(["localhost", "127.0.0.1", ...hosts()])].sort()
      .map((value) => ({ type: isIP(value) ? "ip" as const : "dns" as const, value }));
    const previous = cert ? new X509Certificate(cert) : undefined;
    const san = previous?.getExtension(SubjectAlternativeNameExtension)?.names.toJSON();
    if (key && previous && previous.notAfter.getTime() - clock.wallMs() >= 30 * DAY_MS
      && JSON.stringify(san) === JSON.stringify(desired)) {
      return false;
    }
    const keys = await keyPair();
    const leaf = await X509CertificateGenerator.create({
      serialNumber: randomBytes(16).toString("hex"),
      subject: "CN=Cattt",
      issuer: ca.subject,
      publicKey: keys.publicKey as unknown as CryptoKey,
      signingKey: signingKey as unknown as CryptoKey,
      signingAlgorithm: algorithm,
      notBefore: clockDate(clock, -300_000),
      notAfter: clockDate(clock, 365 * DAY_MS),
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
        new SubjectAlternativeNameExtension(desired),
      ],
    });
    const nextKey = await exportKey(keys.privateKey);
    const nextCert = leaf.toString("pem");
    await privateWrite(join(dir, "server.key"), nextKey);
    await privateWrite(join(dir, "server.crt"), nextCert);
    key = nextKey;
    cert = nextCert;
    return true;
  }
  await refresh();
  await chmod(join(dir, "server.key"), 0o600);
  await chmod(join(dir, "server.crt"), 0o600);
  return {
    adminToken, fingerprint, fingerprintShort, hosts, refresh,
    serverOptions: () => ({ key: key!, cert: `${cert!}\n${caPem}` }),
  };
}

export type LanIdentity = Awaited<ReturnType<typeof initializeLan>>;
