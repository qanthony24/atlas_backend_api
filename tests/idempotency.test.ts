import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestApp } from './helpers';

describe('interaction idempotency', () => {
    let app: any;
    let pool: any;
    let orgId: string;
    let userId: string;
    let voterId: string;
    let token: string;

    beforeAll(async () => {
        process.env.JWT_SECRET = 'test_secret';
        const setup = await createTestApp();
        app = setup.app;
        pool = setup.pool;

        const org = await pool.query(`INSERT INTO organizations (name, status, plan_id) VALUES ('Org A', 'active', 'starter') RETURNING id`);
        orgId = org.rows[0].id;
        const user = await pool.query(
            `INSERT INTO users (org_id, name, email, role, password_hash) VALUES ($1, 'User', 'user@example.com', 'canvasser', 'password') RETURNING id`,
            [orgId]
        );
        userId = user.rows[0].id;
        const voter = await pool.query(
            `INSERT INTO voters (org_id, external_id, first_name, last_name, address, city, zip)
             VALUES ($1, 'EXT-1', 'Test', 'Voter', '123 Main', 'City', '00000') RETURNING id`,
            [orgId]
        );
        voterId = voter.rows[0].id;

        token = jwt.sign({ sub: userId, org_id: orgId, role: 'canvasser' }, process.env.JWT_SECRET as string);
    });

    it('does not duplicate interactions on retry', async () => {
        const payload = {
            client_interaction_uuid: 'abc-123',
            org_id: orgId,
            voter_id: voterId,
            occurred_at: new Date().toISOString(),
            channel: 'canvass',
            result_code: 'contacted',
            notes: 'First attempt'
        };

        const first = await request(app)
            .post('/api/v1/interactions')
            .set('Authorization', `Bearer ${token}`)
            .send(payload);
        expect(first.status).toBe(201);

        const second = await request(app)
            .post('/api/v1/interactions')
            .set('Authorization', `Bearer ${token}`)
            .send(payload);
        expect(second.status).toBe(200);
        expect(second.body.client_interaction_uuid).toBe(payload.client_interaction_uuid);

        const count = await pool.query(
            `SELECT COUNT(*)::int AS count FROM interactions WHERE org_id = $1 AND client_interaction_uuid = $2`,
            [orgId, payload.client_interaction_uuid]
        );
        expect(count.rows[0].count).toBe(1);
    });
});
