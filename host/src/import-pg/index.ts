import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readImportReceipt } from "../store/pg-import/receipt.ts";
import { materializeImport } from "../store/pg-import/index.ts";
import type { ImportReport } from "../store/pg-import/index.ts";
import { ImportError, readPgSnapshot } from "./snapshot.ts";

const usage = "cattt import-pg --target-dir /绝对路径 [--legacy-user-id UUID]\n"
  + "通过 CATTT_IMPORT_PG_URL 提供独立 PG 只读连接。目标保存为 <target-dir>/cattt.db。";

function checkTarget(path: string) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ImportError("目标库须为普通文件");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

export async function importPg(args: string[], env: Record<string, string | undefined>): Promise<ImportReport | null> {
  const options = {
    "target-dir": { type: "string" }, "legacy-user-id": { type: "string" }, help: { type: "boolean" },
  } as const;
  const parsed = (() => {
    try { return parseArgs({ args, options }); }
    catch { throw new ImportError(usage); }
  })();
  if (parsed.values.help) { console.log(usage); return null; }
  const requested = parsed.values["target-dir"];
  const source = env.CATTT_IMPORT_PG_URL;
  if (!requested || !isAbsolute(requested) || !source) throw new ImportError(usage);
  const target = resolve(requested);
  const path = join(target, "cattt.db");
  if (existsSync(target) && (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink())) {
    throw new ImportError("目标目录须为独立的普通目录");
  }
  const prior = checkTarget(path) ? readImportReceipt(path) : undefined;
  if (!prior && existsSync(target) && readdirSync(target, { withFileTypes: true })
    .some((entry) => !entry.isDirectory() || !/^\.cattt-import-[a-zA-Z0-9]{6}$/.test(entry.name))) {
    throw new ImportError("目标目录必须为空");
  }
  const snapshot = await readPgSnapshot(source, parsed.values["legacy-user-id"]);
  if (prior) {
    if (prior.sourceSha256 !== snapshot.sourceSha256) throw new ImportError("目标已有导入且 PG 快照已变化");
    return { ...prior, status: "verified" };
  }

  mkdirSync(target, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(target, ".cattt-import-"));
  try {
    const pending = join(staging, "cattt.db");
    closeSync(openSync(pending, "wx", 0o600));
    const report = materializeImport(pending, snapshot);
    // The final database is never opened for writing here. The same-filesystem
    // link publishes the committed, checkpointed file without replacing a path.
    try {
      linkSync(pending, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = checkTarget(path) && readImportReceipt(path);
        if (existing && existing.sourceSha256 === snapshot.sourceSha256) return { ...existing, status: "verified" };
        throw new ImportError("目标已被其他进程占用");
      }
      throw error;
    }
    const directory = openSync(target, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return report;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
