import { newDb } from 'pg-mem';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
// Force a minimal env so importing ../app (and its config) doesn't explode.
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.S3_ENDPOINT ||= 'http://localhost:9000';
process.env.S3_BUCKET ||= 'test';
process.env.S3_ACCESS_KEY_ID ||= 'test';
process.env.S3_SECRET_ACCESS_KEY ||= 'test';

import { createApp, ImportQueue } from '../app';

export const createTestPool = async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    db.public.registerFunction({
        name: 'uuid_generate_v4',
        returns: 'uuid',
        implementation: () => crypto.randomUUID(),
        impure: true
    });

    // pg-mem lacks many Postgres builtins. Provide minimal stubs used by schema/jobs.
    // jsonb_set(target jsonb, path text[], new_value jsonb, create_missing boolean)
    db.public.registerFunction({
        name: 'jsonb_set',
        args: ['jsonb', 'text', 'jsonb', 'bool'],
        returns: 'jsonb',
        implementation: (target: any, _path: any, newValue: any) => {
            // good enough for unit tests: treat as overwrite
            return newValue ?? target;
        },
        impure: true,
    });
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const schemaPath = path.join(process.cwd(), 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

    // pg-mem does not support plpgsql DO $$ blocks; strip them for in-memory tests.
    const withoutDoBlocks = schemaSql.replace(/DO \$\$[\s\S]*?\$\$;/gmi, '');

    const sanitizedSchema = withoutDoBlocks
        .replace(/CREATE EXTENSION[^;]+;/gi, '')
        .replace(/INSERT INTO organizations[\s\S]*?;\s*/gi, '')
        .replace(/INSERT INTO users[\s\S]*?;\s*/gi, '')
        .replace(/INSERT INTO memberships[\s\S]*?;\s*/gi, '');
    await pool.query(sanitizedSchema);
    return pool;
};

export const createTestApp = async () => {
    const pool = await createTestPool();
    const importQueue: ImportQueue = {
        add: async () => ({})
    };
    const s3Client = {
        send: async () => ({})
    };
    const app = createApp({ pool, importQueue, s3Client });
    return { app, pool };
};
