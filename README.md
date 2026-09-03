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
**Important:** The command above will output a `database_id`. Open `wrangler.toml` and replace the placeholder `database_id` value with the one you just received.
**Important:** The command above will output a `database_id`. Open `wrangler.prod.toml` (create this file by copying `wrangler.toml` if you haven't already) and paste your real `database_id` there. Keep the dummy ID in the public `wrangler.toml`!

### 4. Run Migrations
Run the schema setup locally (for development):
```bash
npm run db:migrate
```

Run the schema setup remotely (for production):
Run the schema setup remotely (for production). Notice we use the prod config here:
```bash
npm run db:migrate:remote
npx wrangler d1 execute career-agent-db --remote --file=./schema.sql --config wrangler.prod.toml
```

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
Run this `curl` command to simulate a frontend sending SSO details to the API:
```bash
curl -X POST http://localhost:8787/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "sso_provider": "github"}'
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

Once you are satisfied with local testing, deploy the API to Cloudflare Workers globally:
Once you are satisfied with local testing, deploy the API to Cloudflare Workers globally using your hidden production config:
```bash
npm run deploy
npm run deploy -- --config wrangler.prod.toml
```

---

## API Endpoints

### Auth (SSO Login)

1. **`POST /api/auth/login`**
   - The frontend handles the SSO flow (e.g. Google/GitHub OAuth) and sends the user details here.
   - Body: `{ "email": "user@example.com", "sso_provider": "github" }`
   - Returns a JWT `access_token` that should be used in the `Authorization` header for subsequent requests.

### Jobs Economy (Requires `Authorization: Bearer <JWT>`)

2. **`POST /api/jobs/push`**
   - Give to Get! Upload scraped jobs.
   - Body: `{ "jobs": [{ "company": "...", "title": "...", "location": "...", "url": "..." }] }`
   - Earn +1 credit per unique job inserted.

3. **`GET /api/jobs/pull?limit=10`**
   - Consume jobs. Deducts -1 credit per job.
   - If credits hit 0, falls back to a strict daily quota (50 jobs/day).
