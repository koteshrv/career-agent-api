-- PostgreSQL Schema Migration

CREATE TABLE users (
    id UUID PRIMARY KEY,
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
    is_banned BOOLEAN DEFAULT FALSE,
    last_login_ip TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE jobs (
    id UUID PRIMARY KEY,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT,
    url TEXT UNIQUE NOT NULL,
    scraped_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_flagged BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pulled_jobs (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    pulled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, job_id)
);

CREATE INDEX idx_pulled_jobs_user ON pulled_jobs(user_id);

CREATE TABLE job_reports (
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    reporter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (job_id, reporter_user_id)
);

CREATE INDEX idx_job_reports_job ON job_reports(job_id);
