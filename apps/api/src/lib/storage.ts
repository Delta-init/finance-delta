import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "../config/env";

/** Returns a configured S3Client pointed at R2, or null when R2 is not configured. */
function makeClient(): S3Client | null {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

const client = makeClient();

export const storageConfigured = (): boolean => client !== null;

export interface UploadedFile {
  key: string;
  url: string;
  size: number;
  mimeType: string;
  originalName: string;
}

/** Upload a buffer to R2. Returns the public URL and key. */
export async function uploadFile(opts: {
  key: string;
  buffer: Buffer;
  mimeType: string;
  originalName: string;
}): Promise<UploadedFile> {
  if (!client) throw new Error("Storage not configured — add R2 env vars");

  await client.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: opts.key,
      Body: opts.buffer,
      ContentType: opts.mimeType,
      ContentDisposition: `inline; filename="${opts.originalName}"`,
      Metadata: { originalName: opts.originalName },
    }),
  );

  const url = env.R2_PUBLIC_URL
    ? `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${opts.key}`
    : `https://${env.R2_BUCKET_NAME}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${opts.key}`;

  return { key: opts.key, url, size: opts.buffer.byteLength, mimeType: opts.mimeType, originalName: opts.originalName };
}

/** Delete a previously uploaded key from R2. Silently ignores missing keys. */
export async function deleteFile(key: string): Promise<void> {
  if (!client || !key) return;
  try {
    await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
  } catch {
    // ignore missing
  }
}
