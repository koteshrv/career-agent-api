# Database Query Reference

Reference SQL for inspecting and maintaining the `career-agent-db` D1 database directly —
useful for debugging the economy (credits, quotas, bans) or the job pool without going
through the API. Two ways to run these: the `wrangler` CLI, or the Cloudflare Dashboard's
D1 Console. Both are covered below, followed by a query cookbook for all four tables.

**Read `schema.sql`'s header comment before touching production schema.** It's a
destructive DROP-and-recreate file — see the "Cautions" section at the bottom of this doc.

## Running queries

### Option A — Wrangler CLI

Run from the repo root. `--remote` hits the real production database; drop it to hit the
local dev D1 instance instead (what `npm run dev` / `wrangler dev` uses).

**Production** (needs `wrangler.prod.toml`, which holds the real `database_id` — the
checked-in `wrangler.toml` only has a placeholder):
```bash
npx wrangler d1 execute career-agent-db --remote --config wrangler.prod.toml \
  --command "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 20;"
```

**Local dev:**
```bash
npx wrangler d1 execute career-agent-db --local \
  --command "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 20;"
```

For a longer query, use `--file=./some-query.sql` instead of `--command`.

### Option B — Cloudflare Dashboard Console

For quick ad-hoc queries against production without a terminal:

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **D1**.
2. Select **career-agent-db**.
3. Open the **Console** tab.
4. Paste raw SQL (no `wrangler`/CLI wrapper — just the statement) and run it.

This always runs against the production database — there's no "local" equivalent in the
dashboard. Treat every query you run here as live.

## Schema reference

| Table | Purpose |
|---|---|
| `users` | One row per SSO identity. Credit balance, daily push/pull counters, ban state. |
| `jobs` | The shared job pool. Deduplicated by `url`; `is_flagged` withdraws a job from `/api/jobs/pull` once reported enough times. |
| `pulled_jobs` | `(user_id, job_id)` pairs — which jobs a user has already received, so pulls advance through the pool instead of repeating. |
| `job_reports` | `(job_id, reporter_user_id)` pairs — one report per user per job; `COUNT(*)` per `job_id` drives the flagging threshold. |

Current economy constants (`src/index.ts`, top of the routes section): signup bonus 50
credits, daily free pull quota 50/day, daily push-credit cap 500/day, 3 reports flag a job,
5 flagged jobs auto-bans the contributor.

```sql
-- users
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    sso_provider TEXT NOT NULL,
    current_credits INTEGER DEFAULT 50,
    total_pushed INTEGER DEFAULT 0,
    total_pulled INTEGER DEFAULT 0,
    pulled_today INTEGER DEFAULT 0,
    last_pull_date DATE,
    pushed_today INTEGER DEFAULT 0,
    last_push_date DATE,
    flagged_count INTEGER DEFAULT 0,
    is_banned BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- jobs
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT,
    url TEXT UNIQUE NOT NULL,
    scraped_by_user_id TEXT NOT NULL,
    is_flagged BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Full definitions, including `pulled_jobs` and `job_reports`, are in [schema.sql](schema.sql).

---

## Query cookbook — `jobs`

```sql
-- Most recently pushed jobs
SELECT id, company, title, location, url, created_at
FROM jobs ORDER BY created_at DESC LIMIT 20;

-- Total job count, and how many are currently flagged
SELECT COUNT(*) AS total, SUM(is_flagged) AS flagged FROM jobs;

-- Flagged jobs (withdrawn from circulation) with their contributor
SELECT j.id, j.company, j.title, j.url, u.email AS pushed_by
FROM jobs j JOIN users u ON u.id = j.scraped_by_user_id
WHERE j.is_flagged = 1;

-- Jobs pushed by a specific user
SELECT j.id, j.company, j.title, j.url, j.created_at
FROM jobs j JOIN users u ON u.id = j.scraped_by_user_id
WHERE u.email = 'someone@example.com'
ORDER BY j.created_at DESC;

-- Search by company or URL substring
SELECT id, company, title, url FROM jobs
WHERE company LIKE '%Acme%' OR url LIKE '%acme.com%';

-- How many jobs each company has in the pool
SELECT company, COUNT(*) AS n FROM jobs GROUP BY company ORDER BY n DESC LIMIT 20;

-- Duplicate-looking titles at the same company (sanity check on push validation)
SELECT company, title, COUNT(*) AS n FROM jobs
GROUP BY company, title HAVING n > 1;

