import { z } from "zod";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 1024 * 1024;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const fileNameSchema = z.string().trim().min(1).max(255)
  .refine((name) => !/[\p{Cc}\p{Cs}\/\\]/u.test(name));
export const fileMediaTypeSchema = z.string().max(100).regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/);
export const fileDescriptionTextSchema = z.string().trim().min(1).max(2000);
export const fileDescriptionModelSchema = z.string().trim().min(1).max(255);

export interface BlobIdentity {
  sha256: string;
  byteSize: number;
}

export interface FileManifest extends BlobIdentity {
  conversationId: string;
  fileName: string;
  mediaType: string;
  description: string | null;
  sourceMessageId: string | null;
  sourceMessageRev: number | null;
}

export interface FileSourcePointer {
  fileId: string;
  fileRev: number;
}

export class FileRequestError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 413 | 415 | 422,
    readonly code: string,
    readonly offset?: number,
  ) {
    super(code);
  }
}
