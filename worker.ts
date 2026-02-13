import { runPreflight } from "./preflight";
import { Worker } from 'bullmq';
import { createQueueConnection } from './queue';
import { getPool, runSchema } from './db';
import { createS3Client, ensureBucket } from './storage';
import { processImportJob } from './jobs/importVoters';
import { config } from './config';

const startWorker = async () => {
    await runPreflight();
    const pool = getPool();
    await runSchema(pool);

    const connection = createQueueConnection();

    const s3Client = createS3Client();
    await ensureBucket(s3Client, config.s3Bucket);

    const worker = new Worker(
        'import_voters',
        async job => {
            await processImportJob(pool, s3Client, job.data);
        },
        { connection }
    );

    worker.on('failed', (job, err) => {
        console.error('Import job failed', job?.id, err);
    });

    console.log('Worker running...');
};

startWorker().catch(err => {
    console.error('Worker startup failed', err);
    process.exit(1);
});
