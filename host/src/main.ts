import "reflect-metadata";
import { ChatEventSweeper } from "./chat-events/index.ts";
import { Gateway } from "./gateway/index.ts";
import { startHost } from "./runtime/index.ts";
import { configFromEnv } from "./runtime/config.ts";
import { TurnRunner } from "./turns/index.ts";

async function main(): Promise<void> {
  const config = configFromEnv(process.env);
  const host = await startHost(config, [
    new ChatEventSweeper(), new TurnRunner(), new Gateway(),
  ]);
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
