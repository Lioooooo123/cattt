import { randomBytes, webcrypto, X509Certificate as NodeCertificate, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension, SubjectAlternativeNameExtension, X509Certificate, X509CertificateGenerator, cryptoProvider } from '@peculiar/x509';
import { config } from './config.ts';

cryptoProvider.set(webcrypto as unknown as Crypto);
const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const day = 86400_000;
export function lanHosts() {
  const ips = Object.values(networkInterfaces()).flatMap(entries => entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address);
  return [...new Set(ips)].sort().concat(`${hostname().replace(/\.local$/, '')}.local`);
}
async function privateWrite(path: string, value: string) {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function keyPair() { return webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']); }
async function exportKey(key: webcrypto.CryptoKey) {
  const raw = await webcrypto.subtle.exportKey('pkcs8', key);
  return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(raw).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
}
async function importKey(pem: string) {
  return webcrypto.subtle.importKey('pkcs8', Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64'), algorithm, true, ['sign']);
}
async function optionalRead(path: string) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
export async function initializeLan(dataDir = config.CATTT_DATA_DIR) {
  const dir = join(dataDir, 'tls');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  await chmod(dir, 0o700);
  const adminPath = join(dataDir, 'host-admin.token');
  let adminToken = await optionalRead(adminPath);
  if (!adminToken) {
    adminToken = randomBytes(32).toString('base64url');
    await privateWrite(adminPath, adminToken);
  }
  await chmod(adminPath, 0o600);
  let caPem = await optionalRead(join(dir, 'ca.crt'));
  let caKey = await optionalRead(join(dir, 'ca.key'));
  if (!!caPem !== !!caKey) throw new Error('CA 文件不完整，请恢复备份，不能自动更换 CA');
  if (!caPem || !caKey) {
    const keys = await keyPair();
    const ca = await X509CertificateGenerator.createSelfSigned({
      serialNumber: randomBytes(16).toString('hex'), name: 'CN=Cattt Local CA', keys: keys as unknown as CryptoKeyPair,
      signingAlgorithm: algorithm, notBefore: new Date(Date.now() - day), notAfter: new Date(Date.now() + 3650 * day),
      extensions: [new BasicConstraintsExtension(true, 0, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true)],
    });
    caPem = ca.toString('pem'); caKey = await exportKey(keys.privateKey);
    await privateWrite(join(dir, 'ca.key'), caKey);
    await privateWrite(join(dir, 'ca.crt'), caPem);
  }
  await chmod(join(dir, 'ca.key'), 0o600);
  const ca = new X509Certificate(caPem);
  const signingKey = await importKey(caKey);
  const fingerprint = createHash('sha256').update(new NodeCertificate(caPem).raw).digest('hex');
  const fingerprintShort = fingerprint.slice(0, 16).match(/.{4}/g)!.join(' ');
  let cert = await optionalRead(join(dir, 'server.crt'));
  let key = await optionalRead(join(dir, 'server.key'));
  async function refresh() {
    const names = ['localhost', '127.0.0.1', ...lanHosts()].sort();
    const desired = names.map(value => ({ type: isIP(value) ? 'ip' as const : 'dns' as const, value }));
    const previous = cert ? new X509Certificate(cert) : undefined;
    const san = previous?.getExtension(SubjectAlternativeNameExtension)?.names.toJSON();
    if (key && previous && previous.notAfter.getTime() - Date.now() >= 30 * day && JSON.stringify(san) === JSON.stringify(desired)) return false;
    const keys = await keyPair();
    const leaf = await X509CertificateGenerator.create({
      serialNumber: randomBytes(16).toString('hex'), subject: 'CN=Cattt', issuer: ca.subject,
      publicKey: keys.publicKey as unknown as CryptoKey, signingKey: signingKey as unknown as CryptoKey,
      signingAlgorithm: algorithm, notBefore: new Date(Date.now() - 300_000), notAfter: new Date(Date.now() + 365 * day),
      extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']), new SubjectAlternativeNameExtension(desired)],
    });
    key = await exportKey(keys.privateKey); cert = leaf.toString('pem');
    await privateWrite(join(dir, 'server.key'), key);
    await privateWrite(join(dir, 'server.crt'), cert);
    return true;
  }
  await refresh();
  await chmod(join(dir, 'server.key'), 0o600);
  return { adminToken, fingerprint, fingerprintShort, refresh,
    serverOptions: () => ({ key: key!, cert: `${cert!}\n${caPem}` }) };
}
export type LanIdentity = Awaited<ReturnType<typeof initializeLan>>;
