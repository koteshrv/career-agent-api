import dotenv from 'dotenv';
// quiet: true suppresses dotenv v17's stdout "tip" ads on every load (noise
// in production logs, and printed 2-3x per boot since db.ts/redis.ts each
// call dotenv.config() too).
dotenv.config({ quiet: true });
import Fastify, { FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import jwt from 'jsonwebtoken';
import { DB } from "./db";
import { checkRateLimit } from "./redis";
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';

/**
 * Defines data that can be passed between middleware and route handlers.
 */
type Variables = {
  user: {
    id: string;
    email: string;
  };
};

/**
 * --- Trusted client IP ---
 * Rate limiting and login IP logging need the real client IP, but this
 * process may be sitting behind a reverse proxy (nginx, Caddy, a tunnel —
 * whatever you've put in front of it) that terminates the actual internet-
 * facing connection. TRUSTED_IP_HEADER names the header *that* proxy sets
 * with the real client IP.
 *
 * This is only safe to trust if your proxy is the *sole* path to this
 * process — see the deployment notes in README.md. If it isn't (e.g. this
 * container's port is also published directly on the host), any client can
 * set this header to whatever it wants and it will be trusted as-is: there's
 * no way to distinguish a proxy-set value from a forged one at this layer.
 * That's also why there's no default here and no fallback to
 * X-Forwarded-For or request.ip: an unconfigured or wrongly-configured
 * deployment should fail safe (rate limiting simply doesn't activate)
 * rather than trust something spoofable by default.
 *
 * Defined before the Fastify instance (below) so the same function can also
 * back the request logger's remoteAddress field — see logger.serializers.req
 * there. Its parameter type is structural (just needs a `.headers` object),
 * not FastifyRequest specifically, since Fastify's req serializer is handed
 * the raw Node request, not the wrapped one.
 */
const TRUSTED_IP_HEADER = (process.env.TRUSTED_IP_HEADER || '').toLowerCase();

function getTrustedClientIp(request: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  if (!TRUSTED_IP_HEADER) return undefined;
  const value = request.headers[TRUSTED_IP_HEADER];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Initialize the Hono application with strict typing for bindings and variables.
 */
// trustProxy is intentionally off: nothing in this app reads request.ip (see
// getTrustedClientIp above), so there is no reason to have Fastify honor a
// client-settable X-Forwarded-For at all.
//
// bodyLimit is sized for the worst-case /v1/jobs/push payload this API
// actually accepts: 1000 jobs (its own hard cap, checked in the handler) at
// up to ~3.6KB each of validated field content (MAX_FIELD_LENGTH/MAX_URL_LENGTH
// below) plus JSON overhead, comfortably under 4MB. Fastify's own 1MB default
// would otherwise reject a legitimate max-size, max-cap request with a bare
// 413 before this file's own validation (and its clearer error messages) ever
// runs.
const app = Fastify({
  logger: {
    // Fastify's default req serializer logs the raw socket's peer address as
    // remoteAddress — behind a reverse proxy, that's the proxy's own address,
    // not the real client's, which is exactly the "why does the log show a
    // Docker IP" surprise this was written to fix. Overridden to log the same
    // trusted value the app's own rate limiting/IP logging already use
    // (getTrustedClientIp above), rather than reaching for a second, separate
    // trust mechanism (trustProxy + X-Forwarded-For) with different
    // semantics and its own spoofing considerations. Falls back to the raw
    // socket address when no trusted header is present (e.g. local dev),
    // matching Fastify's own default behavior for that case.
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
          host: req.headers.host,
          remoteAddress: getTrustedClientIp(req) || req.socket?.remoteAddress,
          remotePort: req.socket?.remotePort,
        };
      },
    },
  },
  trustProxy: false,
  bodyLimit: 5 * 1024 * 1024,
  // Fastify's default request id is a plain per-process counter ("req-1",
  // "req-2", ...) — fine for correlating a request with its own response
  // line within one still-running process, but it resets to 1 on every
  // restart/redeploy, so two unrelated requests across different container
  // lifetimes can share the same id once logs are aggregated (this app's
  // error responses also echo request.id back to the client as `requestId`
  // for support correlation, which makes the collision worse, not just a
  // log-reading annoyance). A UUID is unique regardless of process history.
  genReqId: () => crypto.randomUUID(),
});
declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string; is_admin: boolean; };
  }
}

// Add request logging

/**
 * --- CORS Configuration ---
 * Restricts the API so it only accepts requests from your official frontend(s).
 * Reads from the ALLOWED_ORIGIN binding (comma-separated) so prod/dev frontends
 * can differ without a code change; defaults to the local dev frontend.
 */
app.register(cors, {
  origin: (origin, cb) => {
    const allowed = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173')
      .split(',')
      .map((o: string) => o.trim());
    // Fail closed on a mismatch: cb(null, false) omits CORS headers entirely
    // rather than returning an arbitrary allowed origin, which cross-origin
    // browser requests would reject anyway (the response's Access-Control-
    // Allow-Origin wouldn't match the caller's actual origin) but is
    // ambiguous to read and easy to get wrong when this is next edited.
    if (!origin || allowed.includes(origin)) { cb(null, true); } else { cb(null, false); }
  },
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['POST', 'GET', 'DELETE', 'OPTIONS'],
  maxAge: 600,
});

/**
 * --- Security Headers ---
 * This is a pure JSON API with no HTML views, so CSP is locked down to
 * default-src 'none' (nothing should ever be allowed to load as a
 * sub-resource of a response from here). Headers like X-Content-Type-Options
 * and HSTS still matter even for a JSON-only API: they stop a browser from
 * MIME-sniffing a response as something executable if it's ever loaded
 * directly (e.g. an error page opened by hand, or embedded by a phishing
 * page).
 */
app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
});

/**
 * --- Rate Limiting Middleware ---
 */
app.addHook('onRequest', async (request, reply) => {
  const ip = getTrustedClientIp(request);

  if (ip) {
    // 100 requests per 60 seconds
    const isAllowed = await checkRateLimit(ip, 100, 60);
    if (!isAllowed) {
      return reply.status(429).send({ error: 'Too Many Requests' });
    }
  }

});
/**
 * --- JWT Authentication Middleware ---
 * Intercepts requests to protected routes, cryptographically verifies the JWT,
 * and ensures the user exists and is not banned in the database.
 */
