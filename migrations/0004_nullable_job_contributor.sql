-- Migration: detach jobs from a deleted contributor instead of destroying them
--
-- Problem: jobs.scraped_by_user_id was NOT NULL REFERENCES users(id)
-- ON DELETE CASCADE. DELETE /api/me (new self-service account deletion)
-- deletes the users row for real -- under CASCADE that would silently
-- delete every job that contributor ever pushed, out from under every other
-- user who has already pulled or might still pull them. Jobs are a shared
-- community resource, not the deleting user's personal data once
-- contributed to the pool.
--
-- Fix: scraped_by_user_id becomes nullable with ON DELETE SET NULL --
-- deleting a contributor's account detaches attribution but keeps the job.
-- (Note: the row that's actually erased is only that one users row; nothing
-- else in this migration deletes any existing data.)
--
-- Safe to run more than once and safe against a live database.

BEGIN;

ALTER TABLE jobs
    ALTER COLUMN scraped_by_user_id DROP NOT NULL;

-- Constraint name is Postgres's own default naming for the inline REFERENCES
-- in the original CREATE TABLE (<table>_<column>_fkey). If your database has
-- it under a different name (check with \d jobs first), adjust before running.
ALTER TABLE jobs
    DROP CONSTRAINT IF EXISTS jobs_scraped_by_user_id_fkey;

ALTER TABLE jobs
    ADD CONSTRAINT jobs_scraped_by_user_id_fkey
    FOREIGN KEY (scraped_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

COMMIT;