-- Delete a specific bad/test job (irreversible — see Cautions)
DELETE FROM jobs WHERE id = 'JOB_ID_HERE';
```

## Query cookbook — `users`

```sql
-- A specific user's full economy state
SELECT * FROM users WHERE email = 'someone@example.com';

-- All users, most credits first
SELECT email, current_credits, total_pushed, total_pulled, flagged_count, is_banned
FROM users ORDER BY current_credits DESC;

-- Top contributors (most jobs pushed)
SELECT email, total_pushed, total_pulled, current_credits
FROM users ORDER BY total_pushed DESC LIMIT 20;

-- Banned users
SELECT email, flagged_count, is_banned FROM users WHERE is_banned = 1;

-- Users one strike away from auto-ban (FLAGS_TO_BAN_USER = 5)
SELECT email, flagged_count FROM users WHERE flagged_count >= 4 AND is_banned = 0;

-- Everyone who pushed or pulled today (UTC)
SELECT email, pushed_today, last_push_date, pulled_today, last_pull_date
FROM users
WHERE last_push_date = date('now') OR last_pull_date = date('now');

-- Manually adjust a user's credit balance (support/admin correction)
UPDATE users SET current_credits = current_credits + 100 WHERE email = 'someone@example.com';

-- Ban / unban a user by hand
UPDATE users SET is_banned = 1 WHERE email = 'someone@example.com';
UPDATE users SET is_banned = 0 WHERE email = 'someone@example.com';

-- Reset a user's daily counters early (e.g. to un-stick a support case)
UPDATE users SET pushed_today = 0, pulled_today = 0 WHERE email = 'someone@example.com';
```

## Query cookbook — `pulled_jobs`

```sql
-- What has a specific user already pulled?
SELECT j.company, j.title, j.url, p.pulled_at
FROM pulled_jobs p JOIN jobs j ON j.id = p.job_id
JOIN users u ON u.id = p.user_id
WHERE u.email = 'someone@example.com'
ORDER BY p.pulled_at DESC;

-- How many distinct users have pulled a given job?
SELECT COUNT(*) FROM pulled_jobs WHERE job_id = 'JOB_ID_HERE';

-- Most-pulled jobs overall
SELECT j.company, j.title, COUNT(*) AS pull_count
FROM pulled_jobs p JOIN jobs j ON j.id = p.job_id
GROUP BY p.job_id ORDER BY pull_count DESC LIMIT 20;
```

## Query cookbook — `job_reports`

```sql
-- All reports on a specific job
SELECT r.reason, r.created_at, u.email AS reported_by
FROM job_reports r JOIN users u ON u.id = r.reporter_user_id
WHERE r.job_id = 'JOB_ID_HERE';

-- Report count per job, worst first (3 distinct reports flags it)
SELECT job_id, COUNT(*) AS report_count
FROM job_reports GROUP BY job_id ORDER BY report_count DESC LIMIT 20;

-- Jobs with reports that haven't crossed the flag threshold yet
SELECT r.job_id, j.company, j.title, COUNT(*) AS report_count
FROM job_reports r JOIN jobs j ON j.id = r.job_id
WHERE j.is_flagged = 0
GROUP BY r.job_id
HAVING report_count > 0
ORDER BY report_count DESC;
```

---

## Cautions

- **`--remote` (CLI) and the Dashboard Console both hit the live production database.**
  There's no confirmation prompt on `UPDATE`/`DELETE` — a typo'd `WHERE` clause runs as
  written. Test destructive queries with `--local` first if there's any doubt.
- **`schema.sql` is destructive.** Running it against `--remote` drops and recreates every
  table, erasing all users/jobs/history. It's meant for first-time setup only — see the
  comment block at the top of [schema.sql](schema.sql) for how to apply a schema change to
  production without wiping it.
- **No soft deletes.** `DELETE FROM jobs ...` / `DELETE FROM users ...` are permanent; there
  is no trash/undo. Prefer `UPDATE ... SET is_flagged = 1` or `is_banned = 1` over deleting
  rows when the goal is just to stop something from being served.
- Deleting a row from `users` or `jobs` that's referenced by `pulled_jobs`/`job_reports`
  will leave orphaned rows behind (no `ON DELETE CASCADE` in the schema) — clean those up
  explicitly if you delete a user or job by hand.
