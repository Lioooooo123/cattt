import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const formats: Readonly<Record<string, string>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heic",
};

export class Thumbnails {
  private readonly pending = new Map<string, Promise<Bun.BunFile | undefined>>();

  constructor(private readonly directory: string) {}

  supports(mediaType: string): boolean {
    return process.platform === "darwin" && Object.hasOwn(formats, mediaType);
  }

  async get(sha256: string, path: string, mediaType: string): Promise<Bun.BunFile | undefined> {
    const key = `${sha256}-${formats[mediaType]}`;
    const output = join(this.directory, `${key}.jpg`);
    const cached = Bun.file(output);
    if (await cached.exists()) {
      return cached;
    }
    const work = this.pending.get(key) ?? this.generate(path, output, formats[mediaType]!).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  private async generate(input: string, output: string, format: string): Promise<Bun.BunFile | undefined> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const staged = join(this.directory, `.${randomUUID()}.jpg`);
    try {
      try {
        const options = { timeout: 15_000 };
        const info = await run("/usr/bin/sips", ["-g", "format", input], options);
        if (!info.stdout.split("\n").some((line) => line.trim() === `format: ${format}`)) {
          return undefined;
        }
        await run("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", "320", input, "--out", staged], options);
      } catch {
        return undefined;
      }
      const thumbnail = Bun.file(staged);
      if (!(await thumbnail.exists()) || thumbnail.size === 0) {
        return undefined;
      }
      await rename(staged, output);
      return Bun.file(output);
    } finally {
      await rm(staged, { force: true });
    }
  }
}
