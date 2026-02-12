// backend/config.ts
function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

export const config = {
  // App
  nodeEnv: optional("NODE_ENV", "development"),
  port: Number(optional("PORT", "3000")),

  // Auth
  jwtSecret: optional("JWT_SECRET", "dev_secret"),
  // Keep this optional so Railway doesn't kill the worker if you forget it.
  // You can lock this down later.
  internalAdminToken: optional("INTERNAL_ADMIN_TOKEN", "internal_dev_token"),

  // Database / Redis (these SHOULD be required in prod)
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),

  // S3-compatible object storage (Cloudflare R2)
  s3Endpoint: required("S3_ENDPOINT"),
  s3Region: optional("S3_REGION", "auto"),
  s3Bucket: required("S3_BUCKET"),
  s3AccessKeyId: required("S3_ACCESS_KEY_ID"),
  s3SecretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  s3ForcePathStyle: optional("S3_FORCE_PATH_STYLE", "true") !== "false",
};
