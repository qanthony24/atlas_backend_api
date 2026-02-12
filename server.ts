import { runPreflight } from "./preflight";
import { createApp } from './app';
import { Pool } from 'pg';
import { config } from './config';
import { getPool, runSchema } from './db';
import { createQueueConnection, createImportQueue } from './queue';
import { createS3Client, ensureBucket } from './storage';

declare const require: any;
declare const module: any;

const start = async () => {
  await runPreflight();
  const pool = new Pool({ connectionString: config.postgresUrl });
  await runSchema(pool);

  const connection = createQueueConnection();
  const importQueue = createImportQueue(connection);

  const s3Client = createS3Client();
  await ensureBucket(s3Client, config.s3Bucket);

  const app = createApp({ pool, importQueue, s3Client });

  // Railway sets PORT. Fall back to config.port for local dev.
  const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`);
});
};

