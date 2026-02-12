import { describe, it, expect, beforeAll } from 'vitest';
import { createTestPool } from './helpers';
import { processImportJob } from '../jobs/importVoters';

describe('import jobs', () => {
    let pool: any;
    let orgId: string;
    let userId: string;
    let jobId: string;

    beforeAll(async () => {
        pool = await createTestPool();
        const org = await pool.query(`INSERT INTO organizations (name, status, plan_id) VALUES ('Org A', 'active', 'starter') RETURNING id`);
        orgId = org.rows[0].id;
        const user = await pool.query(
            `INSERT INTO users (org_id, name, email, role, password_hash) VALUES ($1, 'User', 'user@example.com', 'admin', 'password') RETURNING id`,
            [orgId]
        );
        userId = user.rows[0].id;
        const job = await pool.query(
            `INSERT INTO import_jobs (org_id, user_id, type, status, metadata)
             VALUES ($1, $2, 'import_voters', 'pending', $3) RETURNING id`,
            [orgId, userId, { count: 2 }]
        );
        jobId = job.rows[0].id;
    });

    it('processes voter imports asynchronously', async () => {
        const result = await processImportJob(pool, null, {
            jobId,
            orgId,
            userId,
            voters: [
                { external_id: 'IMP-1', first_name: 'A', last_name: 'One', address: '1 St', city: 'City', zip: '00000' },
                { external_id: 'IMP-2', first_name: 'B', last_name: 'Two', address: '2 St', city: 'City', zip: '00000' }
            ]
        });

        expect(result.importedCount).toBe(2);

        const voters = await pool.query(`SELECT COUNT(*)::int AS count FROM voters WHERE org_id = $1`, [orgId]);
        expect(voters.rows[0].count).toBe(2);

        const job = await pool.query(`SELECT status FROM import_jobs WHERE id = $1`, [jobId]);
        expect(job.rows[0].status).toBe('completed');
    });
});
