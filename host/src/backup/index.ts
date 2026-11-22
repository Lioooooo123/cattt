import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { clockDate, SystemClock } from "../clock/index.ts";
import type { Clock } from "../clock/index.ts";
import type { Store } from "../store/index.ts";
import { backupBlobs, chooseRestoreDatabase, fenceRestoredDatabase, inspectDatabase, snapshotDatabase } from "../store/backup.ts";
import type { BackupBlob } from "../store/backup.ts";

const databasePath = "cattt.db";
const paths = ["env", "host-admin.token", "tls/ca.crt", "tls/ca.key",
  "tls/server.crt", "tls/server.key", "peer-tls/identity.json"] as const;
const inventory: readonly string[] = [databasePath, ...paths];
const blobPath = /^(?:blobs\/content\/[a-f0-9]{64}|blobs\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const filePathSchema = z.string().refine((path) => inventory.includes(path) || blobPath.test(path));
const recoveryDir = "restore-pending";

const idSchema = z.string().regex(/^cattt-[0-9]{8}T[0-9]{9}Z-[a-f0-9-]{36}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const databaseSchema = z.strictObject({
  hostId: z.uuid(), householdId: z.uuid(), generation: z.uuidv4(), seq: z.int().nonnegative(), migration: hash,
});
const manifestSchema = z.strictObject({
  format: z.literal(1), id: idSchema, createdAt: z.iso.datetime(),
  kind: z.enum(["manual", "pre_restore"]), database: databaseSchema,
  files: z.array(z.strictObject({ path: filePathSchema, bytes: z.int().nonnegative(), sha256: hash })),
});
const pendingSchema = z.strictObject({ recoveryId: idSchema, selectedId: idSchema });
type Manifest = z.infer<typeof manifestSchema>;

function entry(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function directory(path: string, create = false) {
  if (create && !entry(path)) mkdirSync(path, { mode: 0o700 });
  if (!entry(path)?.isDirectory()) throw new Error("备份目录不存在或不是普通目录");
  return path;
}

function sync(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function located(root: string, path: string, create = false) {
  filePathSchema.parse(path);
  let parent = root;
  const pieces = path.split("/");
  for (const piece of pieces.slice(0, -1)) {
    parent = join(parent, piece);
    if (!entry(parent) && !create) return undefined;
    directory(parent, create);
  }
  return join(parent, pieces.at(-1)!);
}

function regular(root: string, path: string) {
  const file = located(root, path);
  if (!file) return;
  const stat = entry(file);
  if (!stat) return;
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("备份范围包含非普通文件");
  return file;
}

function copy(source: string, target: string) {
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  sync(target);
}

function fileDigest(path: string) {
  const digest = createHash("sha256");
  const fd = openSync(path, "r");
  let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(128 * 1024);
    for (let count = readSync(fd, buffer); count > 0; count = readSync(fd, buffer)) {
      digest.update(buffer.subarray(0, count));
      bytes += count;
    }
  } finally { closeSync(fd); }
  return { bytes, sha256: digest.digest("hex") };
}

function smallJson(root: string, name: "manifest.json" | "recovery.json") {
  const candidate = join(root, name);
  const stat = entry(candidate);
  const file = stat?.isFile() && stat.nlink === 1 ? candidate : undefined;
  if (!file || lstatSync(file).size > 8 * 1024 * 1024) throw new Error("备份清单缺失或超出大小限制");
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function blobFits(blob: BackupBlob, digest: { bytes: number; sha256: string }) {
  return blob.sha256 ? digest.bytes === blob.bytes && digest.sha256 === blob.sha256 : digest.bytes <= blob.bytes;
}

function syncParents(file: string, root: string) {
  for (let parent = dirname(file); parent !== root; parent = dirname(parent)) sync(parent);
}

function manifestAt(root: string, id: string) {
  const folder = directory(join(directory(join(root, "backups")), idSchema.parse(id)));
  const manifest = manifestSchema.parse(smallJson(folder, "manifest.json"));
  if (manifest.id !== id) throw new Error("备份编号与目录不符");
  return { directory: folder, manifest };
}

export function backupStatus(root: string) {
  const folder = join(root, "backups");
  const backups = entry(folder) ? readdirSync(directory(folder)).filter((name) => idSchema.safeParse(name).success)
    .sort().reverse().flatMap((id) => {
      try {
        const { manifest } = manifestAt(root, id);
        return [{ id, created_at: manifest.createdAt, kind: manifest.kind }];
      } catch { return []; }
    }) : [];
  return { backups, restore_pending: !!entry(join(root, recoveryDir)) };
}

export function hasPendingRestore(root: string) {
  return !!entry(join(root, recoveryDir));
}

export function createBackup(root: string, store: Store | undefined, kind: Manifest["kind"], clock: Clock = new SystemClock("backup")) {
  const base = directory(join(directory(root), "backups"), true);
  const createdAt = clockDate(clock).toISOString();
  const id = `cattt-${createdAt.replace(/[-:.]/g, "")}-${randomUUID()}`;
  const temporary = directory(join(base, `.${id}.incomplete`), true);
  try {
    const source = regular(root, databasePath);
    if (!source) throw new Error("没有可备份的 SQLite 数据库");
    const db = join(temporary, databasePath);
    snapshotDatabase(store?.raw ?? source, db);
    chmodSync(db, 0o600);
    sync(db);
    for (const name of paths) {
      const original = regular(root, name);
      if (original) {
        const target = located(temporary, name, true)!;
        copy(original, target);
        if (dirname(target) !== temporary) sync(dirname(target));
      }
    }
    const files = inventory.flatMap((path) => {
      const file = regular(temporary, path);
      return file ? [{ path, ...fileDigest(file) }] : [];
    });
    for (const blob of backupBlobs(db)) {
      const original = regular(root, blob.path);
      if (!original && !blob.sha256) continue; // A pending upload may be at offset zero.
      if (!original) throw new Error("缺少数据库已登记的本机附件");
      const target = located(temporary, blob.path, true)!;
      copy(original, target);
      syncParents(target, temporary);
      const digest = fileDigest(target);
      if (!blobFits(blob, digest)) throw new Error("本机附件大小或哈希不匹配");
      files.push({ path: blob.path, ...digest });
    }
    const manifest: Manifest = { format: 1, id, createdAt, kind, files, database: inspectDatabase(db) };
    const manifestPath = join(temporary, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    sync(manifestPath);
    sync(temporary);
    renameSync(temporary, join(base, id));
    sync(base);
    return { id, created_at: createdAt, kind };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function validateBackup(root: string, id: string) {
  const bundle = manifestAt(root, id);
  const seen = new Set<string>();
  for (const file of bundle.manifest.files) {
    if (seen.has(file.path)) throw new Error("备份清单包含重复文件");
    seen.add(file.path);
    const path = regular(bundle.directory, file.path);
    const digest = path && fileDigest(path);
    if (!digest || digest.sha256 !== file.sha256 || digest.bytes !== file.bytes) {
      throw new Error(`备份文件校验失败：${file.path}`);
    }
  }
  if (!seen.has(databasePath) || inventory.some((path) => !!regular(bundle.directory, path) !== seen.has(path))
    || ["-wal", "-shm", "-journal"].some((suffix) => entry(join(bundle.directory, databasePath + suffix)))) {
    throw new Error("备份文件与清单不符");
  }
  const database = join(bundle.directory, databasePath);
  const actual = inspectDatabase(database);
  const blobs = new Map(backupBlobs(database).map((blob) => [blob.path, blob]));
  for (const file of bundle.manifest.files.filter(({ path }) => blobPath.test(path))) {
    const blob = blobs.get(file.path);
    if (!blob || !blobFits(blob, file)) throw new Error("附件与 SQLite 快照不一致");
  }
  if (Array.from(blobs.values()).some((blob) => blob.sha256 && !seen.has(blob.path))) {
    throw new Error("备份缺少数据库已验证的附件");
  }
  const declared = bundle.manifest.database;
  if (actual.hostId !== declared.hostId || actual.householdId !== declared.householdId
    || actual.generation !== declared.generation || actual.seq !== declared.seq || actual.migration !== declared.migration) {
    throw new Error("备份数据库版本、身份或水位与清单不符");
  }
  return bundle;
}

function install(root: string, source: string, blobs: readonly string[]) {
  // The supervisor has stopped and reaped the sole writer. The durable
  // operation checkpoint includes all WAL commits before sidecars are removed.
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    rmSync(join(root, databasePath + suffix), { force: true });
  }
  for (const name of [...inventory, ...blobs]) {
    const original = regular(source, name);
    const target = located(root, name, !!original);
    if (!target) continue;
    regular(root, name); // Reject a linked destination before replacement/removal.
    if (original) {
      const staged = join(dirname(target), `.restore-${randomUUID()}`);
      try { copy(original, staged); renameSync(staged, target); }
      finally { rmSync(staged, { force: true }); }
    } else {
      rmSync(target, { force: true });
    }
    syncParents(target, root);
  }
  sync(root);
}

export function prepareRestore(root: string, selectedId: string) {
  idSchema.parse(selectedId);
  if (hasPendingRestore(root)) throw new Error("上次恢复尚未收尾");
  const recovery = createBackup(root, undefined, "pre_restore");
  const current = validateBackup(root, recovery.id);
  const selected = validateBackup(root, selectedId);
  const liveDb = join(current.directory, databasePath);
  const backupDb = join(selected.directory, databasePath);
  const database = chooseRestoreDatabase(liveDb, backupDb, current.manifest.database, selected.manifest.database);
  const pending = join(root, recoveryDir);
  const preparing = directory(join(root, `.restore-${randomUUID()}`), true);
  try {
    const stage = directory(join(preparing, "files"), true);
    copy(database === "snapshot" ? backupDb : liveDb, join(stage, databasePath));

    const currentCA = current.manifest.files.find(({ path }) => path === "tls/ca.crt");
    const selectedCA = selected.manifest.files.find(({ path }) => path === "tls/ca.crt");
    if (currentCA && currentCA.sha256 !== selectedCA?.sha256) {
      throw new Error("备份与本机手机信任的 CA 不同");
    }
    for (const name of paths) {
      // Admin and peer rotations are local security changes. Keep the
      // current credentials, using the selected bundle to repair missing files.
      const preserve = name === "host-admin.token" || name === "peer-tls/identity.json";
      const source = (preserve ? regular(current.directory, name) : undefined) ?? regular(selected.directory, name);
      if (source) {
        const target = located(stage, name, true)!;
        copy(source, target);
        syncParents(target, stage);
      }
    }
    // Completed content is immutable and hash-addressed. Always preserve
    // newer local upload offsets, even when no SQLite row has changed.
    const blobs = current.manifest.files.filter(({ path }) => blobPath.test(path));
    for (const { path } of blobs) {
      const target = located(stage, path, true)!;
      copy(regular(current.directory, path)!, target);
      syncParents(target, stage);
    }
    const generation = fenceRestoredDatabase(join(stage, databasePath), current.manifest.database.hostId);
    sync(join(stage, databasePath));
    inspectDatabase(join(stage, databasePath));
    const record = join(preparing, "recovery.json");
    writeFileSync(record, JSON.stringify({ recoveryId: recovery.id, selectedId }), { mode: 0o600, flag: "wx" });
    sync(record);
    sync(stage);
    sync(preparing);
    renameSync(preparing, pending);
    sync(root);
    install(root, join(pending, "files"), blobs.map(({ path }) => path));
    return { recovery_id: recovery.id, generation, database };
  } finally { rmSync(preparing, { recursive: true, force: true }); }
}

export function rollbackRestore(root: string) {
  const pending = pendingSchema.parse(smallJson(directory(join(root, recoveryDir)), "recovery.json"));
  const backup = validateBackup(root, pending.recoveryId);
  if (backup.manifest.kind !== "pre_restore") throw new Error("缺少操作前备份");
  install(root, backup.directory, backup.manifest.files.filter(({ path }) => blobPath.test(path)).map(({ path }) => path));
  return { recovery_id: pending.recoveryId };
}

export function finishRestore(root: string) {
  const pending = directory(join(root, recoveryDir));
  const finished = join(root, `.restore-finished-${randomUUID()}`);
  renameSync(pending, finished);
  sync(root);
  try { rmSync(finished, { recursive: true }); } catch { /* The restore is already committed. */ }
}
