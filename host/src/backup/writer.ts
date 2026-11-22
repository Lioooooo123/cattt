import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const writerFile = "bun-writer.pid";

function alreadyExited(pid: number) {
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  return false;
}

/**
 * Swift serializes supervisors. Bun also leaves an ownership record until its
 * process stops, since the Swift flock can be released first when Swift is killed.
 */
export function claimWriter(root: string): () => void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, writerFile);
  const staged = join(root, `.bun-writer-${randomUUID()}`);
  writeFileSync(staged, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    try { linkSync(staged, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 16) throw new Error("Bun 数据库进程记录无效");
      const text = readFileSync(path, "utf8");
      const pid = Number(text);
      if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(pid) || !alreadyExited(pid)) {
        throw new Error("上一 Bun 进程仍持有数据库，请等宿主完全停止再恢复");
      }
      // Supervisors hold host.lock during this stale record cleanup.
      unlinkSync(path);
      linkSync(staged, path);
    }
  } finally { unlinkSync(staged); }
  return () => { if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path); };
}
