import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { config } from './config';

let poolInstance: Pool | null = null;

export const getPool = (): Pool => {
    if (poolInstance) return poolInstance;
    if (config.databaseUrl) {
        poolInstance = new Pool({ connectionString: config.databaseUrl });
    } else {
        poolInstance = new Pool({
            host: config.dbHost,
            port: config.dbPort,
            user: config.dbUser,
            password: config.dbPassword,
            database: config.dbName
        });
    }
    return poolInstance;
};

export const runSchema = async (pool: Pool) => {
    const schemaPath = path.join(process.cwd(), 'backend', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    await pool.query(schemaSql);
};
