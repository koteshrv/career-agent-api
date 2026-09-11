-- Migration: provider-scoped identity
--
-- Problem: /api/auth/login previously matched users by email alone. Since two
-- different SSO providers can independently verify the same email address for
-- two different real-world logins, this silently merged accounts across
-- providers (sign up via Google, later "log in" via GitHub with a matching
-- verified email -> same account, same credits, same history, with no
-- indication this happened). It's also unsafe long-term: an email can be
-- reassigned at the IdP (e.g. an offboarded Workspace address reused for a new
-- hire), so keying identity on email at all is the wrong anchor.
--
-- Fix: identity is now (sso_provider, provider_user_id) -- the IdP's own
-- stable subject id (Google's `sub`, GitHub's numeric `id`), which cannot be
-- reassigned or user-changed. Email becomes a plain profile field.
--
-- This migration is additive and safe to run against a live database with
-- existing rows: existing users keep their id/credits/history untouched.
-- provider_user_id starts NULL for them and is backfilled automatically the
-- next time each user logs in (see the login handler's fallback lookup), not
-- by this script -- there is no way to recover a Google `sub` or GitHub `id`
-- for a user from stored data alone.
--
-- Safe to run more than once (every statement is guarded).

BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS provider_user_id TEXT;

-- Drop the old email-alone uniqueness. Its constraint name follows Postgres's
-- default naming for a column-level UNIQUE on `email`; adjust if your
-- database named it differently (check with \d users beforehand).
ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_email_key;

-- Replaces it: email is looked up often (reports, admin queries) but no
-- longer needs to be unique.
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- The real identity key. Safe with existing NULL provider_user_id rows --
-- Postgres never treats two NULLs as equal, so any number of un-backfilled
-- rows can coexist under this constraint.
ALTER TABLE users
    ADD CONSTRAINT users_provider_identity_key UNIQUE (sso_provider, provider_user_id);

COMMIT;

-- Verify afterwards with:
--   SELECT COUNT(*) FROM users WHERE provider_user_id IS NULL;
-- This count should trend to 0 as existing users log back in, and can be used
-- to track backfill progress.
