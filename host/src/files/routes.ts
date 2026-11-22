import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import type { Actor } from "../identity/index.ts";
import type { HostContext } from "../runtime/index.ts";
import { ConversationNotFoundError } from "../store/conversations.ts";
import {
  beginFileUpload, completeFileUpload, listFilesForActor,
  readFileForActor, readUploadForActor, withdrawFile,
} from "../store/files.ts";
import type { FileRow, UploadRow } from "../store/files.ts";
import { isActiveDeviceActor } from "../store/identity.ts";
import { writeTransaction } from "../store/index.ts";
import type { BlobStorage } from "./blobs.ts";
import { FileDescriptions } from "./descriptions.ts";
import { availableFilePath, projectFile } from "./projections.ts";
import { blobResponse } from "./range.ts";
import { Thumbnails } from "./thumbnails.ts";
import {
  fileMediaTypeSchema, fileNameSchema, FileRequestError, MAX_CHUNK_BYTES, MAX_FILE_BYTES, SHA256_PATTERN,
} from "./types.ts";

const manifestSchema = z.object({
  client_upload_id: z.uuid(),
  conversation_id: z.uuid(),
  sha256: z.string().regex(SHA256_PATTERN),
  byte_size: z.number().int().min(1),
  file_name: fileNameSchema,
  media_type: fileMediaTypeSchema,
  description: z.string().trim().max(2000).optional(),
  source_message_id: z.uuid().optional(),
  source_message_rev: z.number().int().min(1).optional(),
}).strict().refine((body) => (body.source_message_id === undefined) === (body.source_message_rev === undefined));

const listSchema = z.object({
  conversation_id: z.uuid(),
  after: z.uuid().optional(),
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(100)).optional(),
}).strict();

const descriptionRequest = z.object({ file_rev: z.number().int().positive() }).strict();

function requireId(value: string) {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new FileRequestError(400, "invalid_request");
  }
  return result.data;
}

