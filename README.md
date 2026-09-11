# CareerAgent API

A centralized crowdsourcing API for the open-source CareerAgent job automation tool. This API serves as the global job-sharing network.

Built with **Node.js, Fastify, PostgreSQL, and Redis**.

It features an asymmetric (RS256) JWT-based SSO system (GitHub & Google) and a "Give-to-Get" credit economy to bypass global IP scraping bans by decentralizing the fetching across the community.

Accounts are identified by `(sso_provider, provider_user_id)` — the IdP's own stable subject id — not by email, since the same email can be independently verified by two different providers (or reassigned at the IdP over time). Logging in from a new provider always creates a separate account, even if the email matches one you already have.

## 📖 API Documentation

- **[API_REFERENCE.md](API_REFERENCE.md)** — full request/response reference for every endpoint: exact field types, every status code and error body, and the edge cases (idempotency, what happens when a job's contributor has deleted their account, etc.).
- **[openapi.yaml](openapi.yaml)** — the same surface as a machine-readable OpenAPI 3.0 spec.
- **[postman/postman_collection.json](postman/postman_collection.json)** — ready-to-run requests for every endpoint, including an Admin folder.

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/auth/login` | — | Exchange a Google/GitHub token for an API JWT |
| `POST /api/auth/logout-all` | 🔒 | Invalidate every issued token for this account |
| `POST /api/jobs/push` | 🔒 | Upload scraped jobs, earn credits |
| `GET /api/jobs/pull` | 🔒 | Consume jobs, spend credits/quota |
| `POST /api/jobs/report` | 🔒 | Report a pulled job as fake/dead/spam |
| `GET /api/me` | 🔒 | Credit balance and stats |
| `GET /api/me/export` | 🔒 | Export this account's own data |
| `DELETE /api/me` | 🔒 | Delete this account |
| `GET /api/admin/users` | 🔒👑 | Look up accounts by email |
| `GET /api/admin/users/:id` | 🔒👑 | Get one account |
| `POST /api/admin/users/:id/credits` | 🔒👑 | Set a credit balance |
| `POST /api/admin/users/:id/ban` \| `/unban` | 🔒👑 | Ban/unban an account |
| `GET /api/admin/jobs/flagged` | 🔒👑 | List withdrawn jobs |
| `POST /api/admin/jobs/:id/unflag` | 🔒👑 | Restore a job to circulation |
| `GET /api/admin/jobs/:id/reports` | 🔒👑 | Who reported a job, and why |
| `GET /api/admin/audit-log` | 🔒👑 | Every admin write, who did it |
| `GET /api/admin/stats` | 🔒👑 | Aggregate system metrics |
| `GET /health` | — | Liveness probe |

🔒 = requires a JWT · 👑 = requires `is_admin` on that account (see [Bootstrapping an Admin](#bootstrapping-an-admin) below)

---

## 🚀 Production Deployment (Docker)

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
From there, `/api/admin/*` (see `openapi.yaml`) covers granting credits, banning/unbanning, and un-flagging jobs — see [DATABASE_QUERIES.md](DATABASE_QUERIES.md) for the raw-SQL fallback.

---

## 💻 Local Development

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

---

## 🔒 Security & Architecture Notes
* **Network Isolation**: The `docker-compose.yml` is configured with strict network separation. The API talks to Postgres and Redis over an isolated internal `db-network`.
* **Exposing the API**: `api` has no published host port — whatever reverse proxy you add (see [Expose the API](#4-expose-the-api) above) is meant to be the only path in. This is load-bearing, not just for TLS: the app trusts the header named by `TRUSTED_IP_HEADER` for rate limiting, which is only safe because nothing else can reach the container directly. Don't add a `ports:` mapping back onto `api` without also reconsidering `TRUSTED_IP_HEADER` — anything with a second, unproxied path to the container can set that header to whatever it wants.
* **Revoking a token**: `POST /api/auth/logout-all` (authenticated) invalidates every JWT previously issued to that account. There's no single-session revocation — JWTs aren't tracked individually, so it's all-or-nothing per account.
* **Your data**: `GET /api/me/export` returns everything tied to your account (profile, jobs contributed/pulled, reports filed). `DELETE /api/me` (with `{"confirm": true}`) erases your account and its activity records — jobs you contributed stay in the shared pool with their attribution to you removed, rather than being deleted out from under everyone who's already pulled them.
* **Admin API**: `/api/admin/*` requires `is_admin` on your account (bootstrapped by hand — see above). A non-admin gets `404` from these routes, not `403`, so they can't be distinguished from a typo'd path.
* **Login rate limiting**: `/api/auth/login` has its own tighter budget (20 requests/60s per IP) on top of the general 100/60s applied everywhere else, since it's the highest-value target for credential stuffing.
