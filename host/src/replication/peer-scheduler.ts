import type { HostContext } from "../runtime/index.ts";
import type { PeerTransport } from "../peer/index.ts";
import type { PeerRecord } from "../store/peers.ts";
import { getPeerCursor } from "../store/replication.ts";
import type { createPeerBlobPull } from "./peer-blobs.ts";
import { typedPeerTransport } from "./peer-http.ts";
import { createPeerPullClient } from "./peer-pull.ts";

const POLL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const FIRST_RETRY_MS = 2_000;

type ActiveStatus = "pending" | "pulling" | "caught_up" | "waiting" | "unavailable" | "upgrade_required" | "error";

interface PullState {
  binding: string;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  status: ActiveStatus;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  errorCode: string | null;
}

export function createPeerPullScheduler(
  ctx: HostContext, transport: PeerTransport, eligiblePeers: () => PeerRecord[],
  blobs: ReturnType<typeof createPeerBlobPull>, report: (error: unknown) => void,
) {
  const active = new Map<string, PullState>();
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  function cancel(hostId: string, state: PullState) {
    clearTimeout(state.timer);
    state.controller.abort();
    active.delete(hostId);
  }

  function launch(peer: PeerRecord, binding: string) {
    const controller = new AbortController();
    const state: PullState = {
      binding, controller, status: "pending", lastAttemptAt: null, lastSuccessAt: null, errorCode: null,
    };
    const client = createPeerPullClient(ctx.store.db, {
      sourceHostId: peer.hostId, householdId: peer.householdId,
    }, typedPeerTransport(transport, peer.hostId));
    active.set(peer.hostId, state);
    let backoffMs = FIRST_RETRY_MS;
    let afterFile = "";

    function schedule(delay: number) {
      state.timer = setTimeout(() => {
        const attempt = pull().finally(() => inFlight.delete(attempt));
        inFlight.add(attempt);
      }, delay);
    }

    async function pull() {
      if (controller.signal.aborted) return;
      state.status = "pulling";
      state.lastAttemptAt = ctx.clock.wallMs();
      const result = await client.pull(controller.signal);
      if (controller.signal.aborted) return;

      if (result.status !== "stopped" && result.status !== "waiting") {
        if (result.status === "caught_up") {
          try {
            afterFile = await blobs.pull(peer, afterFile, controller.signal);
          } catch (error) {
            report(error);
          }
          if (controller.signal.aborted) return;
        }
        state.status = result.status === "caught_up" ? "caught_up" : "pending";
        state.lastSuccessAt = ctx.clock.wallMs();
        state.errorCode = null;
        backoffMs = FIRST_RETRY_MS;
        schedule(result.status === "more" ? 0 : POLL_MS);
        return;
      }
      if (result.status === "waiting") {
        state.status = "waiting";
        state.errorCode = "missing_dependencies";
        backoffMs = FIRST_RETRY_MS;
        schedule(POLL_MS);
        return;
      }
      state.errorCode = result.code ?? result.reason;
      if (state.errorCode === "unsupported_protocol") {
        state.status = "upgrade_required";
        return;
      }
      state.status = result.reason === "retry_exhausted" ? "unavailable" : "error";
      schedule(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
    schedule(0);
  }

  return {
    refresh(reconfirmedHostId?: string) {
      if (stopped) return;
      const eligible = new Map(eligiblePeers().filter((peer) => !peer.pullPaused).map((peer) => [peer.hostId, peer]));
      for (const [hostId, peer] of eligible) {
        const binding = JSON.stringify([
          peer.householdId, peer.fingerprint, peer.confirmedLocalFingerprint,
          peer.protocolVersion, peer.addressHost, peer.addressPort,
        ]);
        const current = active.get(hostId);
        if (current?.binding === binding && !(hostId === reconfirmedHostId && current.status === "upgrade_required")) {
          continue;
        }
        if (current) cancel(hostId, current);
        launch(peer, binding);
      }
      for (const [hostId, state] of active) {
        if (!eligible.has(hostId)) cancel(hostId, state);
      }
    },

    status(peer: PeerRecord, paired: boolean, compatible: boolean) {
      const state = active.get(peer.hostId);
      const status = peer.revokedAt !== null ? "revoked" : !paired ? "unpaired"
        : peer.pullPaused ? "paused" : !compatible ? "upgrade_required" : state?.status ?? "pending";
      const cursor = getPeerCursor(ctx.store.db, peer.hostId);
      return {
        status,
        paused: peer.pullPaused,
        cursor: cursor && { source_host_id: cursor.sourceHostId, generation: cursor.generation, seq: cursor.seq },
        last_attempt_at: state?.lastAttemptAt ?? null,
        last_success_at: state?.lastSuccessAt ?? null,
        error_code: state?.errorCode ?? (status === "upgrade_required" ? "unsupported_protocol" : null),
      };
    },

    async stop() {
      stopped = true;
      for (const [hostId, state] of active) cancel(hostId, state);
      await Promise.all(inFlight);
    },
  };
}
