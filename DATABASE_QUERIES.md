# Career Agent API - Database Queries

This document contains useful SQL queries for administering, testing, and debugging the `career-agent-api` PostgreSQL database.

**Most moderation actions below now have an authenticated `/v1/admin/*` endpoint** (see `openapi.yaml`) — prefer those over raw SQL where one exists, since they're audited, validated, and don't need direct database access. The queries stay here for the one thing the API can't do (bootstrapping the very first admin account) and as an emergency fallback if the API itself is unreachable.

## 👥 Agent Management & Moderation

### Bootstrap the first admin account
There's no self-service way to become an admin — this is the one operation with no API equivalent, by design.
```sql
UPDATE agents SET is_admin = true WHERE id = 'agent_uuid_here';
```
After this, use `POST /v1/admin/agents/:id/credits`, `/ban`, `/unban`, and `GET /v1/admin/jobs/flagged` + `POST /v1/admin/jobs/:id/unflag` instead of the raw SQL below.

### Grant a agent 50,000 API Credits (Admin Bypass)
Prefer `POST /v1/admin/agents/:id/credits` with `{"credits": 50000}`.
```sql
UPDATE agents 
SET current_credits = 50000 
WHERE id = 'agent_uuid_here';
```

### Reset a agent's Daily Free Quota
Useful when you want to bypass the daily 50-job limit during local testing without changing the date.
```sql
UPDATE agents 
SET pulled_today = 0 
WHERE id = 'agent_uuid_here';
```

### View Top Contributors (Give-to-Get Economy)
See who is uploading the most jobs to the crowdsourced database.
```sql
SELECT id as agent_id, total_pushed, current_credits, is_banned 
FROM agents 
ORDER BY total_pushed DESC 
LIMIT 10;
```

### Manually Ban or Unban a Agent
Prefer `POST /v1/admin/agents/:id/ban` / `/unban`.
```sql
-- Ban
UPDATE agents SET is_banned = true WHERE id = 'spammer_uuid_here';

-- Unban
UPDATE agents SET is_banned = false WHERE id = 'innocent_uuid_here';
```

---

## 💼 Job Data & Analytics

### View Recently Flagged Jobs
Jobs get flagged automatically when multiple agents report them (e.g. broken links, fake listings).
```sql
SELECT id, company, title, is_flagged, created_at 
FROM jobs 
WHERE is_flagged = true 
ORDER BY created_at DESC;
```

### Un-flag a False Positive Job
If a job was maliciously reported, you can restore it to the global pool. Prefer `POST /v1/admin/jobs/:id/unflag` (and `GET /v1/admin/jobs/flagged` to find it).
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
    (SELECT COUNT(*) FROM agents) as total_agents,
    (SELECT COUNT(*) FROM jobs) as total_jobs,
    (SELECT COUNT(*) FROM job_reports) as total_reports;
```

---

## 🚨 System Integrity & Debugging

### Find Jobs Whose Contributor Deleted Their Account
`scraped_by_agent_id` is nullable and set null (not cascade-deleted) when a contributor uses self-service account deletion (`DELETE /v1/me`) — the job itself is kept, since it's a shared resource other agents may already rely on. This is expected/normal, not data corruption; use it to see how many jobs currently have no attributed contributor.
```sql
SELECT * FROM jobs 
WHERE scraped_by_agent_id IS NULL;
```

### Find Who Uploaded a Specific Job
If you find a spam job in the system, you can trace it back to the exact agent who pushed it.
```sql
SELECT  u.id as agent_id, j.title, j.company 
FROM jobs j
JOIN agents u ON j.scraped_by_agent_id = u.id
WHERE j.id = 'job_id_here';
```

### Analyze Why a Job Was Reported
See the exact reasons agents submitted when reporting a specific job (e.g., "Expired", "Fake").
```sql
SELECT r.reason, r.reported_at, u.id as reporter_agent_id
FROM job_reports r
JOIN agents u ON r.reporter_agent_id = u.id
WHERE r.job_id = 'job_id_here';
```
