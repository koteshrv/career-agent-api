import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

/**
 * Runs once before test/api.test.ts is loaded (Vitest guarantees setupFiles
 * finish, including their own top-level code, before the test file's module
 * graph is evaluated). Everything below MUST set process.env as plain
 * top-level statements, with no static import of ../src/db, ../src/redis, or
 * ../src/app anywhere in this file — those modules read DATABASE_URL /
 * REDIS_URL / PUBLIC_KEY / PRIVATE_KEY at import time, so importing them
 * before the assignments below would construct a Pool/Redis client against
 * blank config. They're reached only via dynamic import() inside the hooks
 * below, which run after this module's top level has already executed.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-google-client-id';
process.env.GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'test-github-client-id';
process.env.GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || 'test-github-client-secret';

// A real RS256 keypair, generated fresh per test run — nothing about it needs
// to be stable across runs, it just has to match what the app verifies with.
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.env.PUBLIC_KEY = publicKey;
process.env.PRIVATE_KEY = privateKey;

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schema.sql');

/**
 * Drops and recreates every table from the real schema.sql, once for the
 * whole run. Keeping this separate from the per-test reset in
 * test/helpers.ts (which just TRUNCATEs) is what keeps the "tests fail if
 * schema.sql drifts from what the code expects" property without re-parsing
 * DDL before every single test.
 */
beforeAll(async () => {
  const { pool } = await import('../src/db');

  await pool.query('DROP TABLE IF EXISTS job_reports, pulled_jobs, jobs, users CASCADE');

  const schemaSql = readFileSync(schemaPath, 'utf-8');
  const statements = schemaSql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await pool.query(statement);
  }
}, 30_000);

// Undoes any per-test vi.spyOn(globalThis, 'fetch') from stubFetch (see
// test/helpers.ts) so a mock from a login test can never leak into the next.
afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const { pool } = await import('../src/db');
  const { redis } = await import('../src/redis');
  await pool.end();
  redis.disconnect();
});
