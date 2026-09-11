import jwt from 'jsonwebtoken';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app';
import { DB } from '../src/db';
import {
  authHeaders,
  createUser,
  job,
  jsonResponse,
  resetDatabase,
  stubFetch,
  TEST_USER_ID,
  tokenFor,
} from './helpers';

const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';

let token: string;

beforeAll(async () => {
  await app.ready();
});

/** Thin adapter so the rest of this file reads like a real fetch response. */
async function req(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}): Promise<{ status: number; json: () => Promise<any> }> {
  const res = await app.inject(opts as any);
  return { status: res.statusCode, json: async () => res.json() };
}

function decodeUserId(token: string): string {
  return (jwt.decode(token) as any).id;
}

async function push(body: unknown, as: string = token) {
  return req({ method: 'POST', url: '/v1/jobs/push', headers: authHeaders(as), payload: body });
}

async function pull(limit: number | string = 10, as: string = token) {
  return req({ method: 'GET', url: `/v1/jobs/pull?limit=${limit}`, headers: authHeaders(as) });
}

async function me(as: string = token) {
  return req({ method: 'GET', url: '/v1/me', headers: authHeaders(as) });
}

async function report(jobId: string, as: string = token) {
  return req({
    method: 'POST',
    url: '/v1/jobs/report',
    headers: authHeaders(as),
    payload: { job_id: jobId, reason: 'fake' },
  });
}

async function logoutAll(as: string = token) {
  // Deliberately not authHeaders(): this route takes no body, and sending a
  // Content-Type: application/json with no payload trips Fastify's own
  // empty-JSON-body rejection before the handler ever runs.
  return req({ method: 'POST', url: '/v1/auth/logout-all', headers: { Authorization: `Bearer ${as}` } });
}

async function login(body: unknown) {
  return req({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'Content-Type': 'application/json' },
    payload: body,
  });
}

async function exportMe(as: string = token) {
  return req({ method: 'GET', url: '/v1/me/export', headers: authHeaders(as) });
}

// confirm: null means "send no payload at all" — can't default-parameter
// this to omit-on-undefined, since JS replaces an explicitly-passed
// `undefined` with the default too, only `null` survives.
async function deleteMe(confirm: boolean | null = true, as: string = token) {
  return req({
    method: 'DELETE',
    url: '/v1/me',
    headers: authHeaders(as),
    payload: confirm === null ? undefined : { confirm },
  });
}

async function adminUsersByEmail(email: string, as: string = token) {
  return req({
    method: 'GET',
    url: `/v1/admin/users?email=${encodeURIComponent(email)}`,
    headers: authHeaders(as),
  });
}

async function adminSetCredits(id: string, credits: number, as: string = token) {
  return req({
    method: 'POST',
    url: `/v1/admin/users/${id}/credits`,
    headers: authHeaders(as),
    payload: { credits },
  });
}

async function adminBan(id: string, as: string = token) {
  // No body needed — deliberately not authHeaders() to avoid the same
  // empty-JSON-body rejection noted on logout-all above.
  return req({ method: 'POST', url: `/v1/admin/users/${id}/ban`, headers: { Authorization: `Bearer ${as}` } });
}

async function adminUnflag(jobId: string, as: string = token) {
  return req({
    method: 'POST',
    url: `/v1/admin/jobs/${jobId}/unflag`,
    headers: { Authorization: `Bearer ${as}` },
  });
}

async function adminFlaggedJobs(as: string = token) {
  return req({ method: 'GET', url: '/v1/admin/jobs/flagged', headers: authHeaders(as) });
}

async function adminJobReports(jobId: string, as: string = token) {
  return req({ method: 'GET', url: `/v1/admin/jobs/${jobId}/reports`, headers: authHeaders(as) });
}

async function adminAuditLog(as: string = token) {
  return req({ method: 'GET', url: '/v1/admin/audit-log', headers: authHeaders(as) });
}

async function adminStats(as: string = token) {
  return req({ method: 'GET', url: '/v1/admin/stats', headers: authHeaders(as) });
}

