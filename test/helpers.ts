import { env } from 'cloudflare:test';
import { sign } from 'hono/jwt';
// Importing the real schema keeps tests honest: if schema.sql drifts from what
// the code expects, the suite fails rather than testing a stale copy.
import schemaSql from '../schema.sql?raw';

/**
 * Drops and recreates every table, so each test starts from a known state.
 */
export async function resetDatabase(): Promise<void> {
  const statements = schemaSql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}

export const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Inserts a user directly, bypassing the SSO login flow (which would require
 * calling out to Google/GitHub).
 */
export async function createUser(
  id: string,
  email: string,
  credits: number
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO users (id, email, sso_provider, current_credits) VALUES (?, ?, ?, ?)'
  )
    .bind(id, email, 'github', credits)
    .run();
}

/**
 * Mints a JWT the same way /api/auth/login does, signed with the dev secret
 * from wrangler.toml.
 */
export async function tokenFor(
  id: string | null,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const payload: Record<string, unknown> = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...(id === null ? {} : { id }),
    ...overrides,
  };
  return sign(payload, env.JWT_SECRET, 'HS256');
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** Builds a valid job payload entry. */
export function job(n: number, overrides: Record<string, unknown> = {}) {
  return {
    company: `Company ${n}`,
    title: `Engineer ${n}`,
    location: 'Remote',
    url: `https://jobs.example.com/listing/${n}`,
    ...overrides,
  };
}
