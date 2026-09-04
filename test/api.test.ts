import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  createUser,
  job,
  resetDatabase,
  TEST_USER_ID,
  tokenFor,
} from './helpers';

const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';

let token: string;

async function push(body: unknown, as: string = token) {
  return SELF.fetch('https://api.test/api/jobs/push', {
    method: 'POST',
    headers: authHeaders(as),
    body: JSON.stringify(body),
  });
}

async function pull(limit: number | string = 10, as: string = token) {
  return SELF.fetch(`https://api.test/api/jobs/pull?limit=${limit}`, {
    headers: authHeaders(as),
  });
}

async function me(as: string = token) {
  return SELF.fetch('https://api.test/api/me', { headers: authHeaders(as) });
}

async function report(jobId: string, as: string = token) {
  return SELF.fetch('https://api.test/api/jobs/report', {
    method: 'POST',
    headers: authHeaders(as),
    body: JSON.stringify({ job_id: jobId, reason: 'fake' }),
  });
}

beforeEach(async () => {
  await resetDatabase();
  await createUser(TEST_USER_ID, 'test@example.com', 100);
  token = await tokenFor(TEST_USER_ID);
});

describe('authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await SELF.fetch('https://api.test/api/me');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed token', async () => {
    const res = await me('not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('rejects a validly-signed token with no id claim (regression: used to 500)', async () => {
    const res = await me(await tokenFor(null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid token' });
  });

  it('rejects an expired token', async () => {
    const expired = await tokenFor(TEST_USER_ID, {
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    expect((await me(expired)).status).toBe(401);
  });

  it('rejects a banned user with 403', async () => {
    await env.DB.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').bind(TEST_USER_ID).run();
    expect((await me()).status).toBe(403);
  });
});

describe('push validation', () => {
  it('rejects a malformed JSON body with 400, not 500', async () => {
    const res = await SELF.fetch('https://api.test/api/jobs/push', {
      method: 'POST',
      headers: authHeaders(token),
      body: '{not json',
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
    await env.DB.prepare('UPDATE users SET pushed_today = 499, last_push_date = ? WHERE id = ?')
      .bind(today, TEST_USER_ID)
      .run();

    const body = (await (await push({ jobs: [job(1), job(2), job(3)] })).json()) as any;
    expect(body.credits_earned).toBe(1);
    expect(body.jobs_accepted).toBe(3);
    expect(body.warning).toMatch(/cap/i);

    const stored = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>();
    expect(stored?.n).toBe(3);
  });

  it('resets the cap on a new day', async () => {
    await env.DB.prepare(
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
    await env.DB.prepare('UPDATE users SET current_credits = 0 WHERE id = ?')
      .bind(TEST_USER_ID)
      .run();

    const body = (await (await pull(1)).json()) as any;
    expect(body.quota_used).toBe(1);
    expect(body.deducted).toBe(0);
  });

  it('blocks with 403 once the free daily quota is exhausted', async () => {
    const today = new Date().toISOString().split('T')[0];
    await env.DB.prepare(
      'UPDATE users SET current_credits = 0, pulled_today = 50, last_pull_date = ? WHERE id = ?'
    )
      .bind(today, TEST_USER_ID)
      .run();

    expect((await pull(1)).status).toBe(403);
  });

  it('never lets concurrent pulls overspend a credit balance', async () => {
    await push({ jobs: Array.from({ length: 10 }, (_, i) => job(i)) });
    await env.DB.prepare('UPDATE users SET current_credits = 3 WHERE id = ?')
      .bind(TEST_USER_ID)
      .run();

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
});

describe('community reporting', () => {
  async function seedPulledJob(): Promise<string> {
    await push({ jobs: [job(1)] });
    const body = (await (await pull(1)).json()) as any;
    return body.jobs[0].id;
  }

  it('refuses to report a job the user never pulled', async () => {
    await push({ jobs: [job(1)] });
    const row = await env.DB.prepare('SELECT id FROM jobs LIMIT 1').first<{ id: string }>();
    const res = await report(row!.id);
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown job', async () => {
    expect((await report('no-such-job')).status).toBe(404);
  });

  it('counts only one report per user', async () => {
    const jobId = await seedPulledJob();
    await report(jobId);
    const body = (await (await report(jobId)).json()) as any;
    expect(body.message).toMatch(/already reported/i);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM job_reports').first<{ n: number }>();
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
      const t = await tokenFor(id);
      await pull(1, t);
      await report(jobId, t);
    }

    const flagged = await env.DB.prepare('SELECT is_flagged FROM jobs WHERE id = ?')
      .bind(jobId)
      .first<{ is_flagged: number }>();
    expect(flagged?.is_flagged).toBe(1);

    // A fresh user must not be served the flagged job.
    await createUser(OTHER_USER_ID, 'fresh@example.com', 100);
    const freshPull = (await (await pull(10, await tokenFor(OTHER_USER_ID))).json()) as any;
    expect(freshPull.jobs).toHaveLength(0);
  });

  it('records a strike against the contributor when a job is flagged', async () => {
    const jobId = await seedPulledJob();
    await report(jobId);
    for (let i = 0; i < 2; i++) {
      const id = `4444444${i}-4444-4444-4444-444444444444`;
      await createUser(id, `r${i}@example.com`, 100);
      const t = await tokenFor(id);
      await pull(1, t);
      await report(jobId, t);
    }

    const contributor = await env.DB.prepare('SELECT flagged_count FROM users WHERE id = ?')
      .bind(TEST_USER_ID)
      .first<{ flagged_count: number }>();
    expect(contributor?.flagged_count).toBe(1);
  });

  it('auto-bans a contributor at the strike threshold', async () => {
    await env.DB.prepare('UPDATE users SET flagged_count = 4 WHERE id = ?')
      .bind(TEST_USER_ID)
      .run();

    const jobId = await seedPulledJob();
    await report(jobId);
    for (let i = 0; i < 2; i++) {
      const id = `5555555${i}-5555-5555-5555-555555555555`;
      await createUser(id, `b${i}@example.com`, 100);
      const t = await tokenFor(id);
      await pull(1, t);
      await report(jobId, t);
    }

    const banned = await env.DB.prepare('SELECT is_banned FROM users WHERE id = ?')
      .bind(TEST_USER_ID)
      .first<{ is_banned: number }>();
    expect(banned?.is_banned).toBe(1);
    expect((await me()).status).toBe(403);
  });
});

describe('health', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await SELF.fetch('https://api.test/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', database: 'ok' });
  });
});