const authMiddleware = async (request: FastifyRequest, reply: FastifyReply) => {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];

  // Only JWT verification is wrapped here. `next()` must run outside this
  // try/catch — otherwise any error thrown by the downstream route handler
  // (a DB error, a bug in the route) gets mis-reported as an "Invalid token"
  // 401 with leaked internal error text, and never reaches app.onError.
  let payload: Record<string, unknown>;
  try {
    // Verify the JWT signature using the PUBLIC_KEY and RS256 algorithm.
    // Throws an error if the token is forged, tampered with, or expired.
    payload = jwt.verify(token, process.env.PUBLIC_KEY!, { algorithms: ['RS256'] }) as any;
  } catch {
    return reply.status(401).send({ error: 'Invalid token' });
  }

  // A validly-signed token still has to carry a usable subject. Without this,
  // a token missing `id` reaches the database as a bind of `undefined`, which throws and
  // surfaces as a confusing 500 instead of a plain 401.
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    return reply.status(401).send({ error: 'Invalid token' });
  }

  // Validate user state in the database
  const user = await DB.prepare(
    'SELECT id, email, is_banned, token_version, is_admin FROM users WHERE id = ?'
  )
    .bind(payload.id)
    .first<{ id: string; email: string; is_banned: number; token_version: number; is_admin: boolean }>();

  if (!user) {
    return reply.status(401).send({ error: 'User not found' });
  }

  if (user.is_banned) {
    return reply.status(403).send({ error: 'User is banned' });
  }

  // Reject any token minted before the user's last logout-all. A token
  // signed before token_version existed carries no `tv` claim at all, which
  // is treated as version 0 — matching every account's default, so already-
  // issued tokens keep working until the first time logout-all is used.
  const tokenVersion = typeof payload.tv === 'number' ? payload.tv : 0;
  if (tokenVersion !== user.token_version) {
    return reply.status(401).send({ error: 'Token revoked' });
  }

  // Attach user payload to the request context for downstream routes
    request.user = { id: user.id, email: user.email, is_admin: user.is_admin };
};

/**
 * --- Admin Authorization Middleware ---
 * Chained after authMiddleware (which must run first — this only reads
 * request.user, it doesn't authenticate on its own). Gates /v1/admin/*.
 * There's no self-service way to become an admin; see is_admin in schema.sql.
 */
const adminMiddleware = async (request: FastifyRequest, reply: FastifyReply) => {
  if (!request.user?.is_admin) {
    // 404, not 403: a non-admin gets no signal that these routes exist at all.
    return reply.status(404).send({ error: 'Not found' });
  }
};

/**
 * --- Economy & Anti-Abuse Policy ---
 * These are the tuning dials for the Give-to-Get economy. They are deliberately
 * gathered here so the policy can be adjusted without hunting through handlers.
 */

// Free-tier daily pull allowance once a user's credit balance hits 0.
const DAILY_QUOTA = 50;

// Credits granted to a brand-new account. Kept modest on purpose: a large bonus
// is the cheapest thing to farm with throwaway SSO accounts, and the free daily
// quota above already covers evaluating the API before contributing.
const SIGNUP_BONUS = 50;

// Maximum credits a single user can earn from pushing in one UTC day. Without a
// ceiling, fabricated-but-unique URLs mint unlimited credits.
const DAILY_PUSH_CREDIT_CAP = 500;

// Distinct users who must report a job before it is flagged and withdrawn.
const REPORTS_TO_FLAG_JOB = 3;

// Flagged jobs a contributor may accumulate before being auto-banned.
const FLAGS_TO_BAN_USER = 5;

// Upper bounds on stored job fields, to keep junk/oversized rows out of Postgres.
const MAX_FIELD_LENGTH = 512;
const MAX_URL_LENGTH = 2048;

// Jobs older than this are excluded from GET /v1/jobs/pull by default (a
// client can still opt into seeing them with ?include_stale=true). This is
// soft, not destructive: the row and its history aren't touched, it's just
// no longer handed out by default — community reporting (REPORTS_TO_FLAG_JOB
// above) stays the only thing that actually withdraws a job from the pool.
// 60 days is a starting point, not a researched number; tune it once real
// usage shows whether job listings this old are still typically live.
const PULL_MAX_JOB_AGE_DAYS = 60;

/**
 * A pushed job's URL must be a syntactically real http(s) URL with a hostname
 * containing a dot. This won't stop a determined faker, but it removes the
 * zero-effort path of minting credits from strings like "junk1".
 */
