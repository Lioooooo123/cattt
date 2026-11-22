import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, createReadStream, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, statSync, writeSync, unlinkSync,
} from "node:fs";
import { copyFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { MAX_FILE_BYTES, SHA256_PATTERN } from "./types.ts";
import type { BlobIdentity } from "./types.ts";

const verified = Symbol("verified blob");
export type VerifiedBlob = BlobIdentity & { readonly [verified]: true };

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class BlobStorage {
  private readonly contentDir: string;
  private readonly uploads: BlobStaging;

  constructor(root: string) {
    this.contentDir = join(root, "content");
    this.uploads = new BlobStaging(join(root, "uploads"));
    mkdirSync(this.contentDir, { recursive: true, mode: 0o700 });
  }

  private contentPath(sha256: string): string {
    if (!SHA256_PATTERN.test(sha256)) {
      throw new TypeError("无效的 SHA-256");
    }
    return join(this.contentDir, sha256);
  }

  localPath(blob: BlobIdentity): string | undefined {
    const path = this.contentPath(blob.sha256);
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat?.isFile() && stat.size === blob.byteSize ? path : undefined;
  }

  localBlob(blob: BlobIdentity): Bun.BunFile | undefined {
    const path = this.localPath(blob);
    return path === undefined ? undefined : Bun.file(path);
  }

  /** Read a bounded snapshot and verify the same bytes that will be given to the model. */
  async readVerifiedBytes(blob: BlobIdentity): Promise<Uint8Array | undefined> {
    if (blob.byteSize < 1 || blob.byteSize > MAX_FILE_BYTES) {
      return undefined;
    }
    const file = this.localBlob(blob);
    if (!file) {
      return undefined;
    }
    try {
      const bytes = await file.slice(0, blob.byteSize + 1).bytes();
      return bytes.byteLength === blob.byteSize && createHash("sha256").update(bytes).digest("hex") === blob.sha256
        ? bytes : undefined;
    } catch (error) {
      if (missing(error) || (error as NodeJS.ErrnoException).code === "EACCES") {
        return undefined;
      }
      throw error;
    }
  }

  offset(id: string): number {
    return this.uploads.offset(id);
  }

  append(id: string, bytes: Uint8Array): void {
    this.uploads.append(id, bytes);
  }

  discard(id: string): void {
    this.uploads.discard(id);
  }

  installUpload(id: string, expected: BlobIdentity): Promise<VerifiedBlob | undefined> {
    return this.installVerified(this.uploads.path(id), expected);
  }

  /**
   * Install a completed download or staged upload. The caller owns the input
   * file. Only the verified copy is published to the hash-addressed directory.
   */
  async installVerified(
    input: string, expected: BlobIdentity, mayInstall: () => boolean = () => true,
  ): Promise<VerifiedBlob | undefined> {
    const destination = this.contentPath(expected.sha256);
    const pending = join(this.contentDir, `.incoming-${randomUUID()}`);
    try {
      await copyFile(input, pending);
      const stat = statSync(pending);
      if (stat.size !== expected.byteSize) {
        return undefined;
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(pending)) {
        hash.update(chunk);
      }
      if (hash.digest("hex") !== expected.sha256) {
        return undefined;
      }
      const fd = await open(pending, "r");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
      if (!mayInstall()) {
        return undefined;
      }
      renameSync(pending, destination);
      return { sha256: expected.sha256, byteSize: expected.byteSize, [verified]: true };
    } finally {
      await unlink(pending).catch((error: unknown) => {
        if (!missing(error)) {
          throw error;
        }
      });
    }
  }
}

/** Private, persisted staging shared by device uploads and authenticated peer downloads. */
export class BlobStaging {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  path(key: string): string {
    return join(this.directory, key);
  }

  keys(): string[] {
    return readdirSync(this.directory);
  }

  offset(key: string): number {
    return statSync(this.path(key), { throwIfNoEntry: false })?.size ?? 0;
  }

  append(key: string, bytes: Uint8Array): void {
    const fd = openSync(this.path(key), "a", 0o600);
    try {
      let written = 0;
      while (written < bytes.byteLength) {
        const count = writeSync(fd, bytes, written, bytes.byteLength - written);
        if (!count) {
          throw new Error("文件写入未前进");
        }
        written += count;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  discard(key: string): void {
    try {
      unlinkSync(this.path(key));
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
  }
}
