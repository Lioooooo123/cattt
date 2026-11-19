import qrcode from 'qrcode-terminal';
import { initializeLan } from '../src/lan-tls.ts';
import { issuePairingCode } from '../src/pairing.ts';
import { sql } from '../src/db/client.ts';

try {
  const result = await issuePairingCode(await initializeLan());
  console.log(`配对码：${result.code}\n有效至：${result.expires_at.toISOString()}\nCA 指纹：${result.ca_fingerprint_short}\n${result.pair_url}`);
  qrcode.generate(result.pair_url, { small: true });
} finally { await sql.end(); }
