# API Reference

Detailed request/response reference for every endpoint. For a machine-readable version see [openapi.yaml](openapi.yaml); this document exists to explain the *why* behind field shapes and status codes in more depth than a spec comment allows, and to be precise about edge cases that are easy to get wrong as a client.

## Conventions

**Base URL**: the live community instance is `https://api.careeragent.fyi`. Running your own deployment, it's whatever origin you've put it behind, or `http://localhost:3000` locally.

**Authentication**: `Authorization: Bearer <jwt>` on every endpoint marked 🔒 below. Tokens are RS256-signed, expire in 7 days (`expires_in: 604800`), and are obtained from `POST /v1/auth/login`.

**Content type**: `Content-Type: application/json` on every request that has a body. Endpoints that take **no** body (`POST /v1/auth/logout-all`, `POST /v1/admin/users/:id/ban`, `/unban`, `POST /v1/admin/jobs/:id/unflag`) must be called **without** a `Content-Type: application/json` header and without a body — Fastify itself rejects an `application/json` content type paired with an empty body (`400 FST_ERR_CTP_EMPTY_JSON_BODY`) before the route handler ever runs.

**Error shape**: almost every error response is `{ "error": "<message>" }`. The one exception is the global fallback for truly unexpected server-side failures, which also includes a `requestId` for correlating with server logs:
```json
{ "error": "Internal server error", "requestId": "req-1a2b3c" }
```
A 4xx that Fastify itself generates before a route handler runs (malformed JSON, body over the size limit, an unmatched route) preserves Fastify's own status code and message rather than being collapsed to a generic 500.

**Rate limiting**: applied globally, before every request, keyed on whichever header the deployment's `TRUSTED_IP_HEADER` env var names (only meaningful when the deployment is actually fronted by a reverse proxy that sets it — absent in plain local development, so no rate limiting applies there):
- **Global**: 100 requests / 60s per IP, across the whole API.
- **`POST /v1/auth/login` specifically**: an additional, tighter 20 requests / 60s per IP, on top of the global budget — it's the highest-value target for credential stuffing.

Either limit returns:
```
429 { "error": "Too Many Requests" }
```

**Identity model**: accounts are keyed on `(sso_provider, provider_user_id)` — the IdP's own stable subject id (Google's `sub`, GitHub's numeric `id`) — never on email alone. The same email verified by two different providers gets two separate accounts.

**Admin routes**: return `404 { "error": "Not found" }` for a non-admin caller (not `403`) — a logged-in non-admin can't distinguish an admin route from a typo'd path. There is no self-service way to become an admin (see [DATABASE_QUERIES.md](DATABASE_QUERIES.md)).

---

## Table of Contents

