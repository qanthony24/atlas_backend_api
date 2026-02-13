import { runPreflight } from "./preflight";
import { createApp } from './app';
import { config } from './config';
import { getPool, runSchema } from './db';
import { createQueueConnection, createImportQueue } from './queue';
import { createS3Client, ensureBucket } from './storage';

const start = async () => {
  await runPreflight();
  const pool = getPool();
  await runSchema(pool);

  const connection = createQueueConnection();
  const importQueue = createImportQueue(connection);

  const s3Client = createS3Client();
  await ensureBucket(s3Client, config.s3Bucket);

  const app = createApp({ pool, importQueue, s3Client });

  // Railway sets PORT as a string, so convert to number. Fall back to 3000 for local.
  const port = Number(process.env.PORT || config.port || 3000);

  app.listen(port, '0.0.0.0', () => {
    console.log(`VoterField Backend running on port ${port}`);
  });
};

// Call the start function and log any errors
start().catch((error) => {
  console.error('Error starting server:', error);
  process.exit(1);
});
