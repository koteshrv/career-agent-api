-- schema.sql
-- Run locally via: npm run db:migrate
-- Run remotely via: npm run db:migrate:remote
--
-- WARNING: this file is destructive — it DROPs and recreates every table on
-- every run. It's meant for first-time setup only. If the production database
-- already has real users/jobs, re-running db:migrate:remote WILL ERASE THEM.
-- To bring an existing production database up to date without wiping it, run
-- only the additive statements below by hand instead of this whole file:
--
--   CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
--   CREATE TABLE IF NOT EXISTS pulled_jobs (
--       user_id TEXT NOT NULL,
--       job_id TEXT NOT NULL,
--       pulled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
--       PRIMARY KEY (user_id, job_id),
--       FOREIGN KEY(user_id) REFERENCES users(id),
--       FOREIGN KEY(job_id) REFERENCES jobs(id)
--   );
--   CREATE INDEX IF NOT EXISTS idx_pulled_jobs_user ON pulled_jobs(user_id);
--   ALTER TABLE users ADD COLUMN pushed_today INTEGER DEFAULT 0;
--   ALTER TABLE users ADD COLUMN last_push_date DATE;
--   ALTER TABLE users ADD COLUMN flagged_count INTEGER DEFAULT 0;
--   ALTER TABLE jobs ADD COLUMN is_flagged BOOLEAN DEFAULT 0;
--   CREATE TABLE IF NOT EXISTS job_reports (
--       job_id TEXT NOT NULL,
--       reporter_user_id TEXT NOT NULL,
--       reason TEXT,
--       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
--       PRIMARY KEY (job_id, reporter_user_id),
--       FOREIGN KEY(job_id) REFERENCES jobs(id),
--       FOREIGN KEY(reporter_user_id) REFERENCES users(id)
--   );
--   CREATE INDEX IF NOT EXISTS idx_job_reports_job ON job_reports(job_id);
--
-- Going forward this project would benefit from numbered incremental migration
-- files instead of one destructive schema.sql; not changed here since that's
-- a bigger structural decision than a bug fix.

DROP TABLE IF EXISTS job_reports;
DROP TABLE IF EXISTS pulled_jobs;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    sso_provider TEXT NOT NULL,
    current_credits INTEGER DEFAULT 50,
    total_pushed INTEGER DEFAULT 0,
    total_pulled INTEGER DEFAULT 0,
    pulled_today INTEGER DEFAULT 0,
    last_pull_date DATE,
    -- Daily push-credit cap tracking (anti credit-farming)
    pushed_today INTEGER DEFAULT 0,
    last_push_date DATE,
    -- Number of this user's jobs that the community has flagged as fake/dead
    flagged_count INTEGER DEFAULT 0,
    is_banned BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT,
    url TEXT UNIQUE NOT NULL,
    scraped_by_user_id TEXT NOT NULL,
    -- Set once enough distinct users report the job; flagged jobs stop being served
    is_flagged BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(scraped_by_user_id) REFERENCES users(id)
);

-- Speeds up the "pull" query's ORDER BY created_at DESC LIMIT ?
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);

-- Tracks which jobs a user has already pulled, so /api/jobs/pull can exclude
-- them and consume the shared feed instead of always returning the same
-- newest N jobs to every caller.
CREATE TABLE pulled_jobs (
    user_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    pulled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, job_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX idx_pulled_jobs_user ON pulled_jobs(user_id);

-- Community quality control: a user who pulled a job can report it as fake or
-- dead. The primary key allows one report per user per job, so a single account
-- can't pile on reports to flag a job by itself.
CREATE TABLE job_reports (
    job_id TEXT NOT NULL,
    reporter_user_id TEXT NOT NULL,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (job_id, reporter_user_id),
    FOREIGN KEY(job_id) REFERENCES jobs(id),
    FOREIGN KEY(reporter_user_id) REFERENCES users(id)
);

CREATE INDEX idx_job_reports_job ON job_reports(job_id);
