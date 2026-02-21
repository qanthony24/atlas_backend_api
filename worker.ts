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
            // Log receipt to prove we are consuming from the right Redis queue
            console.log('[worker.active]', {
                queue: 'import_voters',
                bullmq_job_id: job.id,
                name: job.name,
                data_keys: Object.keys(job.data || {}),
                jobId: job.data?.jobId,
                orgId: job.data?.orgId,
                fileKey: job.data?.fileKey,
            });

            await processImportJob(pool, s3Client, job.data);
        },
        { connection }
    );

    worker.on('completed', (job) => {
        console.log('[worker.completed]', { queue: 'import_voters', bullmq_job_id: job.id, name: job.name, jobId: (job.data as any)?.jobId });
    });

    worker.on('failed', (job, err) => {
        console.error('[worker.failed]', { queue: 'import_voters', bullmq_job_id: job?.id, name: job?.name, jobId: (job?.data as any)?.jobId, error: err?.message, stack: err?.stack });
    });

    console.log('Worker running...');
};

startWorker().catch(err => {
    console.error('Worker startup failed', err);
    process.exit(1);
});
