import { join } from "node:path";
import { BlobStaging } from "../files/blobs.ts";
import type { BlobStorage } from "../files/blobs.ts";
import { blobResponse } from "../files/range.ts";
import { MAX_CHUNK_BYTES, SHA256_PATTERN } from "../files/types.ts";
import type { BlobIdentity } from "../files/types.ts";
import type { PeerActor, PeerTransport } from "../peer/index.ts";
import type { HostContext } from "../runtime/index.ts";
import {
  findCurrentFileByHash, findFileBlob, getCurrentFileSource, isActiveFileHost, listCurrentFilesFromPeer, recordFileBlob,
} from "../store/files.ts";
import type { FileRow } from "../store/files.ts";
import type { PeerRecord } from "../store/peers.ts";

const FILES_PER_SCAN = 32;
const TRANSFERS_PER_SCAN = 4;

export function peerBlobHandler(ctx: HostContext, storage: BlobStorage) {
  return (request: Request, actor: PeerActor): Response => {
    const { db } = ctx.store;
    const sha256 = new URL(request.url).pathname.split("/").at(-1)!;
    if (!SHA256_PATTERN.test(sha256)) {
      return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
    }
    if (actor.householdId !== ctx.householdId
      || !isActiveFileHost(db, actor.householdId, actor.hostId)
      || !isActiveFileHost(db, actor.householdId, ctx.hostId)) {
      return Response.json({ error: { code: "peer_not_active" } }, { status: 403 });
    }
    const receipt = findFileBlob(db, sha256);
    const reference = receipt && findCurrentFileByHash(db, {
      householdId: actor.householdId, sha256, byteSize: receipt.byteSize,
    });
    const blob = reference && storage.localBlob(reference);
    if (!blob || !reference) {
      return Response.json({ error: { code: "blob_unavailable" } }, { status: 404 });
    }
    return blobResponse(request, blob, { sha256, byteSize: reference.byteSize, fileName: sha256 });
  };
}

async function readChunk(
  transport: PeerTransport, hostId: string, blob: BlobIdentity, start: number, end: number, signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const { sha256, byteSize } = blob;
  const length = end - start + 1;
  const etag = `"${sha256}"`;
  try {
    const reply = await transport.request(hostId, "blob", {
      sha256, signal, headers: { range: `bytes=${start}-${end}`, "if-range": etag },
    });
    if (reply.status !== 206 || reply.headers.get("etag") !== etag
      || reply.headers.get("content-range") !== `bytes ${start}-${end}/${byteSize}`
      || reply.headers.get("content-length") !== String(length) || !reply.body) {
      await reply.body?.cancel();
      return undefined;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for await (const chunk of reply.body) {
      signal.throwIfAborted();
      if (offset + chunk.byteLength > length) {
        return undefined;
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return offset === length && !signal.aborted ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export function createPeerBlobPull(ctx: HostContext, storage: BlobStorage, transport: PeerTransport) {
  const { db } = ctx.store;
  const inFlight = new Set<string>();

  function availableLocally(file: FileRow): boolean {
    return findFileBlob(db, file.sha256)?.byteSize === file.byteSize && storage.localPath(file) !== undefined;
  }

  async function download(peer: PeerRecord, file: FileRow, stage: BlobStaging, signal: AbortSignal) {
    const { sha256, byteSize } = file;
    const stillCurrent = (reader: Parameters<typeof getCurrentFileSource>[0]) => {
      const current = getCurrentFileSource(reader, { fileId: file.id, fileRev: file.rev });
      return current?.sha256 === sha256 && current.byteSize === byteSize && current.originHostId === peer.hostId
        && current.householdId === peer.householdId;
    };
    const mayInstall = () => !signal.aborted && stillCurrent(db);
    let offset = stage.offset(sha256);
    if (offset > byteSize) {
      stage.discard(sha256);
      offset = 0;
    }
    if (offset === byteSize && !await readChunk(transport, peer.hostId, file, 0, 0, signal)) {
      // A previous run may have stopped after its last chunk. Reauthorize with the source.
      return;
    }
    while (offset < byteSize && mayInstall()) {
      const end = Math.min(byteSize, offset + MAX_CHUNK_BYTES) - 1;
      const bytes = await readChunk(transport, peer.hostId, file, offset, end, signal);
      if (!bytes || !mayInstall()) {
        return;
      }
      stage.append(sha256, bytes);
      offset += bytes.byteLength;
    }
    if (offset !== byteSize || !mayInstall()) {
      return;
    }
    const verified = await storage.installVerified(stage.path(sha256), file, mayInstall);
    if (verified && !signal.aborted) {
      db.transaction((tx) => {
        if (stillCurrent(tx)) {
          recordFileBlob(tx, verified, ctx.clock.wallMs());
        }
      }, { behavior: "immediate" });
    }
    // Keep completed staging across shutdown. On checksum failure, retry from zero.
    if (!signal.aborted) {
      stage.discard(sha256);
    }
  }

  return {
    async pull(peer: PeerRecord, after: string, shutdown: AbortSignal): Promise<string> {
      if (shutdown.aborted || inFlight.has(peer.hostId)) {
        return after;
      }
      inFlight.add(peer.hostId);
      try {
        const signal = AbortSignal.any([shutdown, AbortSignal.timeout(10_000)]);
        const stage = new BlobStaging(join(ctx.config.dataDir, "blobs", "peer-downloads", peer.hostId));
        for (const sha256 of stage.keys()) {
          if (!SHA256_PATTERN.test(sha256)) continue;
          const reference = findCurrentFileByHash(db, { householdId: peer.householdId, originHostId: peer.hostId, sha256 });
          if (!reference || availableLocally(reference)) {
            stage.discard(sha256);
          }
        }

        const candidates = listCurrentFilesFromPeer(db, peer.householdId, peer.hostId, after, FILES_PER_SCAN);
        const attempted = new Set<string>();
        for (const file of candidates) {
          if (signal.aborted || attempted.size >= TRANSFERS_PER_SCAN) {
            return after;
          }
          after = file.id;
          if (attempted.has(file.sha256) || availableLocally(file)) {
            continue;
          }
          attempted.add(file.sha256);
          await download(peer, file, stage, signal);
        }
        return candidates.length === FILES_PER_SCAN ? after : "";
      } finally {
        inFlight.delete(peer.hostId);
      }
    },
  };
}