**Auth**
- [`POST /v1/auth/login`](#post-v1authlogin)
- [`POST /v1/auth/logout-all`](#post-v1authlogout-all-) 🔒

**Job Economy**
- [`POST /v1/jobs/push`](#post-v1jobspush-) 🔒
- [`GET /v1/jobs/pull`](#get-v1jobspull-) 🔒
- [`POST /v1/jobs/report`](#post-v1jobsreport-) 🔒

**Account**
- [`GET /v1/me`](#get-v1me-) 🔒
- [`GET /v1/me/export`](#get-v1meexport-) 🔒
- [`DELETE /v1/me`](#delete-v1me-) 🔒

**Admin** (all require an `is_admin` account)
- [`GET /v1/admin/users`](#get-v1adminusers-) 🔒
- [`GET /v1/admin/users/:id`](#get-v1adminusersid-) 🔒
- [`POST /v1/admin/users/:id/credits`](#post-v1adminusersidcredits-) 🔒
- [`POST /v1/admin/users/:id/ban`](#post-v1adminusersidban-) 🔒
- [`POST /v1/admin/users/:id/unban`](#post-v1adminusersidunban-) 🔒
- [`GET /v1/admin/jobs/flagged`](#get-v1adminjobsflagged-) 🔒
- [`POST /v1/admin/jobs/:id/unflag`](#post-v1adminjobsidunflag-) 🔒
- [`GET /v1/admin/jobs/:id/reports`](#get-v1adminjobsidreports-) 🔒
- [`GET /v1/admin/audit-log`](#get-v1adminaudit-log-) 🔒
- [`GET /v1/admin/stats`](#get-v1adminstats-) 🔒

**System**
- [`GET /`](#get-)
- [`GET /health`](#get-health)

---

## `POST /v1/auth/login`

Exchanges a Google ID token or GitHub OAuth code for an internal API JWT. No auth required to call this. Subject to the tighter 20/60s login rate limit in addition to the global one.

### Request

```json
{
  "idp_token": "<Google ID token, or GitHub OAuth authorization code>",
  "sso_provider": "google"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `idp_token` | string | yes | A Google **ID token** (a JWT), or a GitHub OAuth **authorization code** (not an access token). |
| `sso_provider` | string | yes | `"google"` or `"github"`. Anything else → 400. |

**Google verification**: the token is sent to Google's `tokeninfo` endpoint; the response's `aud` must match your `GOOGLE_CLIENT_ID` and `email_verified` must be true.
**GitHub verification**: the code is exchanged for an access token, which is used to fetch the GitHub profile (and `/user/emails` if the primary email is hidden — only a `verified` address is trusted).

### Response

**200** — success:
```json
{
  "token": "eyJhbGciOi...",
  "access_token": "eyJhbGciOi...",
  "token_type": "bearer",
  "expires_in": 604800
}
```
`token` and `access_token` are identical (the latter kept for backward compatibility). A brand-new account is created on first login with `current_credits` set to the signup bonus (50); an existing account's `last_login_ip` and (if changed) `email`/`provider_user_id` are updated.

**400**:
- `{ "error": "Missing idp_token or sso_provider" }`
- `{ "error": "Unsupported SSO provider (Only Google/GitHub supported)" }`
- `{ "error": "Failed to extract email from Identity Provider" }` — the IdP didn't return a usable (verified) email.
- `{ "error": "Failed to extract a stable account id from Identity Provider" }` — no `sub` (Google) / `id` (GitHub) came back.

**401**: `{ "error": "Identity Provider verification failed. Token invalid." }` — covers a forged/expired/invalid token, an `aud` mismatch, an unverified email, or a failed GitHub code exchange. Deliberately generic to the client (the specific reason is logged server-side only, via `console.error`, to avoid handing an attacker a probe for which check failed).

**429**: rate limited (see Conventions above).

**500**: `{ "error": "Server misconfiguration: GOOGLE_CLIENT_ID not set" }` (for `sso_provider: "google"`) or `{ "error": "Server misconfiguration: GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET not set" }` (for `"github"`) — checked upfront before calling out to the IdP at all, so a missing secret fails clearly instead of surfacing as the generic 401 above.

---

## `POST /v1/auth/logout-all` 🔒

Invalidates **every** JWT previously issued to this account, including the one used to call this endpoint. There is no single-session logout — JWTs are stateless and not tracked individually, so revocation is all-or-nothing per account. Send with **no body and no `Content-Type` header**.

### Response

**200**: `{ "success": true, "message": "All tokens for this account have been invalidated." }`

**401** (see [Common Auth Errors](#common-auth-errors-🔒-routes) below) — notably, the token used to call this is itself immediately invalid for any subsequent request.

---

## `POST /v1/jobs/push` 🔒

Give-to-Get economy: upload scraped jobs, earn 1 credit per **unique**, **valid** job successfully inserted (existing URLs are silently deduplicated, earning nothing).

### Request

```json
{
  "jobs": [
    { "company": "TechCorp", "title": "Software Engineer", "location": "Remote", "url": "https://techcorp.com/jobs/1" }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `jobs` | array | yes | Max **1000** entries per request (413 above that). |
| `jobs[].company` | string | yes | Non-empty after trim, ≤512 chars. |
| `jobs[].title` | string | yes | Non-empty after trim, ≤512 chars. |
| `jobs[].url` | string | yes | Must be a syntactically real `http(s)://` URL with a hostname containing a dot (≤2048 chars) — rejects zero-effort junk like `"junk1"`, but not a determined faker. Also the uniqueness key: a duplicate URL earns no credit but isn't an error. |
| `jobs[].location` | string | no | ≤512 chars if present. |

An entry failing any of the above is **silently skipped** (counted in `invalid_skipped`), not rejected as a whole-request error — this keeps one bad entry from failing the credit for every valid one in the same request.

### Response

**200**:
```json
{
  "success": true,
  "message": "Pushed 3 jobs.",
  "credits_earned": 2,
  "jobs_accepted": 2,
  "invalid_skipped": 1,
  "failed": 0,
  "warning": "Daily push credit cap of 500 reached. Jobs were still stored, but no further credits were earned today."
}
```
| Field | Meaning |
|---|---|
| `jobs_accepted` | Count of entries that passed validation **and** were newly inserted (i.e. not a duplicate URL). |
| `credits_earned` | Credits actually **awarded** — can be less than `jobs_accepted` if the daily push-credit cap (500/UTC day) was reached mid-request. The jobs themselves are still stored either way; only the credit is capped. |
| `invalid_skipped` | Entries that failed field validation. |
| `failed` | Entries that passed validation but were lost to a DB-level batch failure (rare — a whole 100-row chunk is one atomic transaction). |
| `warning` | Present only if the daily cap was hit during this request. |

**400**: `{ "error": "Invalid payload, expected array of jobs" }` — `jobs` missing or not an array.

**413**: `{ "error": "Payload too large. Maximum 1000 jobs allowed per request." }`

---

## `GET /v1/jobs/pull` 🔒

Give-to-Get economy: consume jobs from the shared pool. 1 job returned = 1 credit spent; falls back to a strict daily free quota (50/day) once credits reach 0. Each job is served to a given user at most once, ever. Jobs older than 60 days are excluded by default (soft staleness — the rows aren't touched, they're just not served unless asked for).

### Request

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `limit` | integer (query) | no | Default 10, clamped to 1–100. |
| `include_stale` | `"true"` (query) | no | Include jobs older than 60 days, which are excluded by default. |

### Response

**200**:
```json
{
  "success": true,
  "warning": "Requested 20 jobs but limited to 5 due to your current credit balance.",
  "jobs": [
    { "id": "uuid", "company": "TechCorp", "title": "Software Engineer", "location": "Remote", "url": "https://techcorp.com/jobs/1", "created_at": "2026-09-11T09:00:00.000Z" }
  ],
  "deducted": 5,
  "quota_used": 0,
  "has_more": true
}
```
| Field | Meaning |
|---|---|
| `jobs` | Never contains a job this user has already been served, and is **never larger than what was actually charged for** — if the pool runs dry mid-request, the unused portion of the reservation is refunded automatically (`deducted`/`quota_used` reflect what was actually charged, not what was requested). |
| `deducted` | Credits spent (0 if served from the free quota instead). |
| `quota_used` | Free-quota jobs spent (0 if served from credits instead). Exactly one of `deducted`/`quota_used` is non-zero per call. |
| `has_more` | Whether at least one more unconsumed, unflagged job existed beyond this batch **at query time** — a hint for whether calling again is worth it, not a guarantee (the pool is shared and can shift). Not a cursor: calling `pull()` again already advances through the corpus for free, since served jobs are excluded from then on. |
| `warning` | Present when the effective amount served was capped below the requested `limit` — by remaining credit balance, remaining free quota, or the hard 100/request ceiling. |

**400**: `{ "error": "Invalid limit parameter" }` — `limit` isn't a parseable number.

**403**: `{ "error": "Daily quota exceeded. Push more jobs to earn credits." }` — credits are 0 **and** the daily free quota (50) is already used up.

**409**: `{ "error": "Could not process pull request due to concurrent updates, please retry." }` — lost a race with another concurrent pull from the *same* user 3 times in a row; safe to retry immediately.

---

## `POST /v1/jobs/report` 🔒

Community quality control. Report a job you've pulled as fake/dead/spam. Once **3** distinct users report the same job, it's withdrawn from circulation (excluded from future `pull` results), the contributor's earned credit for it is clawed back, and a strike is recorded against them; at **5** strikes the contributor is auto-banned.

### Request

```json
{ "job_id": "uuid-from-a-previous-pull", "reason": "dead_link" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `job_id` | string | yes | Must be a job you've actually pulled — see 403 below. |
| `reason` | string | no | Free text, truncated to 512 chars if longer. |

### Response

**200** — normal case:
```json
{
  "success": true,
  "report_count": 2,
  "reports_needed_to_flag": 3,
  "job_flagged": false,
  "contributor_banned": false
}
```

**200** — reporting a job you've already reported (idempotent, not an error):
```json
{ "success": true, "message": "You have already reported this job." }
```

**200** — the report that crosses the threshold:
```json
{
  "success": true,
  "report_count": 3,
  "reports_needed_to_flag": 3,
  "job_flagged": true,
  "contributor_banned": true
}
```
`contributor_banned` is only ever `true` alongside `job_flagged: true`, and only if this flag was also the contributor's 5th strike. If the job's contributor has since deleted their account (`DELETE /v1/me`), the job can still be flagged normally, but no strike/ban happens — there's no account left to credit it against.

**400**: `{ "error": "Missing or invalid job_id" }` or `{ "error": "Invalid reason" }` (non-string `reason`).

**403**: `{ "error": "You can only report a job you have pulled" }`

**404**: `{ "error": "Job not found" }`

---

## `GET /v1/me` 🔒

Current economy balance and stats snapshot.

### Response

**200**:
```json
{
  "id": "uuid",
  "email": "you@example.com",
  "current_credits": 47,
  "daily_quota_remaining": 12,
  "daily_push_credits_remaining": 500,
  "flagged_count": 0
}
```
`daily_quota_remaining`/`daily_push_credits_remaining` are only meaningful once/if the relevant daily counter has been touched today — both simply read as the full allowance if you haven't pushed/pulled yet today.

---

## `GET /v1/me/export` 🔒

Self-service data export — everything **this account's own data** touches. Does not include community data other users generated (e.g. reports filed *against* this account's jobs by other people).

### Response

**200**:
```json
{
  "profile": {
    "id": "uuid",
    "email": "you@example.com",
    "sso_provider": "github",
    "current_credits": 47,
    "total_pushed": 12,
    "total_pulled": 30,
    "flagged_count": 0,
    "is_banned": false,
    "created_at": "2026-08-01T00:00:00.000Z"
  },
  "jobs_contributed": [
    { "id": "uuid", "company": "TechCorp", "title": "Software Engineer", "location": "Remote", "url": "https://...", "is_flagged": false, "created_at": "..." }
  ],
  "jobs_pulled": [
    { "id": "uuid", "company": "TechCorp", "title": "Software Engineer", "url": "https://...", "pulled_at": "..." }
  ],
  "reports_filed": [
    { "job_id": "uuid", "reason": "dead_link", "created_at": "..." }
  ]
}
```
All three arrays can be empty; none are paginated (they reflect one account's own activity, not the shared pool).

---

## `DELETE /v1/me` 🔒

Self-service, irreversible account deletion. Erases this account's row (email, IP, credit/stat history) and its own activity records (`pulled_jobs`, `job_reports` — cascade-deleted). **Jobs this account contributed are kept**, not deleted: `scraped_by_user_id` is set to `null` rather than the job being removed, since jobs are a shared resource other users may already be relying on. This also immediately invalidates every JWT for the account (there's simply no user row left for the next request to find).

### Request

```json
{ "confirm": true }
```
Required — a bare `DELETE` with no body (or `confirm` not exactly `true`) is rejected, to guard against an accidental call.

### Response

**200**: `{ "success": true, "message": "Account and personal data deleted." }`

**400**: `{ "error": "Confirm deletion by sending {\"confirm\": true}" }`

---

## `GET /v1/admin/users` 🔒

Look up account(s) by email. Since email is not unique, this can return more than one account for the same address (one per SSO provider).

### Request

Query parameter `email` (required).

### Response

**200**:
```json
{
  "users": [
    {
      "id": "uuid", "email": "you@example.com", "sso_provider": "github",
      "current_credits": 47, "total_pushed": 12, "total_pulled": 30,
      "flagged_count": 0, "is_banned": false, "is_admin": false,
      "created_at": "2026-08-01T00:00:00.000Z"
    }
  ]
}
```
`users: []` if none match — not a 404.

**400**: `{ "error": "Missing email query parameter" }`

---

## `GET /v1/admin/users/:id` 🔒

Same fields as above, for one account by id.

### Response

**200**: `{ "user": { ...same shape as one entry above... } }`

**404**: `{ "error": "User not found" }`

---

## `POST /v1/admin/users/:id/credits` 🔒

Sets a user's credit balance to an **absolute value** (not a delta — you decide the resulting total, matching the `DATABASE_QUERIES.md` "grant N credits" pattern).

### Request

```json
{ "credits": 50000 }
```
`credits` must be an integer in `[0, 1000000]`.

### Response

**200**: `{ "success": true, "current_credits": 50000 }`

**400**: `{ "error": "credits must be an integer between 0 and 1000000" }`

**404**: `{ "error": "User not found" }`

---

## `POST /v1/admin/users/:id/ban` 🔒

Send with **no body/Content-Type**.

### Response

**200**: `{ "success": true }`

**404**: `{ "error": "User not found" }`

---

## `POST /v1/admin/users/:id/unban` 🔒

Same shape as `/ban` above.

---

## `GET /v1/admin/jobs/flagged` 🔒

Lists jobs currently withdrawn from circulation (3+ community reports).

### Request

Query parameter `limit` (optional, default 50, clamped to 1–200).

### Response

**200**:
```json
{
  "jobs": [
    {
      "id": "uuid", "company": "TechCorp", "title": "Software Engineer",
      "location": "Remote", "url": "https://...",
      "scraped_by_user_id": "uuid or null",
      "created_at": "..."
    }
  ]
}
```
`scraped_by_user_id` is `null` if the contributor has since deleted their account.

---

## `POST /v1/admin/jobs/:id/unflag` 🔒

Restores a job to circulation — e.g. after review finds a report was a false positive. Send with **no body/Content-Type**.

### Response

**200**: `{ "success": true }`

**404**: `{ "error": "Job not found" }`

---

## `GET /v1/admin/jobs/:id/reports` 🔒

Who reported a job, and why. Works for **any** job, not just already-flagged ones — useful for reviewing a borderline case before it crosses the auto-flag threshold.

### Response

**200**:
```json
{
  "job_id": "uuid",
  "reports": [
    { "reporter_user_id": "uuid", "reporter_email": "someone@example.com", "reason": "dead_link", "created_at": "..." }
  ]
}
```
`reports: []` if the job has none.

**404**: `{ "error": "Job not found" }`

---

## `GET /v1/admin/audit-log` 🔒

Every write made through `/v1/admin/*` — `set_credits`, `ban`, `unban`, `unflag_job` — newest first.

### Request

Query parameter `limit` (optional, default 50, clamped to 1–200).

### Response

**200**:
```json
{
  "actions": [
    {
      "id": "uuid",
      "admin_user_id": "uuid or null",
      "admin_email": "admin@example.com or null",
      "action": "set_credits",
      "target_type": "user",
      "target_id": "uuid",
      "details": "credits=50000",
      "created_at": "..."
    }
  ]
}
```
`admin_user_id`/`admin_email` are `null` for an action taken by an admin whose account has since been deleted — the log entry itself is never deleted (`admin_user_id` is `ON DELETE SET NULL`, not cascade).

---

## `GET /v1/admin/stats` 🔒

Aggregate system metrics — the API equivalent of `DATABASE_QUERIES.md`'s "Total System Metrics" and "View Top Contributors" queries.

### Response

**200**:
```json
{
  "total_users": 142,
  "total_banned_users": 3,
  "total_jobs": 8901,
  "total_flagged_jobs": 12,
  "total_stale_jobs": 340,
  "total_reports": 40,
  "top_contributors": [
    { "email": "someone@example.com", "total_pushed": 512, "current_credits": 87, "is_banned": false }
  ]
}
```
`top_contributors` is the top 10 accounts by `total_pushed`, descending. `total_stale_jobs` counts non-flagged jobs older than the 60-day pull cutoff (see `GET /v1/jobs/pull`) — these still exist and are still counted in `total_jobs`, just not served by default.

---

## `GET /`

Unauthenticated. Not part of the versioned API surface — just basic metadata and links for anyone who opens the domain directly.

### Response

**200**:
```json
{
  "name": "CareerAgent API",
  "version": "abc1234",
  "docs": "https://github.com/koteshrv/career-agent-api/blob/main/API_REFERENCE.md",
  "repo": "https://github.com/koteshrv/career-agent-api",
  "health": "/health"
}
```

---

## `GET /health`

Unauthenticated liveness/readiness probe. Not rate-limited any differently than any other route.

### Response

**200**: `{ "status": "ok", "database": "ok", "version": "abc1234" }` — `version` is the deployed image's `GIT_COMMIT_HASH` build arg, or `"unknown"` if not set.

**503**: `{ "status": "degraded", "database": "unreachable", "version": "abc1234" }`

---

## Common Auth Errors (🔒 routes)

Every endpoint marked 🔒 above can additionally return:

| Status | Body | Cause |
|---|---|---|
| 401 | `{ "error": "Unauthorized" }` | No `Authorization` header, or not `Bearer <token>`. |
| 401 | `{ "error": "Invalid token" }` | Signature invalid/forged, expired, or missing the `id` claim. |
| 401 | `{ "error": "User not found" }` | Token is validly signed but its subject no longer has a user row (e.g. the account was deleted). |
| 401 | `{ "error": "Token revoked" }` | Token was issued before the account's most recent `POST /v1/auth/logout-all`. |
| 403 | `{ "error": "User is banned" }` | Account is banned — this check happens even though the JWT itself is still validly signed and unexpired, since ban state is re-checked from the database on every request. |
| 429 | `{ "error": "Too Many Requests" }` | See Rate limiting in Conventions. |

Admin routes (all also 🔒) additionally return `404 { "error": "Not found" }` for a non-admin caller, taking priority over any route-specific 404 (e.g. "User not found") — the admin gate is checked before the handler body runs.
