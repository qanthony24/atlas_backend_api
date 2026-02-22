import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import multer from "multer";
import { Pool } from "pg";
import IORedis from "ioredis";
import fs from "node:fs";
import path from "node:path";

import { authMiddleware, requireAdmin, requireInternal } from "./middleware/auth";
import { config } from "./config";
import { ensureBucket, putObject } from "./storage";
import { createQueueConnection } from './queue';
import { Queue } from 'bullmq';
import { createOtpChallenge, consumeOtpChallengeByCode, consumeOtpChallengeByToken, formatMagicToken } from "./utils/otp";
import { sendOtpEmail } from "./utils/email";

export interface ImportQueue {
  add: (name: string, data: any) => Promise<any>;
}

interface AppDependencies {
  pool: Pool;
  importQueue: ImportQueue;
  s3Client: any;
}

const mapUser = (row: any) => ({
  id: row.id,
  orgId: row.org_id,
  name: row.name,
  email: row.email,
  phone: row.phone || "",
  role: row.role,
});

const mapOrg = (row: any) => ({
  id: row.id,
  name: row.name,
  status: row.status,
  plan_id: row.plan_id,
  limits: row.limits || {},
  last_activity_at: row.last_activity_at,
});

const mapVoter = (row: any) => ({
  id: row.id,
  orgId: row.org_id,
  externalId: row.external_id || undefined,
  source: row.source || 'import',
  mergedIntoVoterId: row.merged_into_voter_id || undefined,
  firstName: row.first_name,
  middleName: row.middle_name || undefined,
  lastName: row.last_name,
  suffix: row.suffix || undefined,
  age: row.age || undefined,
  gender: row.gender || undefined,
  race: row.race || undefined,
  party: row.party || undefined,
  phone: row.phone || undefined,
  address: row.address,
  unit: row.unit || undefined,
  city: row.city,
  state: row.state || undefined,
  zip: row.zip,
  geom:
    row.geom_lat && row.geom_lng
      ? { lat: row.geom_lat, lng: row.geom_lng }
      : { lat: 0, lng: 0 },
  lastInteractionStatus: row.last_interaction_status || undefined,
  lastInteractionTime: row.last_interaction_time || undefined,
});

const mapList = (row: any) => ({
  id: row.id,
  orgId: row.org_id,
  name: row.name,
  // For the relational model (walk_lists + list_members) we aggregate voter_ids in the query.
  voterIds: row.voter_ids || [],
  createdAt: row.created_at,
  createdByUserId: row.created_by_user_id,
});

const mapAssignment = (row: any) => ({
  id: row.id,
  orgId: row.org_id,
  listId: row.list_id,
  canvasserId: row.canvasser_id,
  status: row.status,
  createdAt: row.created_at,
});

const mapInteraction = (row: any) => ({
  id: row.id,
  org_id: row.org_id,
  user_id: row.user_id,
  voter_id: row.voter_id,
  assignment_id: row.assignment_id || undefined,
  occurred_at: row.occurred_at,
  channel: row.channel,
  result_code: row.result_code,
  notes: row.notes || undefined,
  client_interaction_uuid: row.client_interaction_uuid,
  survey_responses: row.survey_responses || undefined,
});

