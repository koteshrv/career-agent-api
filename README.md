# CareerAgent API

A centralized crowdsourcing API for the open-source CareerAgent job automation tool. This API serves as the global job-sharing network.

Built with **Node.js, Fastify, PostgreSQL, and Redis**.

It features an asymmetric (RS256) JWT-based SSO system (GitHub & Google) and a "Give-to-Get" credit economy to bypass global IP scraping bans by decentralizing the fetching across the community.

Accounts are identified by `(sso_provider, provider_user_id)` — the IdP's own stable subject id — not by email, since the same email can be independently verified by two different providers (or reassigned at the IdP over time). Logging in from a new provider always creates a separate account, even if the email matches one you already have.

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

### 4. Configure the Cloudflare Tunnel
`docker-compose.yml` runs `cloudflared` as the API's only path to the internet — `api` publishes no host port on purpose, so the tunnel is what makes it safe for the app to trust the `CF-Connecting-IP` header for rate limiting (see Security notes below). Create a tunnel in the Cloudflare dashboard, point its public hostname at `http://api:3000`, and put its token in `.env` as `TUNNEL_TOKEN`.

### Upgrading an Existing Deployment
`schema.sql` is the schema for a fresh install. An existing deployment must instead apply each new file under [migrations/](migrations/), in order, exactly once:
```bash
cat migrations/0001_provider_scoped_identity.sql | docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent
cat migrations/0002_token_version.sql | docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent
cat migrations/0003_admin_role.sql | docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent
cat migrations/0004_nullable_job_contributor.sql | docker exec -i $(docker compose ps -q postgres) psql -U careeragent -d careeragent
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
Ensure your `.env` has `DATABASE_URL`/`REDIS_URL` pointed at `localhost`. Rate limiting reads the `CF-Connecting-IP` header, which nothing sets locally — requests simply aren't rate-limited outside the tunnel-fronted deployment described above.

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
* **Exposing the API**: `api` has no published host port — `cloudflared` (also on `db-network`) is the only path in, connecting outbound to Cloudflare's edge. This is load-bearing, not just for TLS: the app trusts the edge-set `CF-Connecting-IP` header for rate limiting, which is only safe because nothing else can reach the container directly. Don't add a `ports:` mapping back onto `api` without also changing how IPs are trusted in [src/app.ts](src/app.ts).
* **Revoking a token**: `POST /api/auth/logout-all` (authenticated) invalidates every JWT previously issued to that account. There's no single-session revocation — JWTs aren't tracked individually, so it's all-or-nothing per account.
* **Your data**: `GET /api/me/export` returns everything tied to your account (profile, jobs contributed/pulled, reports filed). `DELETE /api/me` (with `{"confirm": true}`) erases your account and its activity records — jobs you contributed stay in the shared pool with their attribution to you removed, rather than being deleted out from under everyone who's already pulled them.
* **Admin API**: `/api/admin/*` requires `is_admin` on your account (bootstrapped by hand — see above). A non-admin gets `404` from these routes, not `403`, so they can't be distinguished from a typo'd path.
* **Login rate limiting**: `/api/auth/login` has its own tighter budget (20 requests/60s per IP) on top of the general 100/60s applied everywhere else, since it's the highest-value target for credential stuffing.
