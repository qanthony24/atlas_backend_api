import crypto from 'crypto';
import IORedis from 'ioredis';

export type OtpChallenge = {
  id: string;
  email: string;
  code: string;
  token: string;
  createdAt: string;
  attempts: number;
};

function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

function randomDigits(len: number): string {
  // Not crypto-strong randomness for each digit, but acceptable when combined with throttling + TTL.
  // Use crypto.randomInt for proper distribution.
  let out = '';
  for (let i = 0; i < len; i++) out += String(crypto.randomInt(0, 10));
  return out;
}

function keyEmail(email: string) {
  return `otp:email:${normalizeEmail(email)}`;
}

function keyChallenge(id: string) {
  return `otp:challenge:${id}`;
}

export async function createOtpChallenge(redis: IORedis, email: string, ttlSeconds = 600): Promise<OtpChallenge> {
  const e = normalizeEmail(email);
  const id = crypto.randomUUID();
  const code = randomDigits(6);
  const token = crypto.randomBytes(24).toString('base64url');

  const challenge: OtpChallenge = {
    id,
    email: e,
    code,
    token,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };

  // One active challenge per email at a time.
  await redis.set(keyChallenge(id), JSON.stringify(challenge), 'EX', ttlSeconds);
  await redis.set(keyEmail(e), id, 'EX', ttlSeconds);

  return challenge;
}

export async function peekOtpChallenge(redis: IORedis, email: string): Promise<OtpChallenge | null> {
  const e = normalizeEmail(email);
  const id = await redis.get(keyEmail(e));
  if (!id) return null;
  const raw = await redis.get(keyChallenge(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function consumeOtpChallengeByCode(redis: IORedis, email: string, code: string): Promise<{ ok: boolean; reason?: string }> {
  const e = normalizeEmail(email);
  const provided = String(code || '').trim();
  if (!provided) return { ok: false, reason: 'missing_code' };

  // optimistic locking
  const emailKey = keyEmail(e);
  await redis.watch(emailKey);
  const id = await redis.get(emailKey);
  if (!id) {
    await redis.unwatch();
    return { ok: false, reason: 'no_challenge' };
  }

  const chKey = keyChallenge(id);
  await redis.watch(chKey);
  const raw = await redis.get(chKey);
  if (!raw) {
    await redis.unwatch();
    return { ok: false, reason: 'no_challenge' };
  }

  let ch: OtpChallenge;
  try {
    ch = JSON.parse(raw);
  } catch {
    await redis.unwatch();
    return { ok: false, reason: 'corrupt' };
  }

  const attempts = Number(ch.attempts || 0);
  if (attempts >= 5) {
    await redis.unwatch();
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (provided !== ch.code) {
    ch.attempts = attempts + 1;
    const ttl = await redis.ttl(chKey);
    const multi = redis.multi();
    multi.set(chKey, JSON.stringify(ch), 'EX', Math.max(ttl, 1));
    const res = await multi.exec();
    return res ? { ok: false, reason: 'invalid_code' } : { ok: false, reason: 'race' };
  }

  const multi = redis.multi();
  multi.del(chKey);
  multi.del(emailKey);
  const res = await multi.exec();
  return res ? { ok: true } : { ok: false, reason: 'race' };
}

export async function consumeOtpChallengeByToken(redis: IORedis, token: string): Promise<{ ok: boolean; email?: string; reason?: string }> {
  const provided = String(token || '').trim();
  if (!provided) return { ok: false, reason: 'missing_token' };

  // Token verification: scan by email index? We don't have reverse index.
  // Practical compromise for Phase 2: require email OR accept token with embedded challenge id.
  // Here we support token format: <id>.<token>
  const parts = provided.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'bad_token_format' };
  const [id, tok] = parts;

  const chKey = keyChallenge(id);
  await redis.watch(chKey);
  const raw = await redis.get(chKey);
  if (!raw) {
    await redis.unwatch();
    return { ok: false, reason: 'no_challenge' };
  }

  let ch: OtpChallenge;
  try {
    ch = JSON.parse(raw);
  } catch {
    await redis.unwatch();
    return { ok: false, reason: 'corrupt' };
  }

  if (tok !== ch.token) {
    await redis.unwatch();
    return { ok: false, reason: 'invalid_token' };
  }

  const emailKey = keyEmail(ch.email);
  const multi = redis.multi();
  multi.del(chKey);
  multi.del(emailKey);
  const res = await multi.exec();
  return res ? { ok: true, email: ch.email } : { ok: false, reason: 'race' };
}

export function formatMagicToken(challenge: OtpChallenge): string {
  return `${challenge.id}.${challenge.token}`;
}
