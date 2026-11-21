import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../bus/index.ts";
import { SystemClock } from "../clock/index.ts";
import type { Clock } from "../clock/index.ts";
import { uuidv7 } from "../ids/index.ts";
import { getHostMeta, setHostMeta } from "../store/host-meta.ts";
import { openStore, writeTransaction } from "../store/index.ts";
import type { Store } from "../store/index.ts";
import { ensureHousehold } from "../store/identity.ts";
import { reconcileConversations } from "../store/conversation-lifecycle.ts";
import { DEFAULT_HOST_NAME, DEFAULT_HOUSEHOLD_NAME, DEFAULT_MAX_MEMBERS } from "./config.ts";

export interface HostEvents {
  "host:ready": { hostId: string };
  "jobs:wake": { queue: string };
  "chat:event": { streamId: string; seq: number };
  "lease:acquired": { name: string; holder: string; epoch: number };
  "lease:lost": { name: string; holder: string; epoch: number };
}

export interface HostConfig {
  dataDir: string;
  port?: number;
  lanHttpsPort?: number;
  hostname?: string;
  clock?: Clock;
  householdName?: string;
  hostName?: string;
  maxMembers?: number;
  onError?: (error: unknown, source: string) => void | Promise<void>;
}

export interface HostContext {
  store: Store;
  bus: EventBus<HostEvents>;
  clock: Clock;
  hostId: string;
  householdId: string;
  config: HostConfig;
}

export interface Component {
  name: string;
  start(ctx: HostContext): void | Promise<void>;
  stop(): void | Promise<void>;
}

export async function startHost(config: HostConfig, components: readonly Component[]) {
  const report = (error: unknown, source: string): void => {
    try {
      const result = config.onError
        ? config.onError(error, source)
        : console.error(`宿主错误：${source}`, error);
      Promise.resolve(result).catch(() => {});
    } catch {}
  };

  mkdirSync(config.dataDir, { recursive: true });
  const store = openStore(join(config.dataDir, "cattt.db"));
  const started: Component[] = [];
  let stopping: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    stopping ??= Promise.resolve().then(async () => {
      for (const component of [...started].reverse()) {
        try {
          await component.stop();
        } catch (error) {
          report(error, `stop:${component.name}`);
        }
      }
      try {
        store.close();
      } catch (error) {
        report(error, "store:close");
      }
    });
    return stopping;
  };

  try {
    const initialClock = config.clock ?? new SystemClock("bootstrap");
    const hostId = writeTransaction(store, (db) => {
      const existing = getHostMeta(db, "host_id");
      if (existing !== undefined) {
        return existing;
      }
      const id = uuidv7(initialClock);
      setHostMeta(db, "host_id", id);
      return id;
    });
    const clock = config.clock ?? new SystemClock(hostId);
    const maxMembers = config.maxMembers ?? DEFAULT_MAX_MEMBERS;
    if (!Number.isSafeInteger(maxMembers) || maxMembers < 1) {
      throw new RangeError("成员上限必须是正整数");
    }
    const householdName = config.householdName ?? DEFAULT_HOUSEHOLD_NAME;
    const hostName = config.hostName ?? DEFAULT_HOST_NAME;
    const householdId = ensureHousehold(store.db, clock, hostId, { householdName, hostName });
    reconcileConversations(store.db, clock, hostId, householdId);
    const ctx: HostContext = {
      store,
      bus: new EventBus((error, topic) => report(error, `bus:${topic}`)),
      clock,
      hostId,
      householdId,
      config: { ...config, householdName, hostName, maxMembers },
    };
    for (const component of components) {
      await component.start(ctx);
      started.push(component);
    }
    ctx.bus.publish("host:ready", { hostId });
    return { ...ctx, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