function findOpenApiYamlPath(): string | null {
  const possiblePaths = [
    'openapi.yaml',
    './openapi.yaml'
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export const createApp = ({ pool, importQueue, s3Client }: AppDependencies) => {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });

  app.use(express.json({ limit: "10mb" }));
  app.use(cors());

  // -------------------------
  // Health / Readiness
  // -------------------------
  // Keep /health extremely lightweight & stable (Railway uses it for health checks).
  app.get('/health', (_req, res) => res.type('text/plain').send('OK'));

  // Deployment marker: helps confirm which code is actually running in Railway.
  // Safe to expose; contains no secrets.
  const DEPLOY_MARKER = 'deploy-marker-2026-02-19-users-invite-v1';
  app.get('/__version', (_req, res) => {
    res.status(200).json({ marker: DEPLOY_MARKER });
  });

  app.get("/ready", async (_req, res) => {
    try {
      await pool.query("SELECT 1");

      const redis = new IORedis(config.redisUrl);
      await redis.ping();
      await redis.quit();

      await ensureBucket(s3Client, config.s3Bucket);

      res.status(200).json({ status: "ready" });
    } catch (err: any) {
      res.status(503).json({ status: "not_ready", error: err?.message || String(err) });
    }
  });
  // (health route defined above)
  // -------------------------
  // Serve OpenAPI YAML as RAW YAML (never HTML)
  // -------------------------
  app.get("/openapi.yaml", (_req, res) => {
    try {
      const specPath = findOpenApiYamlPath();
      if (!specPath) {
        return res.status(404).type("text/plain").send("openapi.yaml not found");
      }
      const yaml = fs.readFileSync(specPath, "utf8");
      return res.status(200).type("text/yaml").send(yaml);
    } catch (err: any) {
      return res.status(500).json({
        error: "Failed to load openapi.yaml",
        details: err?.message || String(err),
      });
    }
  });

  // -------------------------
  // Auth (public)
  // -------------------------
  app.post("/api/v1/auth/login", async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const result = await pool.query("SELECT * FROM users WHERE email = $1 LIMIT 1", [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const stored = user.password_hash || "";
    const valid = stored.startsWith("$2") ? await bcrypt.compare(password, stored) : password === stored;
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const org = await pool.query("SELECT * FROM organizations WHERE id = $1", [user.org_id]);
    const token = jwt.sign({ sub: user.id, org_id: user.org_id, role: user.role }, config.jwtSecret, {
      expiresIn: "12h",
    });

    res.json({ token, user: mapUser(user), org: mapOrg(org.rows[0]) });
  });

  // OTP / Magic-link login (public)
  // - Always returns 200 to avoid account enumeration.
  // - During SES sandbox, email delivery may fail; we still generate the challenge.
  app.post('/api/v1/auth/otp/request', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(200).json({ ok: true });

    // Only for existing users. If not found, return ok anyway.
    const found = await pool.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email]);
    if (!found.rows[0]) return res.status(200).json({ ok: true });

    const redis = new IORedis(config.redisUrl);
    try {
      const challenge = await createOtpChallenge(redis, email, 600);
      const magicToken = formatMagicToken(challenge);
      const magicLink = `${config.appBaseUrl}/#/login?token=${encodeURIComponent(magicToken)}`;

      // Send email in the background so the HTTP request never blocks on SMTP.
      // (SES sandbox / misconfig should not freeze the UI.)
      void sendOtpEmail({ to: email, code: challenge.code, magicLink })
        .then((sendRes) => {
          console.log('[otp.request]', {
            email,
            attempted: sendRes.attempted,
            messageId: sendRes.messageId,
            error: sendRes.error,
          });
        })
        .catch((err: any) => {
          console.log('[otp.request]', {
            email,
            attempted: true,
            error: err?.message || String(err),
          });
        });

      return res.status(200).json({ ok: true });
    } finally {
      await redis.quit();
    }
  });

  app.post('/api/v1/auth/otp/verify', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    const token = String(req.body?.token || '').trim();

    const redis = new IORedis(config.redisUrl);
    try {
      let ok = false;
      let resolvedEmail = email;

      if (token) {
        const r = await consumeOtpChallengeByToken(redis, token);
        ok = r.ok;
        if (r.email) resolvedEmail = r.email;
      } else {
        const r = await consumeOtpChallengeByCode(redis, email, code);
        ok = r.ok;
      }

      if (!ok || !resolvedEmail) {
        return res.status(401).json({ error: 'Invalid or expired code' });
      }

      const result = await pool.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [resolvedEmail]);
      const user = result.rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid or expired code' });

      const org = await pool.query('SELECT * FROM organizations WHERE id = $1', [user.org_id]);
      const jwtToken = jwt.sign({ sub: user.id, org_id: user.org_id, role: user.role }, config.jwtSecret, {
        expiresIn: '12h',
      });

      return res.status(200).json({ token: jwtToken, user: mapUser(user), org: mapOrg(org.rows[0]) });
    } finally {
      await redis.quit();
    }
  });

  // Everything below here requires auth
  app.use("/api/v1", authMiddleware);

  // -------------------------
  // Session endpoints
  // -------------------------
  app.get("/api/v1/me", async (req: any, res) => {
    const user = await pool.query("SELECT * FROM users WHERE id = $1 AND org_id = $2", [req.context.userId, req.context.orgId]);
    const org = await pool.query("SELECT * FROM organizations WHERE id = $1", [req.context.orgId]);
    res.json({ user: mapUser(user.rows[0]), org: mapOrg(org.rows[0]) });
  });

  app.get("/api/v1/org", async (req: any, res) => {
    const org = await pool.query("SELECT * FROM organizations WHERE id = $1", [req.context.orgId]);
    res.json(mapOrg(org.rows[0]));
  });

  // -------------------------
  // Voters
  // -------------------------
  app.get("/api/v1/voters", async (req: any, res) => {
    const { q, limit = "50", offset = "0" } = req.query || {};
    const lim = Math.min(Number(limit) || 50, 200);
    const off = Number(offset) || 0;

    const params: any[] = [req.context.orgId, lim, off];

    let where = "WHERE v.org_id = $1";
    if (q) {
      params.unshift(`%${q}%`);
      where = "WHERE v.org_id = $2 AND (v.first_name ILIKE $1 OR v.last_name ILIKE $1 OR v.address ILIKE $1)";
    }

    const querySql = `
      SELECT
        v.*,
        li.last_interaction_status,
        li.last_interaction_time
      FROM voters v
      LEFT JOIN (
        SELECT DISTINCT ON (voter_id, org_id)
          voter_id,
          org_id,
          result_code AS last_interaction_status,
          occurred_at AS last_interaction_time
        FROM interactions
        WHERE org_id = $1
        ORDER BY voter_id, org_id, occurred_at DESC
      ) li ON li.voter_id = v.id AND li.org_id = v.org_id
      ${where}
      ORDER BY v.last_name, v.first_name
      LIMIT $${q ? 2 : 2} OFFSET $${q ? 3 : 3}
    `;

    // NOTE: the $ indexes above are a bit ugly because of the q branch.
    // We keep the existing behavior by using two query variants.
    if (q) {
      const sql = `
        SELECT
          v.*,
          li.last_interaction_status,
          li.last_interaction_time
        FROM voters v
        LEFT JOIN (
          SELECT DISTINCT ON (voter_id, org_id)
            voter_id,
            org_id,
            result_code AS last_interaction_status,
            occurred_at AS last_interaction_time
          FROM interactions
          WHERE org_id = $2
          ORDER BY voter_id, org_id, occurred_at DESC
        ) li ON li.voter_id = v.id AND li.org_id = v.org_id
        WHERE v.org_id = $2
          AND (v.first_name ILIKE $1 OR v.last_name ILIKE $1 OR v.address ILIKE $1)
        ORDER BY v.last_name, v.first_name
        LIMIT $3 OFFSET $4
      `;
      const rows = await pool.query(sql, [`%${q}%`, req.context.orgId, lim, off]);
      return res.json({ voters: rows.rows.map(mapVoter), limit: lim, offset: off });
    }

    const rows = await pool.query(
      `
      SELECT
        v.*,
        li.last_interaction_status,
        li.last_interaction_time
      FROM voters v
      LEFT JOIN (
        SELECT DISTINCT ON (voter_id, org_id)
          voter_id,
          org_id,
          result_code AS last_interaction_status,
          occurred_at AS last_interaction_time
        FROM interactions
        WHERE org_id = $1
        ORDER BY voter_id, org_id, occurred_at DESC
      ) li ON li.voter_id = v.id AND li.org_id = v.org_id
      WHERE v.org_id = $1
      ORDER BY v.last_name, v.first_name
      LIMIT $2 OFFSET $3
      `,
      [req.context.orgId, lim, off]
    );

    res.json({ voters: rows.rows.map(mapVoter), limit: lim, offset: off });
  });

  app.get("/api/v1/voters/:id", async (req: any, res) => {
    const row = await pool.query("SELECT * FROM voters WHERE id = $1 AND org_id = $2", [
      req.params.id,
      req.context.orgId,
    ]);
    if (!row.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(mapVoter(row.rows[0]));
  });

  app.post("/api/v1/voters", async (req: any, res) => {
    const v = req.body || {};
    const id = crypto.randomUUID();

    // Manual adds are treated as "leads" (not necessarily on the imported voter file)
    const source = 'manual';

    await pool.query(
      `
      INSERT INTO voters (id, org_id, external_id, source, first_name, middle_name, last_name, suffix, age, gender, race, party, phone, address, unit, city, state, zip, geom_lat, geom_lng)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      `,
      [
        id,
        req.context.orgId,
        v.externalId || null,
        source,
        v.firstName || "",
        v.middleName || null,
        v.lastName || "",
        v.suffix || null,
        v.age || null,
        v.gender || null,
        v.race || null,
        v.party || null,
        v.phone || null,
        v.address || "",
        v.unit || null,
        v.city || "",
        v.state || null,
        v.zip || "",
        v.geom?.lat ?? null,
        v.geom?.lng ?? null,
      ]
    );

    const created = await pool.query("SELECT * FROM voters WHERE id = $1 AND org_id = $2", [id, req.context.orgId]);
    res.status(201).json(mapVoter(created.rows[0]));
  });

  // -------------------------
  // Lists & Assignments
  // -------------------------
  app.get("/api/v1/lists", async (req: any, res) => {
    const rows = await pool.query(
      `
      SELECT
        wl.*,
        COALESCE(array_agg(lm.voter_id) FILTER (WHERE lm.voter_id IS NOT NULL), '{}') AS voter_ids
      FROM walk_lists wl
      LEFT JOIN list_members lm
        ON lm.org_id = wl.org_id
       AND lm.list_id = wl.id
      WHERE wl.org_id = $1
      GROUP BY wl.id
      ORDER BY wl.created_at DESC
      `,
      [req.context.orgId]
    );

    res.json(rows.rows.map(mapList));
  });

  app.post("/api/v1/lists", async (req: any, res) => {
    const { name, voterIds } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const listId = crypto.randomUUID();
    const ids: string[] = Array.isArray(voterIds) ? voterIds : [];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        "INSERT INTO walk_lists (id, org_id, name, created_by_user_id) VALUES ($1,$2,$3,$4)",
        [listId, req.context.orgId, name, req.context.userId]
      );

      for (const voterId of ids) {
        await client.query(
          "INSERT INTO list_members (org_id, list_id, voter_id) VALUES ($1,$2,$3) ON CONFLICT (org_id, list_id, voter_id) DO NOTHING",
          [req.context.orgId, listId, voterId]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const created = await pool.query(
      `
      SELECT
        wl.*,
        COALESCE(array_agg(lm.voter_id) FILTER (WHERE lm.voter_id IS NOT NULL), '{}') AS voter_ids
      FROM walk_lists wl
      LEFT JOIN list_members lm
        ON lm.org_id = wl.org_id
       AND lm.list_id = wl.id
      WHERE wl.id = $1 AND wl.org_id = $2
      GROUP BY wl.id
      `,
      [listId, req.context.orgId]
    );

    res.status(201).json(mapList(created.rows[0]));
  });

  app.get("/api/v1/assignments", async (req: any, res) => {
    const scope = (req.query?.scope as string) || "me";
    if (scope === "org" && req.context.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const rows =
      scope === "org"
        ? await pool.query("SELECT * FROM assignments WHERE org_id = $1 ORDER BY created_at DESC", [req.context.orgId])
        : await pool.query(
            "SELECT * FROM assignments WHERE org_id = $1 AND canvasser_id = $2 ORDER BY created_at DESC",
            [req.context.orgId, req.context.userId]
          );

    res.json(rows.rows.map(mapAssignment));
  });

  app.post("/api/v1/assignments", requireAdmin, async (req: any, res) => {
    const { listId, canvasserId } = req.body || {};
    const id = crypto.randomUUID();

    await pool.query(
      "INSERT INTO assignments (id, org_id, list_id, canvasser_id, status) VALUES ($1,$2,$3,$4,$5)",
      [id, req.context.orgId, listId, canvasserId, "assigned"]
    );

    const created = await pool.query("SELECT * FROM assignments WHERE id = $1 AND org_id = $2", [id, req.context.orgId]);
    res.status(201).json(mapAssignment(created.rows[0]));
  });

  // -------------------------
  // Interactions (idempotent)
  // -------------------------
  app.get("/api/v1/interactions", async (req: any, res) => {
    const rows = await pool.query(
      `
      SELECT i.*, sr.responses AS survey_responses
      FROM interactions i
      LEFT JOIN survey_responses sr
        ON sr.org_id = i.org_id
       AND sr.interaction_id = i.id
      WHERE i.org_id = $1
      ORDER BY i.occurred_at DESC
      LIMIT 200
      `,
      [req.context.orgId]
    );
    res.json(rows.rows.map(mapInteraction));
  });

  app.post("/api/v1/interactions", async (req: any, res) => {
    const body = req.body || {};
    const clientUUID = body.client_interaction_uuid;

    if (!clientUUID) return res.status(400).json({ error: "client_interaction_uuid required" });
    if (!body.voter_id) return res.status(400).json({ error: 'voter_id required' });
    if (!body.result_code) return res.status(400).json({ error: 'result_code required' });

    const occurredAt = body.occurred_at || new Date().toISOString();
    const channel = body.channel || 'canvass';

    const client = await pool.connect();
    let inserted = false;
    let interactionId: string | null = null;

    try {
      await client.query('BEGIN');

      const insert = await client.query(
        `
        INSERT INTO interactions
          (id, org_id, user_id, voter_id, assignment_id, occurred_at, channel, result_code, notes, client_interaction_uuid)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (org_id, client_interaction_uuid) DO NOTHING
        RETURNING id
        `,
        [
          crypto.randomUUID(),
          req.context.orgId,
          req.context.userId,
          body.voter_id,
          body.assignment_id || null,
          occurredAt,
          channel,
          body.result_code,
          body.notes || null,
          clientUUID,
        ]
      );

      if (insert.rows[0]) {
        inserted = true;
        interactionId = insert.rows[0].id;

        if (body.survey_responses && typeof body.survey_responses === 'object') {
          await client.query(
            `
            INSERT INTO survey_responses (org_id, interaction_id, responses)
            VALUES ($1,$2,$3)
            ON CONFLICT (org_id, interaction_id) DO NOTHING
            `,
            [req.context.orgId, interactionId, body.survey_responses]
          );
        }
      } else {
        // Duplicate submission; keep the first record (append-only semantics)
        const existing = await client.query(
          `SELECT id FROM interactions WHERE org_id = $1 AND client_interaction_uuid = $2 LIMIT 1`,
          [req.context.orgId, clientUUID]
        );
        interactionId = existing.rows[0]?.id || null;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (!interactionId) return res.status(500).json({ error: 'Failed to resolve interaction id' });

    const row = await pool.query(
      `
      SELECT i.*, sr.responses AS survey_responses
      FROM interactions i
      LEFT JOIN survey_responses sr
        ON sr.org_id = i.org_id
       AND sr.interaction_id = i.id
      WHERE i.id = $1 AND i.org_id = $2
      `,
      [interactionId, req.context.orgId]
    );

    return res.status(inserted ? 201 : 200).json(mapInteraction(row.rows[0]));
  });

  // Bulk interactions: idempotent by (org_id, client_interaction_uuid)
  app.post("/api/v1/interactions/bulk", async (req: any, res) => {
    const body = req.body;
    const items = Array.isArray(body) ? body : body?.interactions;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Expected an array of interactions or { interactions: [...] }' });
    }
    if (items.length === 0) {
      return res.json({ inserted_count: 0, duplicate_count: 0 });
    }

    // Basic per-item validation (fast fail)
    for (const [idx, it] of items.entries()) {
      if (!it?.client_interaction_uuid) return res.status(400).json({ error: `items[${idx}].client_interaction_uuid required` });
      if (!it?.voter_id) return res.status(400).json({ error: `items[${idx}].voter_id required` });
      if (!it?.result_code) return res.status(400).json({ error: `items[${idx}].result_code required` });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Build a single INSERT ... VALUES ... ON CONFLICT DO NOTHING
      const cols = '(id, org_id, user_id, voter_id, assignment_id, occurred_at, channel, result_code, notes, client_interaction_uuid)';
      const valuesSql: string[] = [];
      const params: any[] = [];

      for (const it of items) {
        const occurredAt = it.occurred_at || new Date().toISOString();
        const channel = it.channel || 'canvass';
        const base = params.length;
        valuesSql.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`);
        params.push(
          crypto.randomUUID(),
          req.context.orgId,
          req.context.userId,
          it.voter_id,
          it.assignment_id || null,
          occurredAt,
          channel,
          it.result_code,
          it.notes || null,
          it.client_interaction_uuid
        );
      }

      const insertedRows = await client.query(
        `
        INSERT INTO interactions ${cols}
        VALUES ${valuesSql.join(',')}
        ON CONFLICT (org_id, client_interaction_uuid) DO NOTHING
        RETURNING id, client_interaction_uuid
        `,
        params
      );

      // Insert survey responses for newly-created interactions only
      const surveyValueSql: string[] = [];
      const surveyParams: any[] = [];
      for (const row of insertedRows.rows) {
        const src = items.find((x: any) => x.client_interaction_uuid === row.client_interaction_uuid);
        if (src?.survey_responses && typeof src.survey_responses === 'object') {
          const base = surveyParams.length;
          surveyValueSql.push(`($${base + 1},$${base + 2},$${base + 3})`);
          surveyParams.push(req.context.orgId, row.id, src.survey_responses);
        }
      }
      if (surveyValueSql.length > 0) {
        await client.query(
          `
          INSERT INTO survey_responses (org_id, interaction_id, responses)
          VALUES ${surveyValueSql.join(',')}
          ON CONFLICT (org_id, interaction_id) DO NOTHING
          `,
          surveyParams
        );
      }

      await client.query('COMMIT');

      const inserted_count = insertedRows.rows.length;
      const duplicate_count = items.length - inserted_count;

      return res.status(200).json({
        inserted_count,
        duplicate_count,
        inserted_client_uuids: insertedRows.rows.map((r: any) => r.client_interaction_uuid),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // -------------------------
  // Users
  // -------------------------
  // Admin-only user list (optionally filter by role)
  app.get("/api/v1/users", requireAdmin, async (req: any, res) => {
    const role = String(req.query?.role || '').trim();
    if (role && role !== 'admin' && role !== 'canvasser') {
      return res.status(400).json({ error: "Invalid role filter" });
    }

    const rows = role
      ? await pool.query("SELECT * FROM users WHERE org_id = $1 AND role = $2 ORDER BY created_at DESC", [req.context.orgId, role])
      : await pool.query("SELECT * FROM users WHERE org_id = $1 ORDER BY created_at DESC", [req.context.orgId]);

    res.json(rows.rows.map(mapUser));
  });

  // Admin-only invite/create canvasser (Phase 2 dev implementation)
  // NOTE: This is not a real email invite flow yet. It creates the user inside the org.
  app.post("/api/v1/users/invite", requireAdmin, async (req: any, res) => {
    const { name, email, phone, role } = req.body || {};
    const userRole = (role === 'admin' || role === 'canvasser') ? role : 'canvasser';
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });

    const id = crypto.randomUUID();
    const password_hash = 'password';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO users (id, org_id, name, email, phone, role, password_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`
        ,
        [id, req.context.orgId, name, email, phone || '', userRole, password_hash]
      );

      await client.query(
        `INSERT INTO memberships (org_id, user_id, role)
         VALUES ($1,$2,$3)
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [req.context.orgId, id, userRole]
      );

      await client.query(
        `INSERT INTO audit_logs (action, actor_user_id, target_org_id, metadata)
         VALUES ('user.invite', $1, $2, $3)`,
        [req.context.userId, req.context.orgId, { invited_user_id: id, email, role: userRole }]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // unique(org_id,email) violation
      return res.status(409).json({ error: 'User already exists in org' });
    } finally {
      client.release();
    }

    const created = await pool.query("SELECT * FROM users WHERE id = $1 AND org_id = $2", [id, req.context.orgId]);
    return res.status(201).json(mapUser(created.rows[0]));
  });

  // -------------------------
  // Jobs
  // -------------------------
  app.get("/api/v1/jobs/:id", async (req: any, res) => {
    const row = await pool.query("SELECT * FROM import_jobs WHERE id = $1 AND org_id = $2", [
      req.params.id,
      req.context.orgId,
    ]);
    if (!row.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(row.rows[0]);
  });

  app.post("/api/v1/jobs/import-voters", async (req: any, res) => {
    const voters = req.body || [];
    const jobId = crypto.randomUUID();

    await pool.query(
      `
      INSERT INTO import_jobs (id, org_id, user_id, type, status, created_at, updated_at, metadata)
      VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),$6)
      `,
      [
        jobId,
        req.context.orgId,
        req.context.userId,
        'import_voters',
        'pending',
        { count: Array.isArray(voters) ? voters.length : 0 },
      ]
    );

    await importQueue.add('import-voters', { jobId, orgId: req.context.orgId, userId: req.context.userId, voters });

    res.status(202).json({ id: jobId, status: 'pending' });
  });

  // multipart file upload path (optional / future)
  app.post("/api/v1/imports/voters", upload.single("file"), async (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });

    const jobId = crypto.randomUUID();
    const extRaw = path.extname(req.file.originalname || '').toLowerCase();
    const ext = extRaw && extRaw.length <= 10 ? extRaw : '.csv';
    const key = `imports/${req.context.orgId}/${jobId}${ext}`;

    await putObject(s3Client, config.s3Bucket, key, req.file.buffer);

    await pool.query(
      `
      INSERT INTO import_jobs (id, org_id, user_id, type, status, created_at, updated_at, file_key, metadata)
      VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),$6,$7)
      `,
      [
        jobId,
        req.context.orgId,
        req.context.userId,
        'import_voters',
        'pending',
        key,
        { key, filename: req.file.originalname, size: req.file.size },
      ]
    );

    await importQueue.add('import-voters-file', { jobId, orgId: req.context.orgId, userId: req.context.userId, fileKey: key });

    res.status(202).json({ id: jobId, status: 'pending' });
  });

  // -------------------------
  // Merge Alerts (Admin)
  // -------------------------
  app.get('/api/v1/merge-alerts/count', requireAdmin, async (req: any, res) => {
    const row = await pool.query(
      `SELECT COUNT(*)::int AS count FROM voter_merge_alerts WHERE org_id = $1 AND status = 'open'`,
      [req.context.orgId]
    );
    res.json({ open_count: row.rows[0].count });
  });

  app.get('/api/v1/merge-alerts', requireAdmin, async (req: any, res) => {
    const status = String(req.query?.status || 'open');
    if (!['open', 'resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const rows = await pool.query(
      `
      SELECT a.*,
             lv.first_name AS lead_first_name,
             lv.last_name AS lead_last_name,
             lv.phone AS lead_phone,
             iv.external_id AS imported_external_id,
             iv.first_name AS imported_first_name,
             iv.last_name AS imported_last_name,
             iv.phone AS imported_phone
        FROM voter_merge_alerts a
        JOIN voters lv ON lv.id = a.lead_voter_id AND lv.org_id = a.org_id
        JOIN voters iv ON iv.id = a.imported_voter_id AND iv.org_id = a.org_id
       WHERE a.org_id = $1 AND a.status = $2
       ORDER BY a.created_at DESC
       LIMIT 200
      `,
      [req.context.orgId, status]
    );

    res.json({ alerts: rows.rows });
  });

  // -------------------------
  // Metrics
  // -------------------------
  app.get("/api/v1/metrics/field/summary", requireAdmin, async (req: any, res) => {
    const voters = await pool.query("SELECT COUNT(*)::int AS count FROM voters WHERE org_id = $1", [req.context.orgId]);
    const interactions = await pool.query("SELECT COUNT(*)::int AS count FROM interactions WHERE org_id = $1", [
      req.context.orgId,
    ]);
    res.json({ voter_count: voters.rows[0].count, interaction_count: interactions.rows[0].count });
  });

  // -------------------------
  // Internal (platform admin)
  // -------------------------
  app.get("/api/v1/internal/queues/import_voters/counts", requireInternal, async (_req: any, res) => {
    try {
      // BullMQ stores queue metadata in Redis. This endpoint proves whether jobs are landing in Redis.
      const connection = createQueueConnection();
      const q = new Queue('import_voters', { connection });
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused');
      await q.close();
      connection.disconnect();
      return res.json({ queue: 'import_voters', counts });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to inspect queue', details: err?.message || String(err) });
    }
  });

  app.get("/api/v1/internal/organizations", requireInternal, async (_req: any, res) => {
    const orgs = await pool.query("SELECT * FROM organizations ORDER BY created_at DESC LIMIT 200");
    res.json(orgs.rows.map(mapOrg));
  });

  app.get("/api/v1/internal/organizations/:id/health", requireInternal, async (req: any, res) => {
    const org = await pool.query("SELECT * FROM organizations WHERE id = $1", [req.params.id]);
    if (!org.rows[0]) return res.status(404).json({ error: "Not found" });

    const userCount = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE org_id = $1", [req.params.id]);
    const voterCount = await pool.query("SELECT COUNT(*)::int AS count FROM voters WHERE org_id = $1", [req.params.id]);
    const activeJobs = await pool.query(
      `SELECT COUNT(*)::int AS count FROM import_jobs WHERE org_id = $1 AND status IN ('pending', 'processing')`,
      [req.params.id]
    );

    res.json({
      org_id: req.params.id,
      status: org.rows[0].status,
      last_activity_at: org.rows[0].last_activity_at,
      metrics: {
        user_count: userCount.rows[0].count,
        voter_count: voterCount.rows[0].count,
        active_jobs: activeJobs.rows[0].count,
      },
    });
  });

  return app;
};




