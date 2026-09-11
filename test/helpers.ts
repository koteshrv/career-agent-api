import jwt from 'jsonwebtoken';
import { vi } from 'vitest';

/**
 * Drops every row between tests for isolation. The schema itself is applied
 * fresh from schema.sql once per run in test/setup.ts — this just clears data.
 */
export async function resetDatabase(): Promise<void> {
  const { pool } = await import('../src/db');
  await pool.query('TRUNCATE TABLE job_reports, pulled_jobs, jobs, users RESTART IDENTITY CASCADE');
}

export const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Inserts a user directly, bypassing the SSO login flow (which would require
 * calling out to Google/GitHub). provider_user_id is left unset for these —
 * only the identity/login tests need it, and they create users through the
 * real /api/auth/login flow with mocked IdP responses instead (see stubFetch).
 */
export async function createUser(
  id: string,
  email: string,
  credits: number,
  overrides: { sso_provider?: string; provider_user_id?: string | null; is_admin?: boolean } = {}
): Promise<void> {
  const { DB } = await import('../src/db');
  await DB.prepare(
    'INSERT INTO users (id, email, sso_provider, provider_user_id, current_credits, is_admin) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(
      id,
      email,
      overrides.sso_provider ?? 'github',
      overrides.provider_user_id ?? null,
      credits,
      overrides.is_admin ?? false
    )
    .run();
}

/**
 * Mints a JWT the same way /api/auth/login does, signed with the RS256
 * test keypair test/setup.ts generates into process.env.
 */
export function tokenFor(id: string | null, overrides: Record<string, unknown> = {}): string {
  const payload: Record<string, unknown> = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...(id === null ? {} : { id }),
    ...overrides,
  };
  return jwt.sign(payload, process.env.PRIVATE_KEY!, { algorithm: 'RS256' });
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

/**
 * Stubs global fetch for one test — used to fake Google/GitHub's HTTP APIs
 * during /api/auth/login tests without calling out to the real internet.
 * Callers get the mock's spy back so they can assert on calls if needed;
 * test/setup.ts restores all mocks after every test automatically.
 */
export function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
