import type { BlobStorage } from "../files/blobs.ts";
import { memberSeatPeerHandler } from "../identity/member-seats.ts";
import { startPeerService } from "../peer/index.ts";
import { peerAccess } from "../peer/protocol.ts";
import type { PeerHandlers } from "../peer/protocol.ts";
import { createPublicationPeer } from "../publication/peer.ts";
import { PUBLICATION_PEER_VERSION } from "../publication/types.ts";
import { createPeerBlobPull, peerBlobHandler } from "../replication/peer-blobs.ts";
import { typedChangesHandler } from "../replication/peer-http.ts";
import { createPeerPullScheduler } from "../replication/peer-scheduler.ts";
import { peerWorldPresence } from "../world/presence.ts";
import type { HostContext } from "./index.ts";

type PeerHandlerOverrides = Pick<PeerHandlers, "changes" | "typedChanges" | "blob" | "inbox">;
type Options = Omit<Parameters<typeof startPeerService>[1], "configure"> & {
  storage: BlobStorage;
  handlers?: PeerHandlerOverrides;
};

export function startHostPeer(ctx: HostContext, { storage, handlers, ...options }: Options) {
  const handleChanges = handlers?.typedChanges ?? typedChangesHandler(ctx);
  const handleBlob = handlers?.blob ?? peerBlobHandler(ctx, storage);
  return startPeerService(ctx, {
    ...options,
    configure({ transport, protocol, fingerprint, compatiblePeers }) {
      const scheduler = createPeerPullScheduler(
        ctx, transport, compatiblePeers, createPeerBlobPull(ctx, storage, transport), options.report,
      );
      const publication = createPublicationPeer(ctx, transport, fingerprint,
        (version) => protocol.version >= PUBLICATION_PEER_VERSION && peerAccess(protocol, version) === "read_write",
        options.report);
      return {
        handlers: {
          ...handlers,
          typedChanges: handleChanges,
          blob: handleBlob,
          lease: protocol.version >= PUBLICATION_PEER_VERSION ? publication.receive : undefined,
          memberSeats: memberSeatPeerHandler(ctx, () => transport),
          worldPresence: (_request, actor) => peerWorldPresence(ctx, actor),
        },
        admin: publication.admin,
        syncStatus: scheduler.status,
        canRequest: (operation, peer) => operation !== "typedChanges" || !peer.pullPaused,
        onChange(change) {
          if (change.type === "identity_rotated") ctx.publication.clear();
          if (change.type === "identity_rotated" || change.type === "revoked") publication.refresh();
          scheduler.refresh(change.type === "paired" ? change.hostId : undefined);
          if (change.type === "paired" || change.type === "activated") publication.refresh();
        },
        async stop() {
          await Promise.all([publication.stop(), scheduler.stop()]);
        },
      };
    },
  });
}
