# CareerAgent API

[![CI](https://github.com/koteshrv/career-agent-api/actions/workflows/ci.yml/badge.svg)](https://github.com/koteshrv/career-agent-api/actions/workflows/ci.yml)
[![API Status](https://img.shields.io/website?url=https%3A%2F%2Fapi.careeragent.fyi%2Fhealth&label=api&up_message=online&down_message=offline)](https://api.careeragent.fyi)
[![License: MIT](https://img.shields.io/github/license/koteshrv/career-agent-api)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A centralized crowdsourcing API for the open-source [CareerAgent](https://github.com/koteshrv/career-agent) job automation tool — the shared job-sharing network behind it. Built with Node.js, Fastify, PostgreSQL, and Redis.

**API:** [https://api.careeragent.fyi](https://api.careeragent.fyi) · **Docs:** [API_REFERENCE.md](API_REFERENCE.md) · [openapi.yaml](openapi.yaml) · [Postman collection](postman/postman_collection.json)

## Contents

- [Overview](#overview)
- [Features](#features)
- [Quick Start](#quick-start)
- [API Documentation](#api-documentation)
- [Production Deployment](#production-deployment-docker)
- [Local Development](#local-development)
- [Contributing](#contributing)
- [Security & Architecture Notes](#security--architecture-notes)
- [License](#license)

## Overview

CareerAgent scrapes job listings, but any single machine doing that at volume runs into per-IP scraping bans. This API turns that into a shared problem with a shared fix: a "Give-to-Get" credit economy where contributing listings earns credits, and credits are spent to pull from everyone else's contributions — decentralizing the fetching across the whole community instead of hammering job boards from one IP.

Accounts authenticate via SSO (Google or GitHub). Signing in with a different provider always creates a separate account, even if the email matches one you already have.

## Features

- **SSO authentication** — Google and GitHub, asymmetric RS256 JWTs, no passwords stored
- **Give-to-Get credit economy** — earn credits by pushing job listings, spend them pulling from the shared pool, with a free daily quota to evaluate the API before contributing
- **Community moderation** — reports from users who've actually pulled a listing withdraw it automatically past a threshold, with a strike system that auto-bans repeat offenders
- **Full admin API** — user/credit management, ban/unban, job moderation, and an audited action log, all behind an `is_admin` gate rather than raw database access
- **Self-service account controls** — export your own data or delete your account at any time
- **Soft job staleness** — old listings quietly age out of results after 60 days rather than being served forever

## Quick Start

No setup required to try the live instance:

```bash
curl https://api.careeragent.fyi/health
# {"status":"ok","database":"ok","version":"..."}
```

Full auth flow (SSO login → JWT → authenticated requests) is in [API_REFERENCE.md](API_REFERENCE.md), or import [postman/postman_collection.json](postman/postman_collection.json) for a ready-to-run set of requests.

## API Documentation

- **[API_REFERENCE.md](API_REFERENCE.md)** — full request/response reference for every endpoint: exact field types, every status code and error body, and the edge cases (idempotency, what happens when a job's contributor has deleted their account, etc.)
- **[openapi.yaml](openapi.yaml)** — the same surface as a machine-readable OpenAPI 3.0 spec
- **[postman/postman_collection.json](postman/postman_collection.json)** — ready-to-run requests for every endpoint, including an Admin folder

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/auth/login` | — | Exchange a Google/GitHub token for an API JWT |
| `POST /v1/auth/logout-all` | 🔒 | Invalidate every issued token for this account |
| `POST /v1/jobs/push` | 🔒 | Upload scraped jobs, earn credits |
| `GET /v1/jobs/pull` | 🔒 | Consume jobs, spend credits/quota |
| `POST /v1/jobs/report` | 🔒 | Report a pulled job as fake/dead/spam |
| `GET /v1/me` | 🔒 | Credit balance and stats |
| `GET /v1/me/export` | 🔒 | Export this account's own data |
| `DELETE /v1/me` | 🔒 | Delete this account |
| `GET /v1/admin/users` | 🔒👑 | Look up accounts by email |
| `GET /v1/admin/users/:id` | 🔒👑 | Get one account |
| `POST /v1/admin/users/:id/credits` | 🔒👑 | Set a credit balance |
| `POST /v1/admin/users/:id/ban` \| `/unban` | 🔒👑 | Ban/unban an account |
| `GET /v1/admin/jobs/flagged` | 🔒👑 | List withdrawn jobs |
| `POST /v1/admin/jobs/:id/unflag` | 🔒👑 | Restore a job to circulation |
| `GET /v1/admin/jobs/:id/reports` | 🔒👑 | Who reported a job, and why |
| `GET /v1/admin/audit-log` | 🔒👑 | Every admin write, who did it |
| `GET /v1/admin/stats` | 🔒👑 | Aggregate system metrics |
| `GET /` | — | API metadata and links |
| `GET /health` | — | Liveness probe |

🔒 requires a JWT · 👑 requires `is_admin` on that account (see [Bootstrapping an Admin](#bootstrapping-an-admin))

## Production Deployment (Docker)

This API is fully containerized and designed to be deployed securely via Docker Compose.

### 1. Configure the Environment
1. Clone this repository to your server.
2. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
3. Open `.env` and fill in your database passwords, RS256 JWT keys, and OAuth (GitHub/Google) client secrets.

### 2. Boot the Servers
Start the API, PostgreSQL, and Redis containers in the background. The API will automatically pull the latest pre-built image from the GitHub Container Registry.
```bash
docker compose pull
docker compose up -d
```

### 3. Initialize the Database
Once Postgres is running, you must import the database schema to create the tables. `schema.sql` only creates tables — it doesn't drop anything, so it errors loudly (rather than touching data) if run against a database that already has them.
```bash
cat schema.sql | docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent
```
*(For a brand-new database only. See below for upgrading an existing deployment.)*

### 4. Expose the API
`api` publishes no host port on purpose (see the comment in `docker-compose.yml`) — put a reverse proxy of your choice in front of it (nginx, Caddy, a tunneling service, whatever fits your setup), added as its own service on `db-network` and pointed at `api:3000`. Whatever you use, set `TRUSTED_IP_HEADER` in `.env` to the header that proxy sets with the real client IP (see Security notes below) — rate limiting and login IP logging depend on it, and fail safe (simply disabled) if it's left unset.

### Upgrading an Existing Deployment
`schema.sql` is the schema for a fresh install. An existing deployment must instead apply each new file under [migrations/](migrations/), in order, exactly once:
```bash
cat migrations/0001_provider_scoped_identity.sql | docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent
cat migrations/0002_token_version.sql | docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent
cat migrations/0003_admin_role.sql | docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent
cat migrations/0004_nullable_job_contributor.sql | docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent
cat migrations/0005_admin_audit_log.sql | docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent
```
Each migration documents what it changes and why in its own header comment, and is safe to run more than once (every statement is guarded).

### Bootstrapping an Admin
There's no self-service way to become an admin. After applying `migrations/0003_admin_role.sql`:
```sql
UPDATE users SET is_admin = true WHERE email = 'you@example.com';
```
From there, `/v1/admin/*` (see `openapi.yaml`) covers granting credits, banning/unbanning, and un-flagging jobs — see [DATABASE_QUERIES.md](DATABASE_QUERIES.md) for the raw-SQL fallback.

## Local Development

If you want to contribute to the API or test changes locally without Docker:

### 1. Install Dependencies
```bash
npm install
```

### 2. Set up local services
You will need a local PostgreSQL and Redis instance running. The easiest way is to start just those two from the compose file:
```bash
docker compose up -d postgres redis
```
Ensure your `.env` has `DATABASE_URL`/`REDIS_URL` pointed at `localhost`. Rate limiting reads whatever header `TRUSTED_IP_HEADER` names, which nothing sets locally unless you configure a local reverse proxy too — requests simply aren't rate-limited without it.

### 3. Run the development server
```bash
npm run dev
```
The server will start locally via `tsx` on port `3000`.

### 4. Run Tests
```bash
npm test
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow, what needs to stay in sync (docs, migrations), and how to report a bug or a security issue.

## Security & Architecture Notes

* **Network Isolation**: The `docker-compose.yml` is configured with strict network separation. The API talks to Postgres and Redis over an isolated internal `db-network`.
* **Exposing the API**: `api` has no published host port — whatever reverse proxy you add (see [Expose the API](#4-expose-the-api) above) is meant to be the only path in. This is load-bearing, not just for TLS: the app trusts the header named by `TRUSTED_IP_HEADER` for rate limiting, which is only safe because nothing else can reach the container directly. Don't add a `ports:` mapping back onto `api` without also reconsidering `TRUSTED_IP_HEADER` — anything with a second, unproxied path to the container can set that header to whatever it wants.
* **Revoking a token**: `POST /v1/auth/logout-all` (authenticated) invalidates every JWT previously issued to that account. There's no single-session revocation — JWTs aren't tracked individually, so it's all-or-nothing per account.
* **Your data**: `GET /v1/me/export` returns everything tied to your account (profile, jobs contributed/pulled, reports filed). `DELETE /v1/me` (with `{"confirm": true}`) erases your account and its activity records — jobs you contributed stay in the shared pool with their attribution to you removed, rather than being deleted out from under everyone who's already pulled them.
* **Admin API**: `/v1/admin/*` requires `is_admin` on your account (bootstrapped by hand — see above). A non-admin gets `404` from these routes, not `403`, so they can't be distinguished from a typo'd path.
* **Login rate limiting**: `/v1/auth/login` has its own tighter budget (20 requests/60s per IP) on top of the general 100/60s applied everywhere else, since it's the highest-value target for credential stuffing.
* **Reporting a vulnerability**: please don't open a public issue — see [CONTRIBUTING.md](CONTRIBUTING.md#reporting-a-security-issue).

## License

[MIT](LICENSE)