beforeEach(async () => {
  await resetDatabase();
  await createUser(TEST_USER_ID, 'test@example.com', 100);
  token = tokenFor(TEST_USER_ID);
});

describe('authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await req({ method: 'GET', url: '/v1/me' });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed token', async () => {
    const res = await me('not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('rejects a validly-signed token with no id claim (regression: used to 500)', async () => {
    const res = await me(tokenFor(null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid token' });
  });

  it('rejects an expired token', async () => {
    const expired = tokenFor(TEST_USER_ID, {
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    expect((await me(expired)).status).toBe(401);
  });

  it('rejects a banned user with 403', async () => {
    await DB.prepare('UPDATE users SET is_banned = true WHERE id = ?').bind(TEST_USER_ID).run();
    expect((await me()).status).toBe(403);
  });

  it('rejects a token whose token_version no longer matches (revoked by logout-all)', async () => {
    await DB.prepare('UPDATE users SET token_version = 1 WHERE id = ?').bind(TEST_USER_ID).run();
    // `token` was signed back in beforeEach, with the implicit tv 0.
    expect((await me()).status).toBe(401);
  });
});

describe('push validation', () => {
  it('rejects a malformed JSON body with 400, not 500', async () => {
    const res = await req({
      method: 'POST',
      url: '/v1/jobs/push',
      headers: authHeaders(token),
      payload: '{not json' as any,
    });
    expect(res.status).toBe(400);
  });

  it('rejects payloads over 1000 jobs', async () => {
    const res = await push({ jobs: Array.from({ length: 1001 }, (_, i) => job(i)) });
    expect(res.status).toBe(413);
  });

  it('does not mint credits for fabricated non-URL strings', async () => {
    const res = await push({
      jobs: [
        job(1, { url: 'junk1' }),
        job(2, { url: 'not-a-url-at-all' }),
        job(3, { url: '   ' }),
        job(4, { url: 'ftp://example.com/x' }),
        job(5, { url: 'https://nodot/x' }),
      ],
    });
    const body = (await res.json()) as any;
    expect(body.credits_earned).toBe(0);
    expect(body.invalid_skipped).toBe(5);
  });

  it('skips oversized fields instead of storing them', async () => {
    const res = await push({ jobs: [job(1, { title: 'T'.repeat(50_000) })] });
    const body = (await res.json()) as any;
    expect(body.credits_earned).toBe(0);
    expect(body.invalid_skipped).toBe(1);
  });

  it('accepts valid jobs and awards one credit each', async () => {
    const res = await push({ jobs: [job(1), job(2), job(3)] });
    const body = (await res.json()) as any;
    expect(body.credits_earned).toBe(3);
    expect(body.invalid_skipped).toBe(0);
    expect(((await (await me()).json()) as any).current_credits).toBe(103);
  });

  it('awards credit only once for a duplicate URL', async () => {
    await push({ jobs: [job(1)] });
    const body = (await (await push({ jobs: [job(1)] })).json()) as any;
    expect(body.credits_earned).toBe(0);
  });

  it('keeps valid jobs in a batch that also contains invalid ones', async () => {
    const body = (await (
      await push({ jobs: [job(1), { title: 'no company or url' }, job(2)] })
    ).json()) as any;
    expect(body.credits_earned).toBe(2);
    expect(body.invalid_skipped).toBe(1);
  });
});

describe('push daily credit cap', () => {
  it('stops minting credits past the daily cap but still stores the jobs', async () => {
    // Cap is 500; pretend 499 have already been earned today.
    const today = new Date().toISOString().split('T')[0];
    await DB.prepare('UPDATE users SET pushed_today = 499, last_push_date = ? WHERE id = ?')
      .bind(today, TEST_USER_ID)
      .run();

    const body = (await (await push({ jobs: [job(1), job(2), job(3)] })).json()) as any;
    expect(body.credits_earned).toBe(1);
    expect(body.jobs_accepted).toBe(3);
    expect(body.warning).toMatch(/cap/i);

    const stored = await DB.prepare('SELECT COUNT(*)::int AS n FROM jobs').first<{ n: number }>();
    expect(stored?.n).toBe(3);
  });

  it('resets the cap on a new day', async () => {
    await DB.prepare(
      "UPDATE users SET pushed_today = 500, last_push_date = '2000-01-01' WHERE id = ?"
    )
      .bind(TEST_USER_ID)
      .run();
    const body = (await (await push({ jobs: [job(1)] })).json()) as any;
    expect(body.credits_earned).toBe(1);
  });
});

describe('pull economy', () => {
  it('rejects a non-numeric limit with 400, not 500', async () => {
    expect((await pull('abc')).status).toBe(400);
  });

  it('deducts exactly one credit per job returned', async () => {
    await push({ jobs: [job(1), job(2)] });
    const before = ((await (await me()).json()) as any).current_credits;

    const body = (await (await pull(2)).json()) as any;
    expect(body.jobs).toHaveLength(2);
    expect(body.deducted).toBe(2);

    const after = ((await (await me()).json()) as any).current_credits;
    expect(after).toBe(before - 2);
  });

  it('never serves the same job to the same user twice', async () => {
    await push({ jobs: [job(1), job(2)] });
    const first = (await (await pull(10)).json()) as any;
    const second = (await (await pull(10)).json()) as any;

    expect(first.jobs).toHaveLength(2);
    expect(second.jobs).toHaveLength(0);
  });

  it('refunds credits when the pool has fewer jobs than requested', async () => {
    await push({ jobs: [job(1)] });
    const before = ((await (await me()).json()) as any).current_credits;

    const body = (await (await pull(50)).json()) as any;
    expect(body.jobs).toHaveLength(1);
    expect(body.deducted).toBe(1);

    const after = ((await (await me()).json()) as any).current_credits;
    expect(after).toBe(before - 1);
  });

  it('charges nothing when no jobs are available', async () => {
    const before = ((await (await me()).json()) as any).current_credits;
    const body = (await (await pull(10)).json()) as any;
    expect(body.jobs).toHaveLength(0);
    expect(body.deducted).toBe(0);
    expect(((await (await me()).json()) as any).current_credits).toBe(before);
  });

  it('falls back to the free daily quota at zero credits', async () => {
    await push({ jobs: [job(1)] });
    await DB.prepare('UPDATE users SET current_credits = 0 WHERE id = ?').bind(TEST_USER_ID).run();

    const body = (await (await pull(1)).json()) as any;
    expect(body.quota_used).toBe(1);
    expect(body.deducted).toBe(0);
  });

  it('blocks once the free daily quota is exhausted', async () => {
    const today = new Date().toISOString().split('T')[0];
    await DB.prepare(
      'UPDATE users SET current_credits = 0, pulled_today = 50, last_pull_date = ? WHERE id = ?'
    )
      .bind(today, TEST_USER_ID)
      .run();

    const res = await pull(1);
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/quota/i);
  });

  it('never lets concurrent pulls overspend a credit balance', async () => {
    await push({ jobs: Array.from({ length: 10 }, (_, i) => job(i)) });
    await DB.prepare('UPDATE users SET current_credits = 3 WHERE id = ?').bind(TEST_USER_ID).run();

    const results = await Promise.all(Array.from({ length: 6 }, () => pull(1)));
    const bodies = (await Promise.all(results.map((r) => r.json()))) as any[];
    const totalDeducted = bodies.reduce((sum, b) => sum + (b.deducted ?? 0), 0);

    expect(totalDeducted).toBeLessThanOrEqual(3);
    const credits = ((await (await me()).json()) as any).current_credits;
    expect(credits).toBeGreaterThanOrEqual(0);
  });

  it('never delivers the same job to two concurrent pulls', async () => {
    await push({ jobs: Array.from({ length: 10 }, (_, i) => job(i)) });

    const results = await Promise.all(Array.from({ length: 5 }, () => pull(2)));
    const bodies = (await Promise.all(results.map((r) => r.json()))) as any[];
    const ids = bodies.flatMap((b) => (b.jobs ?? []).map((j: any) => j.id));

    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('staleness', () => {
    async function ageJob(days: number): Promise<string> {
      await push({ jobs: [job(1)] });
      const row = await DB.prepare('SELECT id FROM jobs LIMIT 1').first<{ id: string }>();
      await DB.prepare("UPDATE jobs SET created_at = NOW() - (INTERVAL '1 day' * ?) WHERE id = ?")
        .bind(days, row!.id)
        .run();
      return row!.id;
    }

    it('excludes jobs older than the cutoff by default', async () => {
      await ageJob(61);
      const body = (await (await pull(10)).json()) as any;
      expect(body.jobs).toHaveLength(0);
    });

    it('includes stale jobs with ?include_stale=true', async () => {
      const staleId = await ageJob(61);
      const body = (await (await req({ method: 'GET', url: '/v1/jobs/pull?limit=10&include_stale=true', headers: authHeaders(token) })).json()) as any;
      expect(body.jobs.map((j: any) => j.id)).toContain(staleId);
    });

    it('does not exclude a job just under the cutoff', async () => {
      await ageJob(59);
      const body = (await (await pull(10)).json()) as any;
      expect(body.jobs).toHaveLength(1);
    });
  });
});

describe('community reporting', () => {
  async function seedPulledJob(): Promise<string> {
    await push({ jobs: [job(1)] });
    const body = (await (await pull(1)).json()) as any;
    return body.jobs[0].id;
  }

  it('refuses to report a job the user never pulled', async () => {
    await push({ jobs: [job(1)] });
    const row = await DB.prepare('SELECT id FROM jobs LIMIT 1').first<{ id: string }>();
    const res = await report(row!.id);
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown job', async () => {
    expect((await report('11111111-2222-3333-4444-555555555555')).status).toBe(404);
  });

  it('counts only one report per user', async () => {
    const jobId = await seedPulledJob();
    await report(jobId);
    const body = (await (await report(jobId)).json()) as any;
    expect(body.message).toMatch(/already reported/i);

    const count = await DB.prepare('SELECT COUNT(*)::int AS n FROM job_reports').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('does not flag a job below the report threshold', async () => {
    const jobId = await seedPulledJob();
    const body = (await (await report(jobId)).json()) as any;
    expect(body.job_flagged).toBe(false);
  });

  it('flags a job once enough distinct users report it, and withdraws it', async () => {
    const jobId = await seedPulledJob();
    await report(jobId);

    // Two more distinct users pull the same job, then report it.
    for (let i = 0; i < 2; i++) {
      const id = `3333333${i}-3333-3333-3333-333333333333`;
      await createUser(id, `reporter${i}@example.com`, 100);
      const t = tokenFor(id);
      await pull(1, t);
      await report(jobId, t);
    }

    const flagged = await DB.prepare('SELECT is_flagged FROM jobs WHERE id = ?')
      .bind(jobId)
      .first<{ is_flagged: boolean }>();
    expect(flagged?.is_flagged).toBe(true);

    // A fresh user must not be served the flagged job.
    await createUser(OTHER_USER_ID, 'fresh@example.com', 100);
    const freshPull = (await (await pull(10, tokenFor(OTHER_USER_ID))).json()) as any;
    expect(freshPull.jobs).toHaveLength(0);
  });

  it('records a strike against the contributor when a job is flagged', async () => {
    const jobId = await seedPulledJob();
    await report(jobId);
    for (let i = 0; i < 2; i++) {
      const id = `4444444${i}-4444-4444-4444-444444444444`;
      await createUser(id, `r${i}@example.com`, 100);
      const t = tokenFor(id);
      await pull(1, t);
      await report(jobId, t);
    }

    const contributor = await DB.prepare('SELECT flagged_count FROM users WHERE id = ?')
      .bind(TEST_USER_ID)
      .first<{ flagged_count: number }>();
    expect(contributor?.flagged_count).toBe(1);
  });

  it('auto-bans a contributor at the strike threshold', async () => {
    await DB.prepare('UPDATE users SET flagged_count = 4 WHERE id = ?').bind(TEST_USER_ID).run();

    const jobId = await seedPulledJob();
    await report(jobId);
    for (let i = 0; i < 2; i++) {
      const id = `5555555${i}-5555-5555-5555-555555555555`;
      await createUser(id, `b${i}@example.com`, 100);
      const t = tokenFor(id);
      await pull(1, t);
      await report(jobId, t);
    }

    const banned = await DB.prepare('SELECT is_banned FROM users WHERE id = ?')
      .bind(TEST_USER_ID)
      .first<{ is_banned: boolean }>();
    expect(banned?.is_banned).toBe(true);
    expect((await me()).status).toBe(403);
  });
});

describe('SSO identity', () => {
  // Regression coverage for the account-merging bug: login used to match
  // purely on email, so two different real people (or two different
  // providers for one person) whose IdPs both happened to verify the same
  // address were silently merged into one account. Identity is now anchored
  // on (sso_provider, provider_user_id) — see migrations/0001_provider_scoped_identity.sql.

  it('creates separate accounts for the same verified email via different providers', async () => {
    stubFetch((url) => {
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return jsonResponse({
          aud: process.env.GOOGLE_CLIENT_ID,
          email_verified: 'true',
          email: 'shared@example.com',
          sub: 'google-sub-1',
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const googleBody = (await (await login({ idp_token: 'g-token', sso_provider: 'google' })).json()) as any;
    const googleUserId = decodeUserId(googleBody.token);

    stubFetch((url) => {
      if (url === 'https://github.com/login/oauth/access_token') return jsonResponse({ access_token: 'gh-access' });
      if (url === 'https://api.github.com/user') return jsonResponse({ id: 42424242, email: 'shared@example.com' });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const githubBody = (await (await login({ idp_token: 'gh-code', sso_provider: 'github' })).json()) as any;
    const githubUserId = decodeUserId(githubBody.token);

    expect(githubUserId).not.toBe(googleUserId);

    const count = await DB.prepare('SELECT COUNT(*)::int AS n FROM users WHERE email = ?')
      .bind('shared@example.com')
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('reuses the same account on a repeat login from the same provider', async () => {
    stubFetch((url) => {
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return jsonResponse({
          aud: process.env.GOOGLE_CLIENT_ID,
          email_verified: 'true',
          email: 'repeat@example.com',
          sub: 'google-sub-repeat',
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const first = (await (await login({ idp_token: 't1', sso_provider: 'google' })).json()) as any;
    const second = (await (await login({ idp_token: 't2', sso_provider: 'google' })).json()) as any;
    expect(decodeUserId(second.token)).toBe(decodeUserId(first.token));

    const count = await DB.prepare('SELECT COUNT(*)::int AS n FROM users WHERE provider_user_id = ?')
      .bind('google-sub-repeat')
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('backfills provider_user_id for a pre-migration account on its next login, preserving history', async () => {
    // Shape of a row the old email-only login logic would have produced.
    // A fresh id — TEST_USER_ID already exists from beforeEach and inserting
    // it again would violate the primary key.
    const legacyId = '66666666-6666-6666-6666-666666666666';
    await createUser(legacyId, 'legacy@example.com', 77, {
      sso_provider: 'google',
      provider_user_id: null,
    });

    stubFetch((url) => {
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return jsonResponse({
          aud: process.env.GOOGLE_CLIENT_ID,
          email_verified: 'true',
          email: 'legacy@example.com',
          sub: 'google-sub-legacy',
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const body = (await (await login({ idp_token: 't', sso_provider: 'google' })).json()) as any;
    expect(decodeUserId(body.token)).toBe(legacyId);

    const row = await DB.prepare('SELECT provider_user_id, current_credits FROM users WHERE id = ?')
      .bind(legacyId)
      .first<{ provider_user_id: string; current_credits: number }>();
    expect(row?.provider_user_id).toBe('google-sub-legacy');
    expect(row?.current_credits).toBe(77);
  });

  it('fails fast with 500 on a missing GitHub secret, matching the existing Google check', async () => {
    const savedSecret = process.env.GITHUB_CLIENT_SECRET;
    delete process.env.GITHUB_CLIENT_SECRET;
    try {
      const res = await login({ idp_token: 'code', sso_provider: 'github' });
      expect(res.status).toBe(500);
      expect(((await res.json()) as any).error).toMatch(/GITHUB_CLIENT/);
    } finally {
      process.env.GITHUB_CLIENT_SECRET = savedSecret;
    }
  });
});

describe('logout-all', () => {
  it('invalidates the token used to call it', async () => {
    expect((await logoutAll()).status).toBe(200);
    expect((await me()).status).toBe(401);
  });

  it('does not affect a token minted after the logout', async () => {
    await logoutAll();
    const row = await DB.prepare('SELECT token_version FROM users WHERE id = ?')
      .bind(TEST_USER_ID)
      .first<{ token_version: number }>();
    const freshToken = tokenFor(TEST_USER_ID, { tv: row?.token_version });
    expect((await me(freshToken)).status).toBe(200);
  });
});

describe('rate limiting', () => {
  // Distinct per-test IPs so these tests can't interfere with each other via
  // the shared Redis counter.
  it('blocks once the per-IP budget (100/60s) is exceeded', async () => {
    const ip = '203.0.113.7';
    let lastStatus = 200;
    for (let i = 0; i < 101; i++) {
      lastStatus = (await req({ method: 'GET', url: '/health', headers: { 'x-trusted-client-ip': ip } })).status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('is not applied when the trusted IP header is absent', async () => {
    let sawLimit = false;
    for (let i = 0; i < 105; i++) {
      if ((await req({ method: 'GET', url: '/health' })).status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(false);
  });

  it('cannot be bypassed by spoofing x-forwarded-for once the trusted IP header is limited', async () => {
    const ip = '203.0.113.9';
    for (let i = 0; i < 101; i++) {
      await req({ method: 'GET', url: '/health', headers: { 'x-trusted-client-ip': ip } });
    }
    const res = await req({
      method: 'GET',
      url: '/health',
      headers: { 'x-trusted-client-ip': ip, 'x-forwarded-for': '1.2.3.4' },
    });
    expect(res.status).toBe(429);
  });
});

describe('health', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await req({ method: 'GET', url: '/health' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', database: 'ok' });
  });
});

describe('root', () => {
  it('returns API metadata unauthenticated, instead of a bare 404', async () => {
    const res = await req({ method: 'GET', url: '/' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe('CareerAgent API');
    expect(body.health).toBe('/health');
  });
});

describe('account export and deletion', () => {
  it('exports the profile plus contributed/pulled/reported data', async () => {
    await push({ jobs: [job(1)] });
    const jobId = ((await (await pull(1)).json()) as any).jobs[0].id;
    await report(jobId);

    const body = (await (await exportMe()).json()) as any;
    expect(body.profile.id).toBe(TEST_USER_ID);
    expect(body.jobs_contributed).toHaveLength(1);
    expect(body.jobs_pulled).toHaveLength(1);
    expect(body.reports_filed).toHaveLength(1);
  });

  it('refuses to delete without explicit confirmation', async () => {
    expect((await deleteMe(null)).status).toBe(400);
    expect((await me()).status).toBe(200); // account still exists
  });

  it('deletes the account and invalidates its tokens', async () => {
    expect((await deleteMe()).status).toBe(200);
    expect((await me()).status).toBe(401);

    const row = await DB.prepare('SELECT id FROM users WHERE id = ?').bind(TEST_USER_ID).first();
    expect(row).toBeNull();
  });

  it('detaches (does not delete) jobs the account contributed', async () => {
    await push({ jobs: [job(1)] });
    const stored = await DB.prepare('SELECT id FROM jobs LIMIT 1').first<{ id: string }>();

    await deleteMe();

    const job2 = await DB.prepare('SELECT scraped_by_user_id FROM jobs WHERE id = ?')
      .bind(stored!.id)
      .first<{ scraped_by_user_id: string | null }>();
    expect(job2).not.toBeNull();
    expect(job2?.scraped_by_user_id).toBeNull();
  });

  it('still lets a job whose contributor deleted their account be reported to a flag (no crash)', async () => {
    await push({ jobs: [job(1)] });
    const jobId = ((await (await pull(1)).json()) as any).jobs[0].id;

    // The contributor (TEST_USER_ID, also the puller here) deletes their
    // account after pulling but before anyone reports.
    await deleteMe();

    // Three fresh users report the now-orphaned job.
    for (let i = 0; i < 3; i++) {
      const id = `7777777${i}-7777-7777-7777-777777777777`;
      await createUser(id, `orphan-reporter${i}@example.com`, 100);
      const t = tokenFor(id);
      await pull(1, t);
      const res = await report(jobId, t);
      expect(res.status).toBe(200);
    }

    const flagged = await DB.prepare('SELECT is_flagged FROM jobs WHERE id = ?')
      .bind(jobId)
      .first<{ is_flagged: boolean }>();
    expect(flagged?.is_flagged).toBe(true);
  });
});

describe('login rate limiting', () => {
  it('applies a tighter, separate budget (20/60s) to /v1/auth/login than the global limit', async () => {
    const ip = '203.0.113.20';
    let lastStatus = 200;
    for (let i = 0; i < 21; i++) {
      lastStatus = (
        await req({
          method: 'POST',
          url: '/v1/auth/login',
          headers: { 'Content-Type': 'application/json', 'x-trusted-client-ip': ip },
          payload: {}, // missing idp_token/sso_provider -> fails validation, never calls out to a real IdP
        })
      ).status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);

    // The global 100/60s budget for this same IP is untouched by the login
    // limiter hitting its own separate bucket.
    const other = await req({ method: 'GET', url: '/health', headers: { 'x-trusted-client-ip': ip } });
    expect(other.status).toBe(200);
  });
});

describe('pull pagination', () => {
  it('reports has_more when more unconsumed jobs remain beyond the batch', async () => {
    await push({ jobs: Array.from({ length: 5 }, (_, i) => job(i)) });
    const body = (await (await pull(2)).json()) as any;
    expect(body.jobs).toHaveLength(2);
    expect(body.has_more).toBe(true);
  });

  it('reports has_more: false once the pool is fully drained, without charging for the lookahead row', async () => {
    await push({ jobs: Array.from({ length: 3 }, (_, i) => job(i)) });
    const before = ((await (await me()).json()) as any).current_credits;

    const body = (await (await pull(3)).json()) as any;
    expect(body.jobs).toHaveLength(3);
    expect(body.has_more).toBe(false);
    expect(body.deducted).toBe(3); // not 4 — the lookahead job was never claimed/charged

    const after = ((await (await me()).json()) as any).current_credits;
    expect(after).toBe(before - 3);

    const pulledCount = await DB.prepare('SELECT COUNT(*)::int AS n FROM pulled_jobs WHERE user_id = ?')
      .bind(TEST_USER_ID)
      .first<{ n: number }>();
    expect(pulledCount?.n).toBe(3);
  });
});

describe('admin API', () => {
  const ADMIN_ID = '88888888-8888-8888-8888-888888888888';
  let adminToken: string;

  beforeEach(async () => {
    await createUser(ADMIN_ID, 'admin@example.com', 0, { is_admin: true });
    adminToken = tokenFor(ADMIN_ID);
  });

  it('404s admin routes for a logged-in non-admin (not 403 — indistinguishable from a typo)', async () => {
    const res = await adminFlaggedJobs(token); // token = TEST_USER_ID, not admin
    expect(res.status).toBe(404);
  });

  it('401s admin routes with no token at all', async () => {
    const res = await req({ method: 'GET', url: '/v1/admin/jobs/flagged' });
    expect(res.status).toBe(401);
  });

  it('looks up accounts by email, including more than one for a merged-provider email', async () => {
    await createUser('99999999-9999-9999-9999-999999999999', 'test@example.com', 5, {
      sso_provider: 'google',
    });
    const body = (await (await adminUsersByEmail('test@example.com', adminToken)).json()) as any;
    expect(body.users).toHaveLength(2);
  });

  it('sets a user\'s credit balance', async () => {
    const res = await adminSetCredits(TEST_USER_ID, 50_000, adminToken);
    expect(res.status).toBe(200);
    expect(((await (await me()).json()) as any).current_credits).toBe(50_000);
  });

  it('rejects an out-of-range credits value', async () => {
    const res = await adminSetCredits(TEST_USER_ID, -1, adminToken);
    expect(res.status).toBe(400);
  });

  it('bans a user', async () => {
    const res = await adminBan(TEST_USER_ID, adminToken);
    expect(res.status).toBe(200);
    expect((await me()).status).toBe(403);
  });

  it('lists and unflags a flagged job', async () => {
    await push({ jobs: [job(1)] });
    const jobId = ((await (await pull(1)).json()) as any).jobs[0].id;
    await report(jobId);
    for (let i = 0; i < 2; i++) {
      const id = `6666666${i}-6666-6666-6666-666666666666`;
      await createUser(id, `f${i}@example.com`, 100);
      const t = tokenFor(id);
      await pull(1, t);
      await report(jobId, t);
    }

    const listed = (await (await adminFlaggedJobs(adminToken)).json()) as any;
    expect(listed.jobs.map((j: any) => j.id)).toContain(jobId);

    const unflagRes = await adminUnflag(jobId, adminToken);
    expect(unflagRes.status).toBe(200);

    const stillListed = (await (await adminFlaggedJobs(adminToken)).json()) as any;
    expect(stillListed.jobs.map((j: any) => j.id)).not.toContain(jobId);
  });

  it('records who reported a job and why', async () => {
    await push({ jobs: [job(1)] });
    const jobId = ((await (await pull(1)).json()) as any).jobs[0].id;
    await report(jobId); // TEST_USER_ID, reason: 'fake' (see the report() helper)

    const body = (await (await adminJobReports(jobId, adminToken)).json()) as any;
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]).toMatchObject({ reporter_user_id: TEST_USER_ID, reason: 'fake' });
  });

  it('404s job-reports for an unknown job', async () => {
    expect((await adminJobReports('11111111-2222-3333-4444-555555555555', adminToken)).status).toBe(404);
  });

  it('logs every admin write to the audit log, attributed to the acting admin', async () => {
    await adminSetCredits(TEST_USER_ID, 500, adminToken);
    await adminBan(TEST_USER_ID, adminToken);

    const body = (await (await adminAuditLog(adminToken)).json()) as any;
    const actions = body.actions.map((a: any) => a.action);
    expect(actions).toContain('set_credits');
    expect(actions).toContain('ban');
    expect(body.actions.every((a: any) => a.admin_email === 'admin@example.com')).toBe(true);
  });

  it('reports aggregate stats', async () => {
    await push({ jobs: [job(1), job(2)] });

    const body = (await (await adminStats(adminToken)).json()) as any;
    // TEST_USER_ID + ADMIN_ID from beforeEach.
    expect(body.total_users).toBe(2);
    expect(body.total_jobs).toBe(2);
    expect(body.top_contributors.find((c: any) => c.email === 'test@example.com')).toMatchObject({
      total_pushed: 2,
    });
  });

  it('counts stale jobs separately, without excluding them from total_jobs', async () => {
    await push({ jobs: [job(1)] });
    const row = await DB.prepare('SELECT id FROM jobs LIMIT 1').first<{ id: string }>();
    await DB.prepare("UPDATE jobs SET created_at = NOW() - INTERVAL '90 days' WHERE id = ?")
      .bind(row!.id)
      .run();

    const body = (await (await adminStats(adminToken)).json()) as any;
    expect(body.total_jobs).toBe(1);
    expect(body.total_stale_jobs).toBe(1);
  });
});
