import { newDb } from 'pg-mem';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createApp, ImportQueue } from '../app';

export const createTestPool = async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    db.public.registerFunction({
        name: 'uuid_generate_v4',
        returns: 'uuid',
        implementation: () => crypto.randomUUID(),
        impure: true
    });
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const schemaPath = path.join(process.cwd(), 'backend', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    const sanitizedSchema = schemaSql
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
