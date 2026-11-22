import { createLocalVision } from "../llm/local-vision.ts";
import type { VisionMediaType } from "../llm/local-vision.ts";
import type { Actor } from "../identity/index.ts";
import type { HostContext } from "../runtime/index.ts";
import {
  assertSameDescriptionSource, readFileDescriptionForActor, saveFileDescription,
} from "../store/file-descriptions.ts";
import type { FileDescription } from "../store/file-descriptions.ts";
import type { FileRow } from "../store/files.ts";
import type { BlobStorage } from "./blobs.ts";
import { availableFilePath, projectFileDescription } from "./projections.ts";
import { FileRequestError } from "./types.ts";

type PendingStatus = "not_generated" | "blob_unavailable" | "model_unavailable";

function ready(row: FileDescription) {
  return {
    status: "ready" as const,
    description: projectFileDescription(row),
  };
}

function requireImageType(file: FileRow): VisionMediaType {
  if (file.mediaType === "image/png" || file.mediaType === "image/jpeg" || file.mediaType === "image/webp") {
    return file.mediaType;
  }
  throw new FileRequestError(415, "description_unsupported");
}

function matchesImageType(bytes: Uint8Array, mediaType: VisionMediaType): boolean {
  const header = Buffer.from(bytes.subarray(0, 12));
  switch (mediaType) {
    case "image/png": return header.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
    case "image/jpeg": return header.subarray(0, 3).toString("hex") === "ffd8ff";
    case "image/webp": return header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP";
  }
}

export class FileDescriptions {
  private readonly vision: ReturnType<typeof createLocalVision>;
  private readonly pending = new Map<string, Promise<"blob_unavailable" | "model_unavailable" | "ready">>();

  constructor(private readonly ctx: HostContext, private readonly storage: BlobStorage, private readonly shutdown: AbortSignal) {
    this.vision = createLocalVision(ctx.config.localVision);
  }

  read(actor: Actor, id: string) {
    const { file, description } = readFileDescriptionForActor(this.ctx.store.db, actor, id);
    if (description) {
      return ready(description);
    }
    requireImageType(file);
    const status: PendingStatus = !this.hasLocalFile(file) ? "blob_unavailable"
      : !this.vision ? "model_unavailable" : "not_generated";
    return { status };
  }

  async generate(actor: Actor, id: string, rev: number) {
    const db = this.ctx.store.db;
    const { file, description } = readFileDescriptionForActor(db, actor, id, rev);
    if (description) {
      return ready(description);
    }
    const mediaType = requireImageType(file);
    if (!this.hasLocalFile(file)) {
      return { status: "blob_unavailable" as const };
    }
    if (file.originHostId !== this.ctx.hostId) {
      throw new FileRequestError(409, "not_writer");
    }
    if (!this.vision) {
      return { status: "model_unavailable" as const };
    }
    const key = `${id}:${rev}`;
    let work = this.pending.get(key);
    if (!work) {
      work = this.compute(actor, file, mediaType, this.vision).finally(() => this.pending.delete(key));
      this.pending.set(key, work);
    }
    const status = await work;
    this.shutdown.throwIfAborted();
    const current = readFileDescriptionForActor(db, actor, id, rev);
    assertSameDescriptionSource(current.file, file);
    if (current.description) {
      return ready(current.description);
    }
    if (status === "ready") {
      throw new FileRequestError(409, "file_revision_changed");
    }
    return { status };
  }

  private hasLocalFile(file: FileRow) {
    return availableFilePath(this.ctx.store.db, this.storage, file) !== undefined;
  }

  private async compute(actor: Actor, file: FileRow, mediaType: VisionMediaType, vision: NonNullable<typeof this.vision>) {
    const bytes = await this.storage.readVerifiedBytes(file);
    this.shutdown.throwIfAborted();
    const current = readFileDescriptionForActor(this.ctx.store.db, actor, file.id, file.rev);
    assertSameDescriptionSource(current.file, file);
    if (current.description) {
      return "ready";
    }
    if (!bytes) {
      return "blob_unavailable";
    }
    if (!matchesImageType(bytes, mediaType)) {
      throw new FileRequestError(415, "description_unsupported");
    }
    const text = await vision.describe(bytes, mediaType, this.shutdown);
    this.shutdown.throwIfAborted();
    if (!text) {
      return "model_unavailable";
    }
    const saved = this.ctx.store.db.transaction((tx) => saveFileDescription(tx, this.ctx.clock, actor, file, vision.modelId, text), {
      behavior: "immediate",
    });
    if (!saved) {
      throw new FileRequestError(409, "file_revision_changed");
    }
    return "ready";
  }
}
