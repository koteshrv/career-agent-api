# Contributing

Thanks for considering a contribution — this project exists to be a shared, community-run resource, and that only works if it's easy for other people to work on.

## Getting set up

See [README.md § Local Development](README.md#local-development) for the full setup (Postgres/Redis via Docker, `npm run dev`, `npm test`).

## Before opening a PR

- **`npm run typecheck` and `npm test` must both pass.** CI enforces this, but running them locally first saves a round trip.
- **Keep the docs in sync.** If you add, remove, or change the shape of an endpoint, update all three of: [openapi.yaml](openapi.yaml), [API_REFERENCE.md](API_REFERENCE.md), and [postman/postman_collection.json](postman/postman_collection.json). A PR that changes behavior without updating these is incomplete — this has bitten the project before.
- **Schema changes need a migration, not just a `schema.sql` edit.** `schema.sql` is the fresh-install reference; anyone with an existing deployment applies incremental files under [migrations/](migrations/) instead. If your change touches the database, add a new `migrations/NNNN_description.sql` (next number in sequence) alongside the `schema.sql` update — see the existing files for the expected format (a header comment explaining what changed and why, guarded/idempotent statements).
- **Write tests for behavior changes**, not just happy paths — this codebase leans on real concurrency/race-condition tests (see `test/api.test.ts`) for the credit economy specifically, since that's where subtle bugs are the most costly.

## Code style

Match what's already there: comments explain *why* a decision was made (especially anything non-obvious — a security tradeoff, a Postgres-specific gotcha, a concurrency guard), not a restatement of what the code already says. Keep the policy constants (`DAILY_QUOTA`, `SIGNUP_BONUS`, etc., near the top of `src/app.ts`) as the single place those numbers live — don't hardcode a tuning value somewhere else.

## Reporting bugs / proposing features

Open a [GitHub Issue](https://github.com/koteshrv/career-agent-api/issues). For a security issue, please don't open a public issue — see below.

## Reporting a security issue

Please don't file a public issue for a security vulnerability. Open a [private security advisory](https://github.com/koteshrv/career-agent-api/security/advisories/new) instead.
