import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config';

// BullMQ requirement: maxRetriesPerRequest must be null for blocking commands.
// Without this, the worker can crash at startup.
export const createQueueConnection = () =>
  new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
    // This often helps in hosted Redis environments (Railway included).
    // It prevents startup hangs / odd readiness behaviors.
    enableReadyCheck: false,
  });

export const createImportQueue = (connection: IORedis) => {
  return new Queue('import_voters', { connection });
};
