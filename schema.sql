-- PostgreSQL Schema Migration

CREATE TABLE users (
    id UUID PRIMARY KEY,
    -- Not UNIQUE on its own: the same verified email can legitimately belong to
    -- two different provider identities (e.g. Google and GitHub), which must be
    -- kept as separate accounts. See provider_user_id below for the real identity key.
    email TEXT NOT NULL,
    sso_provider TEXT NOT NULL,
    -- The IdP's own stable subject identifier (Google's `sub`, GitHub's numeric
    -- `id`), NOT the email. Identity is anchored here because emails can be
    -- reassigned/changed at the IdP; a stable external id can't be.
    -- Nullable only to support the one-time backfill of accounts created before
    -- this column existed (see migrations/0001_provider_scoped_identity.sql) --
    -- every row written by the current login code always sets it.
    provider_user_id TEXT,
    current_credits INTEGER DEFAULT 50,
    total_pushed INTEGER DEFAULT 0,
    total_pulled INTEGER DEFAULT 0,
    pulled_today INTEGER DEFAULT 0,
    last_pull_date DATE,
    pushed_today INTEGER DEFAULT 0,
    last_push_date DATE,
    flagged_count INTEGER DEFAULT 0,
    is_banned BOOLEAN DEFAULT FALSE,
    -- Grants access to the /api/admin/* routes. No self-service way to set
    -- this — the first admin is always bootstrapped by hand
    -- (see DATABASE_QUERIES.md), same as ban/credit changes were before the
    -- admin API existed.
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    -- Bumped by POST /api/auth/logout-all to invalidate every JWT issued
    -- before that point (each token embeds the version it was signed with;
    -- the auth middleware rejects a mismatch even though the signature is
    -- still valid). Lets a user respond to a leaked token without waiting
    -- out its full expiry.
    token_version INTEGER NOT NULL DEFAULT 0,
    last_login_ip TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- The true identity key. Multiple NULL provider_user_id rows are allowed by
    -- Postgres (NULL is never equal to NULL) so pre-migration rows coexist fine
    -- until they're backfilled on next login.
    UNIQUE (sso_provider, provider_user_id)
);

CREATE INDEX idx_users_email ON users(email);

CREATE TABLE jobs (
    id UUID PRIMARY KEY,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT,
    url TEXT UNIQUE NOT NULL,
    -- Nullable, ON DELETE SET NULL rather than CASCADE: jobs are a shared
    -- community resource that other users may already rely on. Deleting a
    -- contributor's account (DELETE /api/me) must not delete every job they
    -- ever pushed out from under everyone else — it detaches attribution
    -- instead. Only this row's own account is actually erased.
    scraped_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
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