const isValidJobUrl = (value: string): boolean => {
  if (value.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.hostname.includes('.') && !parsed.hostname.endsWith('.');
};

// --- API Routes ---

/**
 * Tighter, dedicated limit for /v1/auth/login on top of the blanket global
 * one above — it's the highest-value target for credential stuffing /
 * brute-forcing IdP tokens, and 100/60s (fine for the rest of the API) is far
 * too generous for an auth endpoint specifically. 20/60s comfortably covers
 * a real user retrying a few times (e.g. after an expired OAuth code).
 */
const loginRateLimitMiddleware = async (request: FastifyRequest, reply: FastifyReply) => {
  const ip = getTrustedClientIp(request);
  if (ip) {
    const isAllowed = await checkRateLimit(ip, 20, 60, 'login');
    if (!isAllowed) {
      return reply.status(429).send({ error: 'Too Many Requests' });
    }
  }
};

/**
 * POST /v1/auth/login
 * SSO Login Endpoint. In a full production implementation, this endpoint would verify
 * an IdP-issued JWT (e.g., from Microsoft Entra or Google) against public JWKS before
 * issuing the internal API JWT.
 */
app.post('/v1/auth/login', { preHandler: loginRateLimitMiddleware }, async (request, reply) => {
  // See the equivalent comment in /v1/jobs/push: request.body is already
  // parsed by the time this handler runs (malformed JSON is rejected earlier
  // by Fastify itself, via the global error handler). The optional chaining
  // only guards a technically-valid but non-object JSON body from throwing.
  const body = request.body as any;
  const idp_token = body?.idp_token;
  const sso_provider = body?.sso_provider;

  if (!idp_token || !sso_provider) {
    return reply.status(400).send({ error: 'Missing idp_token or sso_provider' });
  }

  if (sso_provider === 'google' && !process.env.GOOGLE_CLIENT_ID) {
    return reply.status(500).send({ error: 'Server misconfiguration: GOOGLE_CLIENT_ID not set' });
  }
  // Same upfront check as Google above — without it, a missing GitHub secret
  // fails deep inside the token exchange and surfaces as the generic 401
  // "Identity Provider verification failed" (indistinguishable from an
  // actually-invalid code), instead of a clear, debuggable 500.
  if (sso_provider === 'github' && (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET)) {
    return reply
      .status(500)
      .send({ error: 'Server misconfiguration: GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET not set' });
  }

  let email: string | null = null;
  // The IdP's own stable subject identifier — Google's `sub`, GitHub's numeric
  // `id` — NOT the email. This is the real identity key (see users.provider_user_id):
  // unlike email it can't be reassigned or changed by the user, and it's what
  // stops two different providers that happen to verify the same email address
  // from being silently treated as the same account.
  let providerUserId: string | null = null;

  try {
    if (sso_provider === 'google') {
      // Validate Google ID Token against Google's TokenInfo endpoint
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idp_token}`);
      if (!res.ok) throw new Error('Invalid Google token');
      const data = (await res.json()) as any;
      // The tokeninfo endpoint proves the token is *a* valid Google-signed token,
      // not that it was issued for THIS app — without checking `aud`, a token
      // minted for any other Google-sign-in-enabled site would be accepted here.
      if (data.aud !== process.env.GOOGLE_CLIENT_ID) {
        throw new Error('Token audience mismatch');
      }
      if (data.email_verified !== 'true' && data.email_verified !== true) {
        throw new Error('Google email not verified');
      }
      email = data.email;
      providerUserId = data.sub;
    } else if (sso_provider === 'github') {
      // 1. Exchange the GitHub OAuth 'code' for an 'access_token'
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code: idp_token
        })
      });
      const tokenData = (await tokenRes.json()) as any;
      const accessToken = tokenData.access_token;

      if (!accessToken) throw new Error('Invalid GitHub code or missing secrets');

      // 2. Validate GitHub Access Token by fetching the user's profile
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'Career-Agent-API'
        }
      });
      if (!res.ok) throw new Error('Invalid GitHub token');
      const data = (await res.json()) as any;
      // GitHub's numeric user id is the account's permanent identifier — unlike
      // a username or email, it's never reassigned or changed.
      providerUserId = data.id !== undefined && data.id !== null ? String(data.id) : null;

      // 3. GitHub sometimes hides the primary email, so we explicitly fetch their emails
      if (!data.email) {
        const emailRes = await fetch('https://api.github.com/user/emails', {
          headers: { 
            Authorization: `Bearer ${accessToken}`, 
            'User-Agent': 'Career-Agent-API' 
          }
        });
        const emails = (await emailRes.json()) as any[];
        // Only trust verified addresses — GitHub lets an account hold unverified
        // emails, and we don't want to log someone in as an address they don't own.
        email = emails.find((e) => e.primary && e.verified)?.email
          || emails.find((e) => e.verified)?.email;
      } else {
        email = data.email;
      }
    } else {
      return reply.status(400).send({ error: 'Unsupported SSO provider (Only Google/GitHub supported)' });
    }
  } catch (err) {
    // Logged server-side only — the client gets a generic message on purpose
    // (don't hand an attacker a probe for which check failed), but this exact
    // reason (aud mismatch vs. unverified email vs. actually-invalid token)
    // otherwise vanishes, which makes this endpoint painful to debug from the
    // outside. Check `wrangler tail` / the dashboard logs for this line.
    console.error('Login verification failed:', sso_provider, err instanceof Error ? err.message : err);
    return reply.status(401).send({ error: 'Identity Provider verification failed. Token invalid.' });
  }

  if (!email) {
    return reply.status(400).send({ error: 'Failed to extract email from Identity Provider' });
  }
  if (!providerUserId) {
    return reply.status(400).send({ error: 'Failed to extract a stable account id from Identity Provider' });
  }

  // Identity is anchored on (sso_provider, provider_user_id), not email — two
  // different providers can each independently verify the same email address
  // for two different real people/accounts, and emails can be reassigned at
  // the IdP over time, so email alone is never a safe identity key.
  let user = await DB.prepare(
    'SELECT * FROM users WHERE sso_provider = ? AND provider_user_id = ?'
  )
    .bind(sso_provider, providerUserId)
    .first();

  // One-time backward-compat fallback for accounts created before
  // provider_user_id existed (see migrations/0001_provider_scoped_identity.sql):
  // match by (email, sso_provider) only among rows that haven't been backfilled
  // yet, and backfill this row now. This preserves existing users' id/credits/
  // history on their first login post-migration, without ever merging two
  // distinct provider identities into one account.
  if (!user) {
    user = await DB.prepare(
      'SELECT * FROM users WHERE email = ? AND sso_provider = ? AND provider_user_id IS NULL'
    )
      .bind(email, sso_provider)
      .first();
  }

  let userId: string;
  // Same trust boundary as the rate limiter above.
  const clientIp = getTrustedClientIp(request) || 'unknown';

  if (!user) {
    // Register new user and award the initial Give-to-Get signup bonus
    userId = crypto.randomUUID();
    await DB.prepare(
      'INSERT INTO users (id, email, sso_provider, provider_user_id, current_credits, last_login_ip) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(userId, email, sso_provider, providerUserId, SIGNUP_BONUS, clientIp)
      .run();
  } else {
    userId = user.id as string;
    // Update the latest IP and (for the backfill path above, or if the IdP's
    // email for this account simply changed) the email/provider_user_id on file.
    await DB.prepare(
      'UPDATE users SET last_login_ip = ?, email = ?, provider_user_id = ? WHERE id = ?'
    )
      .bind(clientIp, email, providerUserId, userId)
      .run();
  }

  // Construct the JWT payload expiring in 7 days
  const payload = {
    id: userId,
    email: email, // Required for Local API verification
    // Embeds the token_version this account had at issuance, so a later
    // POST /v1/auth/logout-all (which bumps it) invalidates this token even
    // though its signature stays valid. New users start at the schema
    // default (0); an existing user's current value came back on the `user`
    // row fetched above.
    tv: user?.token_version ?? 0,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };
  
  // Sign the token with the internal PRIVATE_KEY using RS256
  const token = jwt.sign(payload, process.env.PRIVATE_KEY!, { algorithm: 'RS256' });

  return reply.status(200).send({
    token: token,
    access_token: token, // Kept for backward compatibility
    token_type: 'bearer',
    expires_in: 604800,
  });
});

/**
 * POST /v1/auth/logout-all
 * Invalidates every JWT previously issued to this account (including the one
 * used to call this endpoint) by bumping token_version — the auth middleware
 * rejects any token whose embedded `tv` no longer matches. There is no
 * separate single-session logout: JWTs are stateless and not tracked
 * individually, so revocation is necessarily all-or-nothing per account.
 */
app.post('/v1/auth/logout-all', { preHandler: authMiddleware }, async (request, reply) => {
  const user = request.user!;
  await DB.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?')
    .bind(user.id)
    .run();
  return reply.send({ success: true, message: 'All tokens for this account have been invalidated.' });
});

/**
 * Apply the Authentication Middleware to all Job Economy routes and the account endpoint
 */

/**
 * POST /v1/jobs/push
 * Give-to-Get Economy: Users upload scraped jobs here to earn API credits.
 * 1 unique job successfully inserted = 1 credit earned.
 */
app.post('/v1/jobs/push', { preHandler: authMiddleware }, async (request, reply) => {
  const user = request.user!;
  // request.body is already fully parsed by the time this handler runs (a
  // genuinely malformed body never reaches here at all — Fastify's own JSON
  // parser rejects it earlier, handled by the global error handler above).
  // The optional chaining below just guards a technically-valid-JSON but
  // non-object body (e.g. a bare `null` or `"hello"`) from throwing on
  // destructure instead of hitting the ordinary validation error below.
  const jobs = (request.body as any)?.jobs;

  if (!jobs || !Array.isArray(jobs)) {
    return reply.status(400).send({ error: 'Invalid payload, expected array of jobs' });
  }

  // Prevent CPU and memory exhaustion on the API server
  if (jobs.length > 1000) {
    return reply.status(413).send({ error: 'Payload too large. Maximum 1000 jobs allowed per request.' });
  }

  const isValidField = (v: unknown): v is string =>
    typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_FIELD_LENGTH;

  // Filter out malformed entries up front, for two reasons: a single job missing
  // a required NOT NULL column would fail the whole chunk's batch transaction
  // below (costing every valid job in that chunk its credit), and unvalidated
  // URLs let anyone mint credits from arbitrary junk strings.
  const validJobs = jobs.filter(
    (job) =>
      job &&
      typeof job === 'object' &&
      isValidField(job.company) &&
      isValidField(job.title) &&
      typeof job.url === 'string' &&
      isValidJobUrl(job.url.trim()) &&
      (job.location === undefined ||
        job.location === null ||
        (typeof job.location === 'string' && job.location.length <= MAX_FIELD_LENGTH))
  );
  const invalidSkipped = jobs.length - validJobs.length;

  let creditsEarned = 0;
  let failed = 0;

  // Utilize database batching to execute multiple inserts in a single network transaction
  const stmts = [];
  const insertJobStmt = DB.prepare(
    // INSERT OR IGNORE skips the insert if the URL violates the UNIQUE constraint
    'INSERT INTO jobs (id, company, title, location, url, scraped_by_user_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
  );

  for (const job of validJobs) {
    const jobId = crypto.randomUUID();
    stmts.push(
      insertJobStmt.bind(jobId, job.company, job.title, job.location ?? null, job.url, user.id)
    );
  }

  if (stmts.length > 0) {
    // Restrict batch calls to 100 statements maximum.
    // We slice the massive array into chunks of 100 and execute them sequentially.
    const CHUNK_SIZE = 100;
    for (let i = 0; i < stmts.length; i += CHUNK_SIZE) {
      const chunk = stmts.slice(i, i + CHUNK_SIZE);
      try {
        const results = await DB.batch(chunk);

        // Tally up credits based on how many rows were actually written (ignoring duplicates)
        for (const result of results) {
          if (result.meta.changes > 0) {
            creditsEarned++;
          }
        }
      } catch (err) {
        // A chunk is one atomic database transaction: if it throws for any reason,
        // none of its rows were written. Don't let that abort the whole request
        // and lose the credit already earned by prior successful chunks.
        failed += chunk.length;
      }
    }
  }

  // Credit the user's account for their contributions, up to the daily earn cap.
  // The jobs themselves are kept either way — they still benefit the shared pool —
  // but credit beyond the cap is not minted, which is what makes bulk fabrication
  // pointless. Guarded + retried like the pull reservation so two concurrent
  // pushes can't both spend the same remaining allowance.
  const today = new Date().toISOString().split('T')[0];
  let creditsAwarded = 0;
  let capReached = false;

  for (let attempt = 0; attempt < 3 && creditsEarned > 0; attempt++) {
    const quotaRow = await DB.prepare(
      'SELECT pushed_today, last_push_date FROM users WHERE id = ?'
    )
      .bind(user.id)
      .first<{ pushed_today: number; last_push_date: string | null }>();

    if (!quotaRow) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const pushedToday = quotaRow.last_push_date === today ? quotaRow.pushed_today : 0;
    const award = Math.min(creditsEarned, Math.max(0, DAILY_PUSH_CREDIT_CAP - pushedToday));

    if (award <= 0) {
      capReached = true;
      break;
    }

    const result = await DB.prepare(
      `UPDATE users
       SET current_credits = current_credits + ?,
           total_pushed = total_pushed + ?,
           pushed_today = CASE WHEN last_push_date = ? THEN pushed_today + ? ELSE ? END,
           last_push_date = ?
       WHERE id = ?
         AND (CASE WHEN last_push_date = ? THEN pushed_today ELSE 0 END) + ? <= ?`
    )
      .bind(
        award,
        creditsEarned,
        today,
        award,
        award,
        today,
        user.id,
        today,
        award,
        DAILY_PUSH_CREDIT_CAP
      )
      .run();

    if (result.meta.changes > 0) {
      creditsAwarded = award;
      capReached = award < creditsEarned;
      break;
    }
    // else: a concurrent push consumed the allowance — re-read and recompute
  }

  return reply.send({
    success: true,
    message: `Pushed ${jobs.length} jobs.`,
    credits_earned: creditsAwarded,
    jobs_accepted: creditsEarned,
    invalid_skipped: invalidSkipped,
    failed,
    ...(capReached
      ? {
          warning: `Daily push credit cap of ${DAILY_PUSH_CREDIT_CAP} reached. Jobs were still stored, but no further credits were earned today.`,
        }
      : {}),
  });
});

/**
 * GET /v1/jobs/pull
 * Give-to-Get Economy: Users consume jobs here, spending their API credits.
 * 1 job pulled = 1 credit spent. Falls back to a strict daily free quota if out of credits.
 */
app.get('/v1/jobs/pull', { preHandler: authMiddleware }, async (request, reply) => {
  const user = request.user!;
  const limitParam = parseInt((request.query as any).limit || '10', 10);
  if (!Number.isFinite(limitParam)) {
    return reply.status(400).send({ error: 'Invalid limit parameter' });
  }
  const limit = Math.min(Math.max(limitParam, 1), 100);
  const today = new Date().toISOString().split('T')[0];
  const includeStale = (request.query as any).include_stale === 'true';

  type Reservation = { want: number; fromCredits: boolean; warningMessage?: string };
  let reservation: Reservation | null = null;

  // Read-modify-write on credits/quota is racy under concurrent requests from the
  // same user, so each attempt "reserves" its slice with a single conditional
  // UPDATE guarded by the precondition (current_credits >= want, or the quota not
  // being exceeded). If another concurrent request wins the row first, the guard
  // fails (0 rows changed) and we retry with freshly-read state instead of
  // overspending credits or double-spending the daily quota.
  for (let attempt = 0; attempt < 3 && !reservation; attempt++) {
    const userData = await DB.prepare(
      'SELECT current_credits, pulled_today, last_pull_date FROM users WHERE id = ?'
    )
      .bind(user.id)
      .first();

    if (!userData) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const credits = userData.current_credits as number;
    const pulledToday =
      userData.last_pull_date === today ? (userData.pulled_today as number) : 0;

    if (credits > 0) {
      // Contributor State: limit by their requested amount or remaining credits
      const want = Math.min(limit, credits);
      let warningMessage: string | undefined;
      if (limitParam > credits) {
        warningMessage = `Requested ${limitParam} jobs but limited to ${credits} due to your current credit balance.`;
      } else if (limitParam > 100) {
        warningMessage = `Requested ${limitParam} jobs but capped at the hard limit of 100 jobs per request.`;
      }

      const result = await DB.prepare(
        `UPDATE users
         SET current_credits = current_credits - ?,
             pulled_today = CASE WHEN last_pull_date = ? THEN pulled_today + ? ELSE ? END,
             last_pull_date = ?
         WHERE id = ? AND current_credits >= ?`
      )
        .bind(want, today, want, want, today, user.id, want)
        .run();

      if (result.meta.changes > 0) {
        reservation = { want, fromCredits: true, warningMessage };
      }
      // else: credits changed concurrently between our read and write — retry
    } else {
      // Freerider State: blocked once the daily free quota is exhausted.
      // status(403) explicitly: every other error path in this file does the
      // same, and a bare reply.send() here would default to 200 — silently
      // telling any client that checks response.ok/2xx (which is most HTTP
      // client code, including fetch's res.ok) that this succeeded.
      if (pulledToday >= DAILY_QUOTA) {
        return reply.status(403).send({ error: 'Daily quota exceeded. Push more jobs to earn credits.' });
      }
      const want = Math.min(limit, DAILY_QUOTA - pulledToday);
      const warningMessage =
        limitParam > want
          ? `Requested ${limitParam} jobs but limited to ${want} due to your remaining daily free quota.`
          : undefined;

      const result = await DB.prepare(
        `UPDATE users
         SET pulled_today = CASE WHEN last_pull_date = ? THEN pulled_today + ? ELSE ? END,
             last_pull_date = ?
         WHERE id = ?
           AND (CASE WHEN last_pull_date = ? THEN pulled_today ELSE 0 END) + ? <= ?`
      )
        .bind(today, want, want, today, user.id, today, want, DAILY_QUOTA)
        .run();

      if (result.meta.changes > 0) {
        reservation = { want, fromCredits: false, warningMessage };
      }
    }
  }

  if (!reservation) {
    return reply.status(409).send({ error: 'Could not process pull request due to concurrent updates, please retry.' });
  }

  // Exclude jobs this user has already pulled before so consuming the feed
  // actually advances instead of handing back the same newest N jobs forever.
  // Fetches one row beyond what was reserved, purely to answer has_more below
  // without a client having to spend a follow-up call to find out the pool is
  // empty — trimmed back to what was actually reserved/paid for immediately
  // after, so that lookahead row is never claimed, charged for, or marked seen.
  // Also excludes jobs older than PULL_MAX_JOB_AGE_DAYS unless the caller
  // opted in with ?include_stale=true — soft staleness, not a delete: the
  // rows aren't touched, they're just not handed out by default.
  const candidates = await DB.prepare(
    `SELECT id, company, title, location, url, created_at FROM jobs
     WHERE is_flagged = false
       AND id NOT IN (SELECT job_id FROM pulled_jobs WHERE user_id = ?)
       AND (? OR created_at >= NOW() - (INTERVAL '1 day' * ?))
     ORDER BY created_at DESC LIMIT ?`
  )
    .bind(user.id, includeStale, PULL_MAX_JOB_AGE_DAYS, reservation.want + 1)
    .all();

  const hasMore = candidates.results.length > reservation.want;
  const toClaim = candidates.results.slice(0, reservation.want);

  // Claim each candidate via INSERT OR IGNORE on the (user_id, job_id) primary
  // key *before* trusting it as delivered. Two concurrent requests for the same
  // user can both select the same candidate (neither has claimed it yet at
  // SELECT time) — only one INSERT wins the PK race, so only the winner keeps
  // that job. This is what actually prevents the same job being handed out
  // twice, not the SELECT filter above (which only stops *already-committed*
  // pulls from being re-served).
  let confirmed: any[] = [];
  if (toClaim.length > 0) {
    const markSeenStmt = DB.prepare(
      'INSERT INTO pulled_jobs (user_id, job_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
    );
    const claimResults = await DB.batch(
      toClaim.map((job: any) => markSeenStmt.bind(user.id, job.id))
    );
    confirmed = toClaim.filter((_: any, i: number) => claimResults[i].meta.changes > 0);
  }

  const jobsReturnedCount = confirmed.length;
  const unused = reservation.want - jobsReturnedCount;

  // Refund whatever portion of the reservation couldn't be fulfilled (e.g. the
  // shared pool ran dry, was already fully seen, or was lost to a concurrent
  // claim above), so users aren't charged for jobs they didn't actually receive.
  if (unused > 0) {
    if (reservation.fromCredits) {
      await DB.prepare(
        'UPDATE users SET current_credits = current_credits + ?, pulled_today = pulled_today - ? WHERE id = ?'
      )
        .bind(unused, unused, user.id)
        .run();
    } else {
      await DB.prepare(
        'UPDATE users SET pulled_today = pulled_today - ? WHERE id = ?'
      )
        .bind(unused, user.id)
        .run();
    }
  }

  if (jobsReturnedCount > 0) {
    await DB.prepare('UPDATE users SET total_pulled = total_pulled + ? WHERE id = ?')
      .bind(jobsReturnedCount, user.id)
      .run();
  }

  return reply.send({
    success: true,
    warning: reservation.warningMessage,
    jobs: confirmed,
    deducted: reservation.fromCredits ? jobsReturnedCount : 0,
    quota_used: reservation.fromCredits ? 0 : jobsReturnedCount,
    // Whether at least one more unconsumed, unflagged job existed beyond this
    // batch at query time — a hint for whether to call again, not a hard
    // guarantee (the pool is shared and shifts between requests). Since
    // pulling costs credits/quota, this is deliberately not a stateful cursor:
    // simply calling pull() again already advances through the corpus for
    // free (pulled_jobs excludes anything this user has already received),
    // so has_more only needs to answer "is it worth calling again," not "where
    // exactly was I."
    has_more: hasMore,
  });
});

/**
 * POST /v1/jobs/report
 * Community quality control: report a job as fake, dead, or spam.
 *
 * Only a user who actually pulled the job may report it, and the (job_id,
 * reporter_user_id) primary key allows one report per user per job — together
 * these stop a single account from flagging jobs on its own or brigading a
 * contributor it has never interacted with. Once REPORTS_TO_FLAG_JOB distinct
 * users report the same job it is withdrawn from circulation, the contributor's
 * earned credit for it is clawed back, and a strike is recorded; at
 * FLAGS_TO_BAN_USER strikes the contributor is auto-banned.
 */
app.post('/v1/jobs/report', { preHandler: authMiddleware }, async (request, reply) => {
  const user = request.user!;
  // See the equivalent comment in /v1/jobs/push above: request.body is
  // already parsed here, and the optional chaining only guards a
  // technically-valid but non-object JSON body from throwing on destructure.
  const body = request.body as any;
  const job_id = body?.job_id;
  const reason = body?.reason;

  if (typeof job_id !== 'string' || job_id.length === 0) {
    return reply.status(400).send({ error: 'Missing or invalid job_id' });
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return reply.status(400).send({ error: 'Invalid reason' });
  }

  const job = await DB.prepare(
    'SELECT id, scraped_by_user_id, is_flagged FROM jobs WHERE id = ?'
  )
    .bind(job_id)
    // scraped_by_user_id is nullable: the contributor may have since deleted
    // their account (DELETE /v1/me detaches the job rather than deleting it
    // — see migrations/0004_nullable_job_contributor.sql).
    .first<{ id: string; scraped_by_user_id: string | null; is_flagged: boolean }>();

  if (!job) {
    return reply.status(404).send({ error: 'Job not found' });
  }

  // Gate reporting on having actually received the job. Without this, reporting
  // becomes a free weapon against any contributor.
  const hasPulled = await DB.prepare(
    'SELECT 1 FROM pulled_jobs WHERE user_id = ? AND job_id = ?'
  )
    .bind(user.id, job_id)
    .first();

  if (!hasPulled) {
    return reply.status(403).send({ error: 'You can only report a job you have pulled' });
  }

  const insert = await DB.prepare(
    'INSERT INTO job_reports (job_id, reporter_user_id, reason) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
  )
    .bind(job_id, user.id, typeof reason === 'string' ? reason.slice(0, MAX_FIELD_LENGTH) : null)
    .run();

  if (insert.meta.changes === 0) {
    return reply.send({ success: true, message: 'You have already reported this job.' });
  }

  // ::int, not left as COUNT(*)'s native bigint: pg returns bigint columns as
  // strings (to avoid silent precision loss above 2^53), which would leak a
  // stringified report_count into the JSON response below instead of a number.
  const countRow = await DB.prepare(
    'SELECT COUNT(*)::int AS report_count FROM job_reports WHERE job_id = ?'
  )
    .bind(job_id)
    .first<{ report_count: number }>();

  const reportCount = countRow?.report_count ?? 0;
  let jobFlagged = false;
  let contributorBanned = false;

  // Flag exactly once, on the transition past the threshold. The is_flagged = false
  // guard makes this idempotent under concurrent reports, so the contributor
  // can't be penalised twice for the same job.
  if (reportCount >= REPORTS_TO_FLAG_JOB && job.is_flagged === false) {
    const flagResult = await DB.prepare(
      'UPDATE jobs SET is_flagged = true WHERE id = ? AND is_flagged = false'
    )
      .bind(job_id)
      .run();

    if (flagResult.meta.changes > 0) {
      jobFlagged = true;

      // No strike to record if the contributor has since deleted their
      // account — there's no user row left to credit it against.
      if (job.scraped_by_user_id) {
        // Claw back the credit earned for this job and record a strike. Credits
        // are floored at 0 rather than going negative, which would silently push
        // the contributor into the free-quota branch of the pull economy.
        const strike = await DB.prepare(
          // GREATEST, not MAX: Postgres's MAX is aggregate-only (no two-argument
          // scalar form) — this floors at 0 without going through an aggregate.
          `UPDATE users
           SET flagged_count = flagged_count + 1,
               current_credits = GREATEST(0, current_credits - 1)
           WHERE id = ?
           RETURNING flagged_count`
        )
          .bind(job.scraped_by_user_id)
          .first<{ flagged_count: number }>();

        if (strike && strike.flagged_count >= FLAGS_TO_BAN_USER) {
          const ban = await DB.prepare(
            'UPDATE users SET is_banned = true WHERE id = ? AND is_banned = false'
          )
            .bind(job.scraped_by_user_id)
            .run();
          contributorBanned = ban.meta.changes > 0;
        }
      }
    }
  }

  return reply.send({
    success: true,
    report_count: reportCount,
    reports_needed_to_flag: REPORTS_TO_FLAG_JOB,
    job_flagged: jobFlagged,
    contributor_banned: contributorBanned,
  });
});

/**
 * GET /v1/me
 * Returns the authenticated user's current Give-to-Get economy balance and stats.
 */
app.get('/v1/me', { preHandler: authMiddleware }, async (request, reply) => {
  const user = request.user!;

  const userData = await DB.prepare(
    `SELECT id, email, current_credits, total_pushed, total_pulled,
            pulled_today, last_pull_date, pushed_today, last_push_date, flagged_count
     FROM users WHERE id = ?`
  )
    .bind(user.id)
    .first<{
      id: string;
      email: string;
      current_credits: number;
      total_pushed: number;
      total_pulled: number;
      pulled_today: number;
      last_pull_date: string | null;
      pushed_today: number;
      last_push_date: string | null;
      flagged_count: number;
    }>();

  if (!userData) {
    return reply.status(404).send({ error: 'User not found' });
  }

  const today = new Date().toISOString().split('T')[0];
  const pulledToday = userData.last_pull_date === today ? userData.pulled_today : 0;
  const pushedToday = userData.last_push_date === today ? userData.pushed_today : 0;

  return reply.send({
    id: userData.id,
    email: userData.email,
    current_credits: userData.current_credits,
    daily_quota_remaining: Math.max(0, DAILY_QUOTA - pulledToday),
    daily_push_credits_remaining: Math.max(0, DAILY_PUSH_CREDIT_CAP - pushedToday),
    flagged_count: userData.flagged_count,
  });
});

/**
 * GET /v1/me/export
 * Self-service data export: everything this account's own data touches —
 * profile, jobs contributed, jobs pulled, reports filed. Community data other
 * users generated (e.g. reports *against* this account's jobs) isn't this
 * account's own data and isn't included.
 */
app.get('/v1/me/export', { preHandler: authMiddleware }, async (request, reply) => {
  const user = request.user!;

  const profile = await DB.prepare(
    `SELECT id, email, sso_provider, current_credits, total_pushed, total_pulled,
            flagged_count, is_banned, created_at
     FROM users WHERE id = ?`
  )
    .bind(user.id)
    .first();

  if (!profile) {
    return reply.status(404).send({ error: 'User not found' });
  }

  const [contributed, pulled, reported] = await Promise.all([
    DB.prepare(
      `SELECT id, company, title, location, url, is_flagged, created_at
       FROM jobs WHERE scraped_by_user_id = ? ORDER BY created_at DESC`
    )
      .bind(user.id)
      .all(),
    DB.prepare(
      `SELECT j.id, j.company, j.title, j.url, p.pulled_at
       FROM pulled_jobs p JOIN jobs j ON j.id = p.job_id
       WHERE p.user_id = ? ORDER BY p.pulled_at DESC`
    )
      .bind(user.id)
      .all(),
    DB.prepare(
      `SELECT job_id, reason, created_at FROM job_reports
       WHERE reporter_user_id = ? ORDER BY created_at DESC`
    )
      .bind(user.id)
      .all(),
  ]);

  return reply.send({
    profile,
    jobs_contributed: contributed.results,
    jobs_pulled: pulled.results,
    reports_filed: reported.results,
  });
});

/**
 * DELETE /v1/me
 * Self-service account deletion. Erases this account's own row (email, IP,
 * credit/stat history) along with pulled_jobs/job_reports rows that
 * reference it (ON DELETE CASCADE — those are this account's own activity
 * records). Jobs this account contributed are NOT deleted: scraped_by_user_id
 * is ON DELETE SET NULL (see migrations/0004_nullable_job_contributor.sql) —
 * jobs are a shared resource other users may already rely on, not this
 * account's personal data once contributed to the pool. This also
 * immediately invalidates every JWT for the account, since authMiddleware's
 * user lookup will simply find no row.
 *
 * Requires `{"confirm": true}` in the body — a bare DELETE (e.g. an
 * accidental request from a buggy client) does nothing.
 */
app.delete('/v1/me', { preHandler: authMiddleware }, async (request, reply) => {
  const user = request.user!;
  const body = request.body as any;

  if (body?.confirm !== true) {
    return reply.status(400).send({ error: 'Confirm deletion by sending {"confirm": true}' });
  }

  await DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();

  return reply.send({ success: true, message: 'Account and personal data deleted.' });
});

/**
 * --- Admin API ---
 * Replaces the raw-SQL moderation workflow in DATABASE_QUERIES.md with
 * authenticated, audited endpoints for the same operations. There's no
 * self-service way to become an admin — bootstrap the first one directly:
 *   UPDATE users SET is_admin = true WHERE email = 'you@example.com';
 * adminMiddleware 404s (not 403) for a non-admin, so a logged-in
 * non-admin poking at these paths can't distinguish them from a typo'd route.
 */
const ADMIN_MAX_CREDITS = 1_000_000;

/** Records one row in admin_actions. See GET /v1/admin/audit-log. */
async function logAdminAction(
  adminId: string,
  action: string,
  targetType: 'user' | 'job',
  targetId: string,
  details?: string
): Promise<void> {
  await DB.prepare(
    'INSERT INTO admin_actions (id, admin_user_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(crypto.randomUUID(), adminId, action, targetType, targetId, details ?? null)
    .run();
}

app.get(
  '/v1/admin/users',
  { preHandler: [authMiddleware, adminMiddleware] },
  async (request, reply) => {
    const email = (request.query as any)?.email;
    if (typeof email !== 'string' || email.length === 0) {
      return reply.status(400).send({ error: 'Missing email query parameter' });
    }
    // Email is no longer unique (see provider_user_id) — a lookup can
    // legitimately return more than one account.
    const users = await DB.prepare(
      `SELECT id, email, sso_provider, current_credits, total_pushed, total_pulled,
              flagged_count, is_banned, is_admin, created_at
       FROM users WHERE email = ? ORDER BY created_at ASC`
    )
      .bind(email)
      .all();
    return reply.send({ users: users.results });
  }
);

app.get(
  '/v1/admin/users/:id',
  { preHandler: [authMiddleware, adminMiddleware] },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const targetUser = await DB.prepare(
      `SELECT id, email, sso_provider, current_credits, total_pushed, total_pulled,
              flagged_count, is_banned, is_admin, created_at
       FROM users WHERE id = ?`
    )
      .bind(id)
      .first();
    if (!targetUser) {
      return reply.status(404).send({ error: 'User not found' });
    }
    return reply.send({ user: targetUser });
  }
);

app.post(
  '/v1/admin/users/:id/credits',
  { preHandler: [authMiddleware, adminMiddleware] },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const credits = (request.body as any)?.credits;
    if (
      typeof credits !== 'number' ||
      !Number.isInteger(credits) ||
      credits < 0 ||
      credits > ADMIN_MAX_CREDITS
    ) {
      return reply
        .status(400)
        .send({ error: `credits must be an integer between 0 and ${ADMIN_MAX_CREDITS}` });
    }
    // Sets the absolute balance (matches DATABASE_QUERIES.md's "Grant a user
    // N credits" pattern), not a delta — the caller decides the resulting total.
    const result = await DB.prepare('UPDATE users SET current_credits = ? WHERE id = ?')
      .bind(credits, id)
      .run();
    if (result.meta.changes === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }
    await logAdminAction(request.user!.id, 'set_credits', 'user', id, `credits=${credits}`);
    return reply.send({ success: true, current_credits: credits });
  }
);

app.post(
  '/v1/admin/users/:id/ban',
  { preHandler: [authMiddleware, adminMiddleware] },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await DB.prepare('UPDATE users SET is_banned = true WHERE id = ?')
      .bind(id)
      .run();
    if (result.meta.changes === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }
    await logAdminAction(request.user!.id, 'ban', 'user', id);
    return reply.send({ success: true });
  }
);

app.post(
  '/v1/admin/users/:id/unban',
  { preHandler: [authMiddleware, adminMiddleware] },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await DB.prepare('UPDATE users SET is_banned = false WHERE id = ?')
      .bind(id)
      .run();
    if (result.meta.changes === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }
    await logAdminAction(request.user!.id, 'unban', 'user', id);
    return reply.send({ success: true });
  }
);

app.get(
  '/v1/admin/jobs/flagged',
  { preHandler: [authMiddleware, adminMiddleware] },
  async (request, reply) => {
    const limitParam = parseInt((request.query as any)?.limit || '50', 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
    const jobs = await DB.prepare(
      `SELECT id, company, title, location, url, scraped_by_user_id, created_at
       FROM jobs WHERE is_flagged = true ORDER BY created_at DESC LIMIT ?`
    )
      .bind(limit)
      .all();
    return reply.send({ jobs: jobs.results });
  }
);

app.post(
  '/v1/admin/jobs/:id/unflag',
  { preHandler: [authMiddleware, adminMiddleware] },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await DB.prepare('UPDATE jobs SET is_flagged = false WHERE id = ?')
      .bind(id)
      .run();
    if (result.meta.changes === 0) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    await logAdminAction(request.user!.id, 'unflag_job', 'job', id);
    return reply.send({ success: true });
  }
);

/**
 * GET /v1/admin/jobs/:id/reports
 * Who reported a job and why — the API equivalent of DATABASE_QUERIES.md's
 * "Analyze Why a Job Was Reported" query. Works for any job, not just
 * already-flagged ones, so a borderline case can be reviewed before it hits
 * the auto-flag threshold.
 */
app.get(
  '/v1/admin/jobs/:id/reports',
  { preHandler: [authMiddleware, adminMiddleware] },
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await DB.prepare('SELECT id FROM jobs WHERE id = ?').bind(id).first();
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    // A plain JOIN, not LEFT JOIN: job_reports.reporter_user_id is NOT NULL
    // with ON DELETE CASCADE, so a report row can never outlive its reporter.
    const reports = await DB.prepare(
      `SELECT r.reporter_user_id, u.email AS reporter_email, r.reason, r.created_at
       FROM job_reports r JOIN users u ON u.id = r.reporter_user_id
       WHERE r.job_id = ? ORDER BY r.created_at ASC`
    )
      .bind(id)
      .all();
    return reply.send({ job_id: id, reports: reports.results });
  }
);

/**
 * GET /v1/admin/audit-log
 * Every write made through /v1/admin/* — see logAdminAction above.
 */
app.get(
  '/v1/admin/audit-log',
  { preHandler: [authMiddleware, adminMiddleware] },
  async (request, reply) => {
    const limitParam = parseInt((request.query as any)?.limit || '50', 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
    // LEFT JOIN, not a plain JOIN: admin_user_id is ON DELETE SET NULL, so a
    // past action's row outlives an admin who later deletes their account —
    // admin_email comes back null for those rather than the row vanishing.
    const actions = await DB.prepare(
      `SELECT a.id, a.admin_user_id, u.email AS admin_email, a.action, a.target_type,
              a.target_id, a.details, a.created_at
       FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_user_id
       ORDER BY a.created_at DESC LIMIT ?`
    )
      .bind(limit)
      .all();
    return reply.send({ actions: actions.results });
  }
);

/**
 * GET /v1/admin/stats
 * Aggregate system metrics — the API equivalent of DATABASE_QUERIES.md's
 * "Total System Metrics" and "View Top Contributors" queries.
 */
app.get(
  '/v1/admin/stats',
  { preHandler: [authMiddleware, adminMiddleware] },
  async (request, reply) => {
    const [totals, topContributors] = await Promise.all([
      DB.prepare(
        `SELECT
           (SELECT COUNT(*)::int FROM users) AS total_users,
           (SELECT COUNT(*)::int FROM users WHERE is_banned = true) AS total_banned_users,
           (SELECT COUNT(*)::int FROM jobs) AS total_jobs,
           (SELECT COUNT(*)::int FROM jobs WHERE is_flagged = true) AS total_flagged_jobs,
           (SELECT COUNT(*)::int FROM jobs
              WHERE is_flagged = false
                AND created_at < NOW() - (INTERVAL '1 day' * ?)
           ) AS total_stale_jobs,
           (SELECT COUNT(*)::int FROM job_reports) AS total_reports`
      )
        .bind(PULL_MAX_JOB_AGE_DAYS)
        .first(),
      DB.prepare(
        `SELECT email, total_pushed, current_credits, is_banned
         FROM users ORDER BY total_pushed DESC LIMIT 10`
      ).all(),
    ]);
    return reply.send({ ...(totals ?? {}), top_contributors: topContributors.results });
  }
);

/**
 * GET /
 * Unauthenticated root — a bare 404 here isn't a great first impression for
 * anyone (a contributor, a curious visitor) who just opens the API's domain
 * in a browser. Stays plain JSON, not HTML/a redirect, to match this being
 * a pure JSON API throughout (see the CSP default-src 'none' above).
 */
app.get('/', async (request, reply) => {
  return reply.send({
    name: 'CareerAgent API',
    version: process.env.GIT_COMMIT_HASH || 'unknown',
    docs: 'https://github.com/koteshrv/career-agent-api/blob/main/API_REFERENCE.md',
    repo: 'https://github.com/koteshrv/career-agent-api',
    health: '/health',
  });
});

/**
 * GET /health
 * Unauthenticated liveness/readiness probe for uptime monitoring.
 */
app.get('/health', async (request, reply) => {
  const version = process.env.GIT_COMMIT_HASH || 'unknown';
  try {
    await DB.prepare('SELECT 1').first();
    return reply.status(200).send({ status: 'ok', database: 'ok', version });
  } catch {
    return reply.status(503).send({ status: 'degraded', database: 'unreachable', version });
  }
});

/**
 * --- Global Error Handler ---
 */
app.setErrorHandler((error: FastifyError, request, reply) => {
  request.log.error(error);
  // Fastify itself assigns a 4xx statusCode for errors it catches before a
  // route handler ever runs — malformed JSON, a body over bodyLimit, an
  // unmatched route. Those are genuine client errors and worth preserving
  // (Fastify's own message text for them is safe to expose). Anything
  // without an explicit 4xx — a DB error, a bug in a handler — is treated as
  // an unexpected server-side failure and gets a generic message; no
  // internal error text or stack ever reaches the client either way.
  const statusCode =
    typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;
  const message = statusCode < 500 ? error.message : 'Internal server error';
  return reply.status(statusCode).send({ error: message, requestId: request.id });
});

// Builds and configures the app but never listens — that's index.ts's job.
// Splitting these apart is what lets tests exercise real routes via
// app.inject() against a real Postgres/Redis without ever opening a socket.
export default app;
