import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

export function createS3Client() {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION || "auto";

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Missing S3 credentials: S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY");
  }
  if (!endpoint) {
    throw new Error("Missing S3 endpoint: S3_ENDPOINT");
  }

  return new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

/**
 * Cloudflare R2 buckets should already exist (created in Cloudflare dashboard).
 * We only verify existence here and throw a clear error if missing.
 */
export const ensureBucket = async (client: S3Client, bucket: string) => {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err: any) {
    // Do NOT attempt CreateBucketCommand for R2. Tell the operator what to do.
    const msg = err?.message ? ` (${err.message})` : "";
    throw new Error(
      `S3 bucket "${bucket}" not accessible. Create it in Cloudflare R2 (or fix permissions).${msg}`
    );
  }
};

export const putObject = async (
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer
) => {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
    })
  );
};

export const getObjectBody = async (
  client: S3Client,
  bucket: string,
  key: string
): Promise<Buffer> => {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  const stream = response.Body as any;

  // Some runtimes can return undefined or non-stream bodies; handle safely.
  if (!stream || typeof stream.on !== "function") {
    return Buffer.from("");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};
