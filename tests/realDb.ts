import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

export async function createRealTestPool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '' || databaseUrl === 'postgres://test/test') {
    throw new Error('Real DB tests require a real DATABASE_URL');
  }

  const pool = new Pool({ connectionString: databaseUrl });

  // Reset schema for repeatable tests.
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE;');
  await pool.query('CREATE SCHEMA public;');

  const schemaPath = path.join(process.cwd(), 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  await pool.query(schemaSql);

  return pool;
}
