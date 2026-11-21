import { Gateway } from "./gateway/index.ts";
import { startHost } from "./runtime/index.ts";
import { configFromEnv } from "./runtime/config.ts";

async function main(): Promise<void> {
  const host = await startHost(configFromEnv(process.env), [new Gateway()]);
  const shutdown = () => {
    void host.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  console.error("宿主启动失败", error);
  process.exitCode = 1;
});
