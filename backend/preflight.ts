// backend/preflight.ts

import { Pool } from "pg";
import IORedis from "ioredis";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { config } from "./config";

/**
 * Small helper for consistent logging
 */
function ok(msg: string) {
  console.log(`✓ ${msg}`);
}

function fail(msg: string): never {
  throw new Error(`Preflight failed: ${msg}`);
}

/**
 * Validate required environment variables exist
 * (presence only — not correctness)
 */
function checkEnvVars() {
  const required = [
    "DATABASE_URL",
    "REDIS_URL",
    "JWT_SECRET",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ];

  for (const name of required) {
    if (!process.env[name] || process.env[name]?.trim() === "") {
      fail(`Missing required env var: ${name}`);
    }
  }

  ok("Environment variables present");
}

/**
 * Check Postgres connectivity
 */
async function checkPostgres() {
  const pool = new Pool({ connectionString: config.databaseUrl });

  try {
    await pool.query("select 1");
    ok("Postgres reachable");
  } finally {
    await pool.end();
  }
}

/**
 * Check Redis connectivity
 */
async function checkRedis() {
  const redis = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  try {
    await redis.ping();
    ok("Redis reachable");
  } finally {
    redis.disconnect();
  }
}

/**
 * Check S3 / R2 connectivity (non-destructive)
 */
async function checkS3() {
  const client = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });

  try {
    await client.send(
      new HeadBucketCommand({ Bucket: config.s3Bucket })
    );
    ok("S3 bucket accessible");
  } catch (err: any) {
    fail(
      `S3 bucket not accessible (${config.s3Bucket}): ${err?.message || err}`
    );
  }
}

/**
 * Main preflight runner
 */
export async function runPreflight(opts?: { skipS3?: boolean }) {
  console.log("Running preflight checks…");

  checkEnvVars();
  await checkPostgres();
  await checkRedis();

  if (!opts?.skipS3) {
    await checkS3();
  }

  console.log("Preflight checks passed");
}
