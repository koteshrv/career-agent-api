# Career Agent API - Database Queries

This document contains useful SQL queries for administering, testing, and debugging the `career-agent-api` PostgreSQL database.

**Most moderation actions below now have an authenticated `/api/admin/*` endpoint** (see `openapi.yaml`) — prefer those over raw SQL where one exists, since they're audited, validated, and don't need direct database access. The queries stay here for the one thing the API can't do (bootstrapping the very first admin account) and as an emergency fallback if the API itself is unreachable.

## 👥 User Management & Moderation

### Bootstrap the first admin account
There's no self-service way to become an admin — this is the one operation with no API equivalent, by design.
```sql
UPDATE users SET is_admin = true WHERE email = 'you@example.com';
```
After this, use `POST /api/admin/users/:id/credits`, `/ban`, `/unban`, and `GET /api/admin/jobs/flagged` + `POST /api/admin/jobs/:id/unflag` instead of the raw SQL below.

### Grant a user 50,000 API Credits (Admin Bypass)
Prefer `POST /api/admin/users/:id/credits` with `{"credits": 50000}`.
```sql
UPDATE users 
SET current_credits = 50000 
WHERE email = 'user@example.com';
```

### Reset a user's Daily Free Quota
Useful when you want to bypass the daily 50-job limit during local testing without changing the date.
```sql
UPDATE users 
SET pulled_today = 0 
WHERE email = 'user@example.com';
```

### View Top Contributors (Give-to-Get Economy)
See who is uploading the most jobs to the crowdsourced database.
```sql
SELECT email, total_pushed, current_credits, is_banned 
FROM users 
ORDER BY total_pushed DESC 
LIMIT 10;
```

### Manually Ban or Unban a User
Prefer `POST /api/admin/users/:id/ban` / `/unban`.
```sql
-- Ban
UPDATE users SET is_banned = true WHERE email = 'spammer@example.com';

-- Unban
UPDATE users SET is_banned = false WHERE email = 'innocent@example.com';
```

---

## 💼 Job Data & Analytics

### View Recently Flagged Jobs
Jobs get flagged automatically when multiple users report them (e.g. broken links, fake listings).
```sql
SELECT id, company, title, is_flagged, created_at 
FROM jobs 
WHERE is_flagged = true 
ORDER BY created_at DESC;
```

### Un-flag a False Positive Job
If a job was maliciously reported, you can restore it to the global pool. Prefer `POST /api/admin/jobs/:id/unflag` (and `GET /api/admin/jobs/flagged` to find it).
```sql
UPDATE jobs SET is_flagged = false WHERE id = 'job_id_here';
```

### Top 10 Most Frequent Companies Scraped
```sql
SELECT company, COUNT(*) as job_count 
FROM jobs 
GROUP BY company 
ORDER BY job_count DESC 
LIMIT 10;
```

### Total System Metrics
Get a quick snapshot of the entire database size.
```sql
SELECT 
    (SELECT COUNT(*) FROM users) as total_users,
    (SELECT COUNT(*) FROM jobs) as total_jobs,
    (SELECT COUNT(*) FROM job_reports) as total_reports;
```

---

## 🚨 System Integrity & Debugging

### Find Jobs Whose Contributor Deleted Their Account
`scraped_by_user_id` is nullable and set null (not cascade-deleted) when a contributor uses self-service account deletion (`DELETE /api/me`) — the job itself is kept, since it's a shared resource other users may already rely on. This is expected/normal, not data corruption; use it to see how many jobs currently have no attributed contributor.
```sql
SELECT * FROM jobs 
WHERE scraped_by_user_id IS NULL;
```

### Find Who Uploaded a Specific Job
If you find a spam job in the system, you can trace it back to the exact user who pushed it.
```sql
SELECT u.email, u.id as user_id, j.title, j.company 
FROM jobs j
JOIN users u ON j.scraped_by_user_id = u.id
WHERE j.id = 'job_id_here';
```

### Analyze Why a Job Was Reported
See the exact reasons users submitted when reporting a specific job (e.g., "Expired", "Fake").
```sql
SELECT r.reason, r.reported_at, u.email as reporter
FROM job_reports r
JOIN users u ON r.reporter_user_id = u.id
WHERE r.job_id = 'job_id_here';
```
