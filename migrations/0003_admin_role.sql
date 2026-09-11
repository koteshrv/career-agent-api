-- Migration: admin role
--
-- Adds is_admin, gating the new /api/admin/* routes. There is no self-service
-- way to become an admin — bootstrap the first one by hand:
--   UPDATE users SET is_admin = true WHERE email = 'you@example.com';
-- (see DATABASE_QUERIES.md). Everything after that can go through the API
-- instead of raw SQL.
--
-- Safe to run more than once and safe against a live database.

BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
