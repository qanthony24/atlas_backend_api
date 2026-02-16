import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { config } from './config';

let poolInstance: Pool | null = null;

export const getPool = (): Pool => {
  if (poolInstance) return poolInstance;
  // In this codebase we always use DATABASE_URL (Railway / prod friendly)
  poolInstance = new Pool({ connectionString: config.databaseUrl });
  return poolInstance;
};

export const runSchema = async (pool: Pool) => {
  const schemaPath = path.join(process.cwd(), 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  await pool.query(schemaSql);
};