async function boundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > limit) {
    throw new FileRequestError(413, "payload_too_large");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (request.body) {
      for await (const chunk of request.body) {
        size += chunk.byteLength;
        if (size > limit) {
          throw new FileRequestError(413, "payload_too_large");
        }
        chunks.push(chunk);
      }
    }
  } catch (error) {
    if (error instanceof FileRequestError) {
      throw error;
    }
    throw new FileRequestError(400, "incomplete_body");
  }
  if (request.signal.aborted || (length !== null && Number(length) !== size)) {
    throw new FileRequestError(400, "incomplete_body");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function fileRoutes(ctx: HostContext, shutdown: AbortSignal, storage: BlobStorage) {
  const app = new Hono<IdentityEnv>();
  const root = join(ctx.config.dataDir, "blobs");
  const thumbnails = new Thumbnails(join(root, "thumbnails"));
  const descriptions = new FileDescriptions(ctx, storage, shutdown);
  const db = ctx.store.db;
  const completing = new Set<string>();
  const assertActive = (actor: Actor) => {
    if (!isActiveDeviceActor(db, actor)) {
      throw new FileRequestError(401, "unauthorized");
    }
  };

  const availablePath = (file: FileRow) => availableFilePath(db, storage, file);
  const fileDto = (file: FileRow) => projectFile(db, storage, file);

  function uploadDto(upload: UploadRow, file?: FileRow) {
    return {
      id: upload.id, offset: file ? upload.byteSize : storage.offset(upload.id),
      byte_size: upload.byteSize, file_id: file?.id ?? null,
    };
  }

  function pendingOffset(actor: Actor, id: string, offset: number) {
    const { upload, file } = readUploadForActor(db, actor, id);
    const current = file ? upload.byteSize : storage.offset(id);
    if (completing.has(id)) {
      throw new FileRequestError(409, "upload_busy", current);
    }
    if (file || current !== offset) {
      throw new FileRequestError(409, "offset_mismatch", current);
    }
    return upload.byteSize - current;
  }

  app.use("*", async (c, next) => {
    c.header("cache-control", "private, no-store");
    await next();
  });
  app.use("*", requireActor(ctx));
  app.onError((error, c) => {
    if (error instanceof FileRequestError) {
      return c.json({
        error: { code: error.code, ...(error.offset === undefined ? {} : { offset: error.offset }) },
      }, error.status);
    }
    if (error instanceof ConversationNotFoundError) {
      return c.json({ error: { code: "not_found" } }, 404);
    }
    throw error;
  });

  app.get("/", (c) => {
    const query = listSchema.safeParse(c.req.query());
    if (!query.success) {
      throw new FileRequestError(400, "invalid_request");
    }
    const { conversation_id, after, limit = 50 } = query.data;
    const rows = listFilesForActor(db, c.get("actor"), conversation_id, after, limit + 1);
    const page = rows.slice(0, limit);
    return c.json({ files: page.map(fileDto), next_after: rows.length > limit ? page.at(-1)!.id : null });
  });

  app.post("/uploads", async (c) => {
    const bytes = await boundedBody(c.req.raw, 8192);
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new FileRequestError(400, "invalid_request");
    }
    const body = manifestSchema.safeParse(input);
    if (!body.success) {
      throw new FileRequestError(400, "invalid_request");
    }
    const manifest = body.data;
    if (manifest.byte_size > MAX_FILE_BYTES) {
      throw new FileRequestError(413, "payload_too_large");
    }
    const actor = c.get("actor");
    const result = writeTransaction(ctx.store, (tx) => {
      assertActive(actor);
      return beginFileUpload(tx, ctx.clock, actor, manifest.client_upload_id, {
        sha256: manifest.sha256, byteSize: manifest.byte_size,
        conversationId: manifest.conversation_id, fileName: manifest.file_name, mediaType: manifest.media_type,
        description: manifest.description ?? null,
        sourceMessageId: manifest.source_message_id ?? null, sourceMessageRev: manifest.source_message_rev ?? null,
      });
    });
    return c.json(uploadDto(result.upload, result.file), result.created ? 201 : 200);
  });

  app.get("/uploads/:id", (c) => {
    const { upload, file } = readUploadForActor(db, c.get("actor"), requireId(c.req.param("id")));
    return c.json(uploadDto(upload, file));
  });

  app.patch("/uploads/:id", async (c) => {
    const id = requireId(c.req.param("id"));
    const actor = c.get("actor");
    const offsetText = c.req.header("upload-offset") ?? "";
    const offset = Number(offsetText);
    if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset)) {
      throw new FileRequestError(400, "invalid_request");
    }
    if (c.req.header("content-type")?.toLowerCase() !== "application/octet-stream") {
      throw new FileRequestError(415, "unsupported_media_type");
    }
    const remaining = pendingOffset(actor, id, offset);
    const bytes = await boundedBody(c.req.raw, Math.min(remaining, MAX_CHUNK_BYTES));
    if (bytes.byteLength === 0) {
      throw new FileRequestError(400, "invalid_request");
    }
    assertActive(actor);
    pendingOffset(actor, id, offset);
    // No await between the offset check and the append in the single host process.
    storage.append(id, bytes);
    return c.json({ id, offset: offset + bytes.byteLength, byte_size: offset + remaining, file_id: null });
  });

  app.post("/uploads/:id/complete", async (c) => {
    const id = requireId(c.req.param("id"));
    const actor = c.get("actor");
    const { upload, file } = readUploadForActor(db, actor, id);
    if (file) {
      storage.discard(id);
      return c.json({ file: fileDto(file) });
    }
    const offset = storage.offset(id);
    if (completing.has(id)) {
      throw new FileRequestError(409, "upload_busy", offset);
    }
    if (offset !== upload.byteSize) {
      throw new FileRequestError(409, "upload_incomplete", offset);
    }
    completing.add(id);
    try {
      const verified = await storage.installUpload(id, upload);
      assertActive(actor);
      if (!verified) {
        storage.discard(id);
        throw new FileRequestError(422, "checksum_mismatch", 0);
      }
      const result = db.transaction((tx) => completeFileUpload(tx, ctx.clock, actor, id, verified), { behavior: "immediate" });
      storage.discard(id);
      return c.json({ file: fileDto(result.file) }, result.created ? 201 : 200);
    } finally {
      completing.delete(id);
    }
  });

  app.get("/:id", (c) => {
    return c.json({ file: fileDto(readFileForActor(db, c.get("actor"), requireId(c.req.param("id")))) });
  });

  app.delete("/:id", (c) => {
    const id = requireId(c.req.param("id"));
    db.transaction((tx) => withdrawFile(tx, ctx.clock, c.get("actor"), id), { behavior: "immediate" });
    return c.body(null, 204);
  });

  app.get("/:id/description", (c) => {
    return c.json(descriptions.read(c.get("actor"), requireId(c.req.param("id"))));
  });

  app.post("/:id/description", async (c) => {
    const id = requireId(c.req.param("id"));
    const bytes = await boundedBody(c.req.raw, 1024);
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new FileRequestError(400, "invalid_request");
    }
    const parsed = descriptionRequest.safeParse(input);
    if (!parsed.success) {
      throw new FileRequestError(400, "invalid_request");
    }
    return c.json(await descriptions.generate(c.get("actor"), id, parsed.data.file_rev));
  });

  app.get("/:id/content", (c) => {
    const file = readFileForActor(db, c.get("actor"), requireId(c.req.param("id")));
    const path = availablePath(file);
    if (!path) {
      throw new FileRequestError(404, "blob_unavailable");
    }
    return blobResponse(c.req.raw, Bun.file(path), file);
  });

  app.get("/:id/thumbnail", async (c) => {
    const id = requireId(c.req.param("id"));
    const actor = c.get("actor");
    const file = readFileForActor(db, actor, id);
    if (!thumbnails.supports(file.mediaType)) {
      throw new FileRequestError(415, "thumbnail_unsupported");
    }
    const path = availablePath(file);
    if (!path) {
      throw new FileRequestError(404, "blob_unavailable");
    }
    const thumbnail = await thumbnails.get(file.sha256, path, file.mediaType);
    assertActive(actor);
    const current = readFileForActor(db, actor, id);
    if (current.rev !== file.rev || !availablePath(current)) {
      throw new FileRequestError(404, "thumbnail_unavailable");
    }
    if (!thumbnail) {
      throw new FileRequestError(422, "thumbnail_failed");
    }
    return c.body(thumbnail.stream(), 200, { "content-type": "image/jpeg", "x-content-type-options": "nosniff" });
  });
  return app;
}
