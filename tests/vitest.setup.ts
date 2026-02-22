// Vitest global setup for backend tests.
// These tests run entirely in-memory (pg-mem) and do not need real infra.
// But the app's config loader currently requires several env vars.
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.S3_ENDPOINT ||= 'http://localhost:9000';
process.env.S3_BUCKET ||= 'test';
process.env.S3_ACCESS_KEY_ID ||= 'test';
process.env.S3_SECRET_ACCESS_KEY ||= 'test';
