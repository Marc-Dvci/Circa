import { randomUUID } from "node:crypto";
import type { IsolatedDocument } from "./isolate.js";

/**
 * Uploaded documents, in Amazon S3.
 *
 * A customer photographs a quote on the phone; the photo lands in the bucket
 * under `uploads/<user>/`, and the add-on reads it back by key. Two rules keep
 * one household's paperwork away from another's, and both are enforced here
 * rather than trusted to the caller:
 *
 * - **A key is read only under its owner's prefix.** The task role may read
 *   `uploads/*`, which is every household; the check that a key belongs to the
 *   user asking is this file's job, and a key naming another user is refused
 *   before a request is made.
 * - **Nothing is listed.** There is no `ListObjects` here and no
 *   `s3:ListBucket` in the stack, so a defect cannot walk the bucket.
 */

export const UPLOAD_PREFIX = "uploads/";

/** Textract's synchronous limit for a document passed as bytes. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type MediaType = IsolatedDocument["mediaType"];

const BY_EXTENSION: Record<string, MediaType> = {
  txt: "text/plain",
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

const EXTENSION: Record<MediaType, string> = {
  "text/plain": "txt",
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** The shape of the S3 client this adapter needs, so the adapter is testable without one. */
export interface S3Like {
  send(command: unknown): Promise<{
    Body?: { transformToByteArray(): Promise<Uint8Array> };
    ContentType?: string;
    ContentLength?: number;
  }>;
}

export interface S3CommandFactory {
  getObject(input: { Bucket: string; Key: string }): unknown;
  putObject(input: { Bucket: string; Key: string; Body: Uint8Array; ContentType: string }): unknown;
}

export interface UploadedDocument {
  key: string;
  bytes: Uint8Array;
  mediaType: MediaType;
}

export function mediaTypeFor(key: string, contentType?: string): MediaType {
  const declared = contentType?.split(";")[0]?.trim().toLowerCase();
  if (declared && declared in EXTENSION) return declared as MediaType;
  const ext = key.split(".").at(-1)?.toLowerCase() ?? "";
  const byExt = BY_EXTENSION[ext];
  if (byExt) return byExt;
  throw new Error("that upload is not a photo, a PDF or a text file, so I cannot read it");
}

/** The prefix a user's uploads live under. User ids are opaque; only the separator is refused. */
export function userPrefix(userId: string): string {
  if (!userId || userId.includes("/")) throw new Error("that account id cannot own uploads");
  return `${UPLOAD_PREFIX}${userId}/`;
}

export class S3Uploads {
  constructor(
    private readonly client: S3Like,
    private readonly commands: S3CommandFactory,
    readonly bucket: string,
  ) {}

  /** Store a document under the user's prefix and return its key. */
  async put(userId: string, bytes: Uint8Array, mediaType: MediaType): Promise<string> {
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("that document is larger than 10 MB");
    const key = `${userPrefix(userId)}${randomUUID()}.${EXTENSION[mediaType]}`;
    await this.client.send(
      this.commands.putObject({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mediaType }),
    );
    return key;
  }

  /** Read one object by key, refusing any key outside the user's own prefix. */
  async read(userId: string, key: string): Promise<UploadedDocument> {
    const prefix = userPrefix(userId);
    if (!key.startsWith(prefix) || key.includes("..") || key.length === prefix.length) {
      throw new Error("I can only read documents you uploaded yourself");
    }
    const response = await this.client.send(this.commands.getObject({ Bucket: this.bucket, Key: key }));
    if (!response.Body) throw new Error("that upload is empty");
    if ((response.ContentLength ?? 0) > MAX_UPLOAD_BYTES) throw new Error("that document is larger than 10 MB");
    const bytes = await response.Body.transformToByteArray();
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("that document is larger than 10 MB");
    return { key, bytes, mediaType: mediaTypeFor(key, response.ContentType) };
  }
}

/** The S3 adapter over the real SDK, for the bucket `CIRCA_BUCKET` names. */
export async function s3Uploads(bucket: string): Promise<S3Uploads> {
  const sdk = await import("@aws-sdk/client-s3");
  const client = new sdk.S3Client({});
  return new S3Uploads(
    client as unknown as S3Like,
    {
      getObject: (input) => new sdk.GetObjectCommand(input),
      putObject: (input) => new sdk.PutObjectCommand(input),
    },
    bucket,
  );
}

/** Uploads are on when `CIRCA_BUCKET` names a bucket, and absent otherwise. */
export async function configureUploads(env: NodeJS.ProcessEnv = process.env): Promise<S3Uploads | undefined> {
  const bucket = env["CIRCA_BUCKET"];
  return bucket ? s3Uploads(bucket) : undefined;
}
