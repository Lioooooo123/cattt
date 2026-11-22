import "reflect-metadata";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { finishRestore, hasPendingRestore, prepareRestore, rollbackRestore } from "./backup/index.ts";
import { claimWriter } from "./backup/writer.ts";
import { Gateway } from "./gateway/index.ts";
import { startConfiguredHost } from "./runtime/application.ts";
import { configFromEnv } from "./runtime/config.ts";
import { inspectDatabase } from "./store/backup.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const supervised = args.includes("--supervised");
  const restoreCheck = args.includes("--restore-check");
  const dataDir = process.env.CATTT_DATA_DIR;
  if (args[0] === "--restore-command" && dataDir && dataDir.startsWith("/")) {
    // Offline entrypoint of the Swift supervisor, which holds the data lock.
    if (args[1] === "finish" && args.length === 2) {
      finishRestore(dataDir);
      console.log(JSON.stringify({ ok: true }));
      return;
    }
    if (!(args[1] === "prepare" && args.length === 3) && !(args[1] === "rollback" && args.length === 2)) {
      throw new Error("无效的恢复命令");
    }
    const release = claimWriter(dataDir);
    try {
      const result = args[1] === "prepare" ? prepareRestore(dataDir, args[2]!) : rollbackRestore(dataDir);
      console.log(JSON.stringify(result));
    } finally { release(); }
    return;
  }
  if ((restoreCheck && !supervised) || args.some((arg) => arg !== "--supervised" && arg !== "--restore-check")) {
    throw new Error("无效的宿主启动参数");
  }
  const config = configFromEnv(process.env);
  const releaseWriter = claimWriter(config.dataDir);
  process.on("exit", releaseWriter);
  const pendingRestore = hasPendingRestore(config.dataDir);
  if (pendingRestore !== restoreCheck) throw new Error("恢复状态不符，请通过 Mac 监督器继续");
  if (restoreCheck) {
    inspectDatabase(join(config.dataDir, "cattt.db"));
    const ca = new X509Certificate(readFileSync(join(config.dataDir, "tls", "ca.crt")));
    const key = createPrivateKey(readFileSync(join(config.dataDir, "tls", "ca.key")));
    if (!ca.checkPrivateKey(key)) throw new Error("本机 CA 证书与私钥不匹配");
  }

  let available = false;
  let host: Awaited<ReturnType<typeof startConfiguredHost>> | undefined;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    available = false;
    if (!host) process.exit(0); // Startup is still gated.
    void host.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  let beforeBusiness: (() => Promise<void>) | undefined;
  if (supervised) {
    const control = createInterface({ input: process.stdin, terminal: false });
    control.once("close", shutdown);
    if (restoreCheck) {
      const release = Promise.withResolvers<void>();
      control.once("line", (line) => {
        if (line !== "activate" || hasPendingRestore(config.dataDir)) { shutdown(); return; }
        release.resolve();
      });
      beforeBusiness = () => release.promise;
    }
  }

  const gateway = new Gateway();
  host = await startConfiguredHost({ ...config, accessPaused: () => !available, beforeBusiness }, gateway);
  available = true;
  gateway.activatePeer();
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "import-pg") {
    const [{ importPg }, { ImportError }] = await Promise.all([
      import("./import-pg/index.ts"), import("./import-pg/snapshot.ts"),
    ]);
    try {
      const report = await importPg(args.slice(1), process.env);
      if (report) console.log(JSON.stringify(report, null, 2));
    } catch (error) {
      console.error("导入失败", error instanceof ImportError ? error.message : "SQLite 写入或文件操作失败");
      process.exitCode = 1;
    }
    return;
  }
  await main();
}

void run().catch((error: unknown) => {
  const message = error instanceof Error && error.name !== "ZodError" && !(error instanceof SyntaxError)
    ? error.message : "配置或备份清单无效";
  if (process.argv[2] === "--restore-command") {
    process.stdout.write(JSON.stringify({ error: message }) + "\n", () => process.exit(1));
  } else {
    console.error("宿主操作失败", message);
    process.exit(1);
  }
});
