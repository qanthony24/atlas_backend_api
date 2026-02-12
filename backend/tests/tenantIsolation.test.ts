import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestApp } from './helpers';

describe('tenant isolation', () => {
    let app: any;
    let pool: any;
    let orgA: string;
    let orgB: string;
    let userA: string;
    let userB: string;
    let voterA: string;

    beforeAll(async () => {
        process.env.JWT_SECRET = 'test_secret';
        const setup = await createTestApp();
        app = setup.app;
        pool = setup.pool;

        const orgAResult = await pool.query(`INSERT INTO organizations (name, status, plan_id) VALUES ('Org A', 'active', 'starter') RETURNING id`);
        const orgBResult = await pool.query(`INSERT INTO organizations (name, status, plan_id) VALUES ('Org B', 'active', 'starter') RETURNING id`);
        orgA = orgAResult.rows[0].id;
        orgB = orgBResult.rows[0].id;

        const userAResult = await pool.query(
            `INSERT INTO users (org_id, name, email, role, password_hash) VALUES ($1, 'User A', 'a@example.com', 'admin', 'password') RETURNING id`,
            [orgA]
        );
        const userBResult = await pool.query(
            `INSERT INTO users (org_id, name, email, role, password_hash) VALUES ($1, 'User B', 'b@example.com', 'admin', 'password') RETURNING id`,
            [orgB]
        );
        userA = userAResult.rows[0].id;
        userB = userBResult.rows[0].id;

        const voterResult = await pool.query(
            `INSERT INTO voters (org_id, external_id, first_name, last_name, address, city, zip)
             VALUES ($1, 'EXT-A', 'Test', 'Voter', '123 Main', 'City', '00000') RETURNING id`,
            [orgA]
        );
        voterA = voterResult.rows[0].id;
    });

    it('prevents access across orgs', async () => {
        const tokenB = jwt.sign({ sub: userB, org_id: orgB, role: 'admin' }, process.env.JWT_SECRET as string);
        const response = await request(app)
            .get('/api/v1/voters')
            .set('Authorization', `Bearer ${tokenB}`);

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(0);

        const tokenA = jwt.sign({ sub: userA, org_id: orgA, role: 'admin' }, process.env.JWT_SECRET as string);
        const responseA = await request(app)
            .get('/api/v1/voters')
            .set('Authorization', `Bearer ${tokenA}`);

        expect(responseA.status).toBe(200);
        expect(responseA.body[0].id).toBe(voterA);
    });
});
