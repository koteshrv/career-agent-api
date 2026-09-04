# Career Agent API

A centralized crowdsourcing API for an open-source job scraping tool, built for the Edge using Cloudflare Workers, Hono.js, Cloudflare D1, and TypeScript.

It features a JWT-based SSO system and a Give-to-Get credit economy to prevent open-source freeriders.

## Step-by-Step Setup Instructions

### 1. Install Dependencies
Make sure you have Node.js installed, then run:
```bash
npm install
```

### 2. Login to Cloudflare
Authenticate Wrangler with your Cloudflare account:
```bash
npx wrangler login
```

### 3. Initialize the D1 Database
Create the remote D1 database:
```bash
npm run db:init
```
**Important:** The command above will output a `database_id`. Create a copy of `wrangler.toml` named `wrangler.prod.toml` (this is ignored by Git to keep your secrets safe). Paste your real `database_id` into `wrangler.prod.toml`. Keep the dummy ID in the public `wrangler.toml`!

Set real values for `GOOGLE_CLIENT_ID` (from the Google Cloud Console credentials you set up per the IdP guide — the API rejects Google logins whose token wasn't issued for this client ID) and `ALLOWED_ORIGIN` (your deployed frontend's origin, comma-separated if there's more than one).

**On `JWT_SECRET`:** values under `[vars]` are plain configuration, not secrets — they're bundled into the Worker and readable by anyone with dashboard access. For production, store it as a real secret instead, and remove the `JWT_SECRET` line from `wrangler.prod.toml`:
```bash
npx wrangler secret put JWT_SECRET --config wrangler.prod.toml
```
Keep the dummy value in `wrangler.toml` for local development.

### 4. Run Migrations
Run the schema setup locally (for development):
```bash
npm run db:migrate
```

Run the schema setup remotely (for production, **first-time setup only**). Notice we use the prod config here:
```bash
npx wrangler d1 execute career-agent-db --remote --file=./schema.sql --config wrangler.prod.toml
```

**`schema.sql` is destructive** — it drops and recreates every table on every run. Only run the command above against production once, before real users exist. If the schema changes later and production already has data, apply just the new/changed statements by hand (see the comment at the top of `schema.sql` for an example) instead of re-running the whole file.

### 5. Local Development
Start the local development server:
```bash
npm run dev
```
The API will be available at `http://localhost:8787`.

---

## Testing Locally

Before deploying to Cloudflare, you can test the API locally. Make sure your local server is running (`npm run dev`) in a separate terminal.

**1. Login & Get a JWT**
Run this `curl` command to simulate a frontend sending an IdP token to the API:
```bash
curl -X POST http://localhost:8787/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"idp_token": "YOUR_REAL_GOOGLE_OR_GITHUB_TOKEN", "sso_provider": "github"}'
```
*Copy the `access_token` from the response. You will use it in the next commands.*

**2. Push Jobs (Give to Get)**
Replace `YOUR_JWT_HERE` with the token you just copied:
```bash
curl -X POST http://localhost:8787/api/jobs/push \
  -H "Authorization: Bearer YOUR_JWT_HERE" \
  -H "Content-Type: application/json" \
  -d '{"jobs": [{"company": "TechCorp", "title": "Software Engineer", "location": "Remote", "url": "https://techcorp.com/jobs/1"}]}'
```
*You should see a success message and credits earned.*

**3. Pull Jobs (Consume)**
Replace `YOUR_JWT_HERE` with the token:
```bash
curl -X GET "http://localhost:8787/api/jobs/pull?limit=5" \
  -H "Authorization: Bearer YOUR_JWT_HERE"
```
*You should receive the job you just pushed and see your credits deducted.*

---

## Deployment

Once you are satisfied with local testing, deploy the API to Cloudflare Workers globally using your hidden production config:
```bash
npm run deploy -- --config wrangler.prod.toml
```

---

## API Endpoints

### Auth (SSO Login)

1. **`POST /api/auth/login`**
   - The frontend handles the SSO flow (e.g. Google/GitHub OAuth) and sends the resulting token here.
   - Body: `{ "idp_token": "eyJhbG...", "sso_provider": "github" }`
   - The backend cryptographically validates the token against the IdP.
   - Returns a JWT `access_token` that should be used in the `Authorization` header for subsequent requests.

### Jobs Economy (Requires `Authorization: Bearer <JWT>`)

2. **`POST /api/jobs/push`**
   - Give to Get! Upload scraped jobs.
   - Body: `{ "jobs": [{ "company": "...", "title": "...", "location": "...", "url": "..." }] }`
   - Earn +1 credit per unique job inserted, up to a **daily cap of 500 earned credits**. Jobs beyond the cap are still stored, they just stop earning.
   - `url` must be a real `http(s)` URL; entries with junk URLs, missing `company`/`title`/`url`, or oversized fields are skipped (reported as `invalid_skipped`) rather than failing the whole batch.

3. **`GET /api/jobs/pull?limit=10`**
   - Consume jobs. Deducts -1 credit per job.
   - If credits hit 0, falls back to a strict daily quota (50 jobs/day).
   - Each user is only ever served a given job once — already-pulled jobs are excluded from future pulls.
   - May return `409` under heavy concurrent pull requests from the same account; safe to retry.

4. **`POST /api/jobs/report`**
   - Community quality control. Report a job as fake or dead: `{ "job_id": "...", "reason": "dead_link" }`.
   - You can only report a job you actually pulled, once per job. Once **3 distinct users** report the same job it is flagged and withdrawn from circulation, the contributor loses the credit earned for it and takes a strike; at **5 strikes** the contributor is auto-banned.

5. **`GET /api/me`**
   - Returns your current `current_credits`, `total_pushed`, `total_pulled`, `daily_quota_remaining`, `daily_push_credits_remaining`, and `flagged_count`.

### Operations

6. **`GET /health`** (no auth)
   - Liveness probe; also confirms the D1 binding responds. Returns `503` if the database is unreachable.

## Economy & Anti-Abuse Dials

All tuning constants live together at the top of the routes section in [src/index.ts](src/index.ts) — signup bonus, daily pull quota, daily push credit cap, and the report/strike thresholds. Adjust them there rather than hunting through handlers.

## Inspecting the Database

For SQL to check job entries, user credits/bans, pull history, or reports directly against D1 — via `wrangler` or the Cloudflare Dashboard Console — see [DATABASE_QUERIES.md](DATABASE_QUERIES.md).

## Testing

```bash
npm test          # vitest against a real Workers runtime + local D1
npm run typecheck # tsc --noEmit
```

The suite covers the economy invariants that are easy to break by accident: credits are never overspent under concurrent pulls, the same job is never delivered twice, unfulfilled reservations are refunded, and fabricated URLs earn nothing. CI runs both on every push and pull request.
