import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStorage } from "../src/files/blobs.ts";
import { findFileBlob, recordFileBlob } from "../src/store/files.ts";
import { openStore } from "../src/store/index.ts";

test("复制下载经本机完整哈希验证后才登记，失败不会覆盖已验证原件", async () => {
  const path = mkdtempSync(join(tmpdir(), "cattt-file-blobs-"));
  const store = openStore(":memory:");
  try {
    const storage = new BlobStorage(path);
    const bytes = new TextEncoder().encode("附件");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const expected = { sha256, byteSize: bytes.length };
    const incoming = join(path, "peer-download");
    await Bun.write(incoming, "半传");
    expect(await storage.installVerified(incoming, expected)).toBeUndefined();
    expect(findFileBlob(store.db, sha256)).toBeUndefined();
    expect(storage.localBlob(expected)).toBeUndefined();
    await Bun.write(incoming, bytes);
    const verified = (await storage.installVerified(incoming, expected))!;
    recordFileBlob(store.db, verified, 123);
    expect(findFileBlob(store.db, sha256)).toMatchObject(expected);
    expect(await storage.localBlob(expected)?.text()).toBe("附件");
    await Bun.write(incoming, "坏件");
    expect(await storage.installVerified(incoming, expected)).toBeUndefined();
    expect(await storage.localBlob(expected)?.text()).toBe("附件");
  } finally {
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});
