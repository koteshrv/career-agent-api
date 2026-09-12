-- Migration 0006: Convert users to anonymous agents
-- Drops SSO and email requirements, adds trust scoring, and renames
-- tables/columns from 'user' to 'agent' throughout the database.

-- 1. Drop the SSO unique constraint and email index
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_sso_provider_provider_user_id_key;
DROP INDEX IF EXISTS idx_users_email;

-- 2. Drop SSO and identity columns
ALTER TABLE users DROP COLUMN IF EXISTS email;
ALTER TABLE users DROP COLUMN IF EXISTS sso_provider;
ALTER TABLE users DROP COLUMN IF EXISTS provider_user_id;

-- 3. Add trust_score for the anonymous contribution economy
ALTER TABLE users ADD COLUMN IF EXISTS trust_score INTEGER DEFAULT 50;

-- 4. Rename the primary table
ALTER TABLE users RENAME TO agents;

-- 5. Rename all related foreign key columns in other tables
ALTER TABLE jobs RENAME COLUMN scraped_by_user_id TO scraped_by_agent_id;
ALTER TABLE pulled_jobs RENAME COLUMN user_id TO agent_id;
ALTER TABLE job_reports RENAME COLUMN reporter_user_id TO reporter_agent_id;
ALTER TABLE admin_actions RENAME COLUMN admin_user_id TO admin_agent_id;

-- 6. Rename indexes for consistency
ALTER INDEX IF EXISTS idx_pulled_jobs_user RENAME TO idx_pulled_jobs_agent;

