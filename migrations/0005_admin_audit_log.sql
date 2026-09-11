-- Migration: admin action audit log
--
-- Problem: /api/admin/* can ban/unban accounts, set credit balances, and
-- un-flag jobs, with no record of which admin did what, when. Fine with
-- exactly one admin; becomes a real accountability gap the moment there's
-- more than one.
--
-- Fix: every write through /api/admin/* now also inserts a row here. Read it
-- back via GET /api/admin/audit-log.
--
-- Safe to run more than once and safe against a live database.

BEGIN;

CREATE TABLE IF NOT EXISTS admin_actions (
    id UUID PRIMARY KEY,
    admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id UUID,
    details TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC);

COMMIT;
