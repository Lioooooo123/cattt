import { createHash, createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthorityKeyIdentifierExtension, BasicConstraintsExtension, KeyUsageFlags, KeyUsagesExtension,
  SubjectKeyIdentifierExtension, X509Certificate as Extensions,
} from "@peculiar/x509";
import { z } from "zod";
import type { Clock } from "../clock/index.ts";
import { generatePeerCertificates } from "./tls.ts";

const bundleSchema = z.strictObject({ key: z.string(), cert: z.string(), caCertificate: z.string() });
export class CertificateError extends Error {}

type Bundle = z.infer<typeof bundleSchema>;

export function peerDnsName(hostId: string): string {
  return `${hostId}.peer.cattt`;
}

export function certificateFingerprint(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}

export function validatePeerCertificates(
  clock: Clock,
  hostId: string,
  cert: string,
  caCertificate: string,
  verifyTime = true,
) {
  let root: X509Certificate;
  let leaf: X509Certificate;
  try {
    root = new X509Certificate(caCertificate);
    leaf = new X509Certificate(cert);
  } catch {
    throw new CertificateError("Peer 证书 PEM 无效");
  }
  const rootExtensions = new Extensions(root.raw);
  const leafExtensions = new Extensions(leaf.raw);
  const rootConstraints = rootExtensions.getExtension(BasicConstraintsExtension);
  const rootUsage = rootExtensions.getExtension(KeyUsagesExtension);
  const rootKeyId = rootExtensions.getExtension(SubjectKeyIdentifierExtension)?.keyId;
  const authorityId = leafExtensions.getExtension(AuthorityKeyIdentifierExtension)?.keyId;
  const name = peerDnsName(hostId);
  if (!root.ca || !rootConstraints?.critical || rootConstraints.pathLength !== 0
    || !rootUsage?.critical || (rootUsage.usages & KeyUsageFlags.keyCertSign) === 0
    || !rootKeyId || rootKeyId !== authorityId
    || !root.checkIssued(root) || !root.verify(root.publicKey)
    || leaf.ca || !leaf.checkIssued(root) || !leaf.verify(root.publicKey)
    || leaf.checkHost(name, { subject: "never", wildcards: false }) !== name
    || !leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1") || !leaf.keyUsage.includes("1.3.6.1.5.5.7.3.2")
    || (verifyTime && [root, leaf].some((item) =>
      clock.wallMs() < Date.parse(item.validFrom) || clock.wallMs() >= Date.parse(item.validTo)))) {
    throw new CertificateError("Peer 证书的签发链、主机身份、用途或有效期不符合要求");
  }
  return {
    cert: leaf.toString(),
    caCertificate: root.toString(),
    fingerprint: certificateFingerprint(leaf.raw),
    expiresAt: Date.parse(leaf.validTo),
  };
}

export async function initializePeerIdentity(dataDir: string, clock: Clock, hostId: string) {
  const directory = join(dataDir, "peer-tls");
  const path = join(directory, "identity.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  function parse(bundle: Bundle) {
    // An expired identity can still start the loopback management API for explicit renewal.
    const validated = validatePeerCertificates(clock, hostId, bundle.cert, bundle.caCertificate, false);
    if (!new X509Certificate(validated.cert).checkPrivateKey(createPrivateKey(bundle.key))) {
      throw new Error("Peer 证书与私钥不匹配");
    }
    return { key: bundle.key, ...validated };
  }

  async function issue() {
    const bundle = await generatePeerCertificates(clock, peerDnsName(hostId));
    const identity = parse(bundle);
    const staged = join(directory, `identity-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(staged, JSON.stringify(bundle), { mode: 0o600, flag: "wx" });
      await rename(staged, path);
    } finally {
      await rm(staged, { force: true });
    }
    return identity;
  }

  const persisted = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  let identity = persisted === undefined ? await issue() : parse(bundleSchema.parse(JSON.parse(persisted)));
  await chmod(path, 0o600);

  let rotation: Promise<typeof identity> | undefined;
  return {
    current: () => identity,
    rotate: () => {
      rotation ??= issue().then((next) => { identity = next; return next; })
        .finally(() => { rotation = undefined; });
      return rotation;
    },
  };
}

export type PeerIdentity = Awaited<ReturnType<typeof initializePeerIdentity>>;
