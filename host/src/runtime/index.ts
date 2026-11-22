import { resetWorldSessions } from "../store/world.ts";
import { restoreArchivedWorld } from "../store/world-state.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../bus/index.ts";
import { SystemClock } from "../clock/index.ts";
import type { Clock } from "../clock/index.ts";
import { PublicationWindow } from "../publication/window.ts";
import { uuidv7 } from "../ids/index.ts";
import { getHostMeta, setHostMeta } from "../store/host-meta.ts";
import { openStore, writeTransaction } from "../store/index.ts";
import type { Store } from "../store/index.ts";
import { backfillKnowledgeReplication, backfillTicketReplication } from "../store/replication.ts";
import { ensureHousehold } from "../store/identity.ts";
import { reconcileConversations } from "../store/conversation-lifecycle.ts";
import { DEFAULT_HOST_NAME, DEFAULT_HOUSEHOLD_NAME, DEFAULT_MAX_MEMBERS } from "./config.ts";
import type { Replier } from "../turns/types.ts";
import type { TicketAdmissionPolicy } from "../tickets/types.ts";
import type { GroupPublicationAuthority, PublicationPushAdapter } from "../router/types.ts";
import type { TicketWorkerContext } from "../ticket-workers/types.ts";
import type { AskOutcomeRule } from "../inference/rules.ts";
import type { RelayService } from "../relay/index.ts";
import type { ModelConfig } from "../llm/config.ts";
import { HostModelRuntime } from "./model.ts";
import type { DailyDiaryModel } from "../soul/diary-writer.ts";
import type { LocalVisionConfig } from "../llm/local-vision.ts";

export interface HostEvents {
  "host:ready": { hostId: string };
  "jobs:wake": { queue: string };
  "inference:wake": { sourceMessageId: string };
  "relay:wake": { id: string };
  "worker:report": { reportId: string };
  "chat:event": { streamId: string; seq: number };
  "turn:wake": { turnId: string };
  "lease:acquired": { name: string; holder: string; epoch: number };
  "lease:lost": { name: string; holder: string; epoch: number };
}

export interface HostConfig {
  dataDir: string;
  port?: number;
  lanHttpsPort?: number;
  peerHttpsPort?: number;
  hostname?: string;
  clock?: Clock;
  householdName?: string;
  hostName?: string;
  maxMembers?: number;
  replier?: Replier;
  model?: ModelConfig;
  dailyDiaryModel?: DailyDiaryModel;
  ticketAdmission?: TicketAdmissionPolicy;
  ticketWorkerContext?: TicketWorkerContext;
  askOutcomeRule?: AskOutcomeRule;
  groupPublicationAuthority?: GroupPublicationAuthority;
  apns?: import("../push/config.ts").ApnsConfig;
  publicationPush?: PublicationPushAdapter;
  relay?: RelayService;
  localVision?: LocalVisionConfig;
  accessPaused?: () => boolean;
  beforeBusiness?: () => Promise<void>;
  onError?: (error: unknown, source: string) => void | Promise<void>;
}

export interface HostContext {
  store: Store;
  models: HostModelRuntime;
  bus: EventBus<HostEvents>;
  clock: Clock;
  publication: PublicationWindow;
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
    store.db.transaction((tx) => {
      backfillTicketReplication(tx, hostId, householdId);
      backfillKnowledgeReplication(tx, hostId, householdId);
      resetWorldSessions(tx);
    }, { behavior: "immediate" });
    const core: Omit<HostContext, "models"> = {
      store,
      bus: new EventBus((error, topic) => report(error, `bus:${topic}`)),
      clock,
      publication: new PublicationWindow(clock),
      hostId,
      householdId,
      config: { ...config, householdName, hostName, maxMembers },
    };
    const ctx: HostContext = { ...core, models: new HostModelRuntime(core) };
    restoreArchivedWorld(ctx);
    for (const component of components) {
      await component.start(ctx);
      started.push(component);
    }
    ctx.bus.publish("host:ready", { hostId });
    return Object.assign(ctx, { stop });
  } catch (error) {
    await stop();
    throw error;
  }
}
