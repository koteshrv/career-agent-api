-- Migration: JWT revocation via token_version
--
-- Problem: a leaked/stolen JWT stayed valid for its full 7-day expiry with no
-- way to invalidate it early. (Banning a user already took effect instantly
-- because is_banned is re-checked from the DB on every request -- this closes
-- the same gap for a user's own voluntary "log out everywhere".)
--
-- Fix: users.token_version is embedded in every newly-issued JWT as `tv`. The
-- auth middleware now rejects any token whose `tv` doesn't match the current
-- value in the DB, even if the signature is otherwise valid. POST
-- /api/auth/logout-all increments it, invalidating every previously-issued
-- token at once.
--
-- Safe to run more than once and safe against a live database: existing
-- users default to 0, which matches the `tv` value any token issued before
-- this migration implicitly carried none of -- see the auth middleware's
-- handling of a missing `tv` claim on an old token.

BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

COMMIT;
