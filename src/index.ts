import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { sign, verify } from 'hono/jwt';
import { cors } from 'hono/cors';

/**
 * Cloudflare Worker Bindings
 * Defines the environment variables and resources available to the Worker.
 */
type Bindings = {
  DB: D1Database;           // Cloudflare D1 Serverless SQLite Database
  JWT_SECRET: string;       // Secret key used to sign and verify JWTs
  GOOGLE_CLIENT_ID: string; // OAuth client ID this API accepts Google ID tokens for (audience check)
  ALLOWED_ORIGIN?: string;  // Comma-separated list of allowed CORS origins (defaults to local dev)
};

/**
 * Context Variables
 * Defines data that can be passed between middleware and route handlers.
 */
type Variables = {
  user: {
    id: string;
    email: string;
  };
};

/**
 * Initialize the Hono application with strict typing for bindings and variables.
 */
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * --- CORS Configuration ---
 * Restricts the API so it only accepts requests from your official frontend(s).
 * Reads from the ALLOWED_ORIGIN binding (comma-separated) so prod/dev frontends
 * can differ without a code change; defaults to the local dev frontend.
 */
app.use('*', cors({
  origin: (origin, c) => {
    const allowed = (c.env.ALLOWED_ORIGIN || 'http://localhost:5173')
      .split(',')
      .map((o: string) => o.trim());
    return origin && allowed.includes(origin) ? origin : allowed[0];
  },
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  maxAge: 600,
}));

/**
 * --- Rate Limiting Middleware ---
 * Provides basic in-memory rate limiting to protect the API from spam.
 * Note: For production, this should be replaced with Cloudflare WAF Rate Limiting,
 * as in-memory state is not shared across different Cloudflare Edge nodes.
 */
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_PRUNE_THRESHOLD = 10000;

app.use('*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 100;

  const record = rateLimitMap.get(ip);
  if (!record || record.resetTime < now) {
    // Initialize or reset the window for this IP
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });

    // Bound memory: an isolate that sees many unique IPs would otherwise
    // accumulate stale entries forever since they're never evicted on their own.
    if (rateLimitMap.size > RATE_LIMIT_PRUNE_THRESHOLD) {
      for (const [key, entry] of rateLimitMap) {
        if (entry.resetTime < now) rateLimitMap.delete(key);
      }
    }
  } else {
    // Increment and check limits
    record.count++;
    if (record.count > maxRequests) {
      return c.json({ error: 'Too Many Requests' }, 429);
    }
  }

  await next();
});

/**
 * --- JWT Authentication Middleware ---
 * Intercepts requests to protected routes, cryptographically verifies the JWT,
 * and ensures the user exists and is not banned in the database.
 */
const authMiddleware: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> = async (
  c,
  next
) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.split(' ')[1];

  // Only JWT verification is wrapped here. `next()` must run outside this
  // try/catch — otherwise any error thrown by the downstream route handler
  // (a DB error, a bug in the route) gets mis-reported as an "Invalid token"
  // 401 with leaked internal error text, and never reaches app.onError.
  let payload: Record<string, unknown>;
  try {
    // Verify the JWT signature using the backend secret and HS256 algorithm.
    // Throws an error if the token is forged, tampered with, or expired.
    payload = await verify(token, c.env.JWT_SECRET, 'HS256');
  } catch {
    return c.json({ error: 'Invalid token' }, 401);
  }

  // A validly-signed token still has to carry a usable subject. Without this,
  // a token missing `id` reaches D1 as a bind of `undefined`, which throws and
  // surfaces as a confusing 500 instead of a plain 401.
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    return c.json({ error: 'Invalid token' }, 401);
  }

  // Validate user state in the database
  const user = await c.env.DB.prepare('SELECT id, email, is_banned FROM users WHERE id = ?')
    .bind(payload.id)
    .first<{ id: string; email: string; is_banned: number }>();

  if (!user) {
    return c.json({ error: 'User not found' }, 401);
  }

  if (user.is_banned) {
    return c.json({ error: 'User is banned' }, 403);
  }

  // Attach user payload to the request context for downstream routes
  c.set('user', { id: user.id, email: user.email });
  await next();
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

// Upper bounds on stored job fields, to keep junk/oversized rows out of D1.
const MAX_FIELD_LENGTH = 512;
const MAX_URL_LENGTH = 2048;

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
 * POST /api/auth/login
 * SSO Login Endpoint. In a full production implementation, this endpoint would verify
 * an IdP-issued JWT (e.g., from Microsoft Entra or Google) against public JWKS before
 * issuing the internal API JWT.
 */
app.post('/api/auth/login', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const { idp_token, sso_provider } = body;

  if (!idp_token || !sso_provider) {
    return c.json({ error: 'Missing idp_token or sso_provider' }, 400);
  }

  if (sso_provider === 'google' && !c.env.GOOGLE_CLIENT_ID) {
    return c.json({ error: 'Server misconfiguration: GOOGLE_CLIENT_ID not set' }, 500);
  }

  let email: string | null = null;

  try {
    if (sso_provider === 'google') {
      // Validate Google ID Token against Google's TokenInfo endpoint
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idp_token}`);
      if (!res.ok) throw new Error('Invalid Google token');
      const data = (await res.json()) as any;
      // The tokeninfo endpoint proves the token is *a* valid Google-signed token,
      // not that it was issued for THIS app — without checking `aud`, a token
      // minted for any other Google-sign-in-enabled site would be accepted here.
      if (data.aud !== c.env.GOOGLE_CLIENT_ID) {
        throw new Error('Token audience mismatch');
      }
      if (data.email_verified !== 'true' && data.email_verified !== true) {
        throw new Error('Google email not verified');
      }
      email = data.email;
    } else if (sso_provider === 'github') {
      // Validate GitHub Access Token by fetching the user's profile
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${idp_token}`,
          'User-Agent': 'Career-Agent-API'
        }
      });
      if (!res.ok) throw new Error('Invalid GitHub token');
      const data = (await res.json()) as any;
      
      // GitHub sometimes hides the primary email, so we explicitly fetch their emails
      if (!data.email) {
        const emailRes = await fetch('https://api.github.com/user/emails', {
          headers: { 
            Authorization: `Bearer ${idp_token}`, 
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
      return c.json({ error: 'Unsupported SSO provider (Only Google/GitHub supported)' }, 400);
    }
  } catch (err) {
    return c.json({ error: 'Identity Provider verification failed. Token invalid.' }, 401);
  }

  if (!email) {
    return c.json({ error: 'Failed to extract email from Identity Provider' }, 400);
  }

  let user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first();

  let userId: string;

  if (!user) {
    // Register new user and award the initial Give-to-Get signup bonus
    userId = crypto.randomUUID();
    await c.env.DB.prepare(
      'INSERT INTO users (id, email, sso_provider, current_credits) VALUES (?, ?, ?, ?)'
    )
      .bind(userId, email, sso_provider, SIGNUP_BONUS)
      .run();
  } else {
    userId = user.id as string;
  }

  // Construct the JWT payload expiring in 7 days
  const payload = {
    id: userId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };
  
  // Sign the token with the internal JWT secret
  const token = await sign(payload, c.env.JWT_SECRET, 'HS256');

  return c.json({
    access_token: token,
    token_type: 'bearer',
    expires_in: 604800,
  });
});

/**
 * Apply the Authentication Middleware to all Job Economy routes and the account endpoint
 */
app.use('/api/jobs/*', authMiddleware);
app.use('/api/me', authMiddleware);

/**
 * POST /api/jobs/push
 * Give-to-Get Economy: Users upload scraped jobs here to earn API credits.
 * 1 unique job successfully inserted = 1 credit earned.
 */
app.post('/api/jobs/push', async (c) => {
  const user = c.get('user');
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const { jobs } = body;

  if (!jobs || !Array.isArray(jobs)) {
    return c.json({ error: 'Invalid payload, expected array of jobs' }, 400);
  }

  // Prevent CPU and memory exhaustion on the Cloudflare Free Tier Worker
  if (jobs.length > 1000) {
    return c.json({ error: 'Payload too large. Maximum 1000 jobs allowed per request.' }, 413);
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

  // Utilize D1 Batch API to execute multiple inserts in a single network transaction
  const stmts = [];
  const insertJobStmt = c.env.DB.prepare(
    // INSERT OR IGNORE skips the insert if the URL violates the UNIQUE constraint
    'INSERT OR IGNORE INTO jobs (id, company, title, location, url, scraped_by_user_id) VALUES (?, ?, ?, ?, ?, ?)'
  );

  for (const job of validJobs) {
    const jobId = crypto.randomUUID();
    stmts.push(
      insertJobStmt.bind(jobId, job.company, job.title, job.location ?? null, job.url, user.id)
    );
  }

  if (stmts.length > 0) {
    // Cloudflare D1 restricts batch calls to 100 statements maximum.
    // We slice the massive array into chunks of 100 and execute them sequentially.
    const CHUNK_SIZE = 100;
    for (let i = 0; i < stmts.length; i += CHUNK_SIZE) {
      const chunk = stmts.slice(i, i + CHUNK_SIZE);
      try {
        const results = await c.env.DB.batch(chunk);

        // Tally up credits based on how many rows were actually written (ignoring duplicates)
        for (const result of results) {
          if (result.meta.changes > 0) {
            creditsEarned++;
          }
        }
      } catch (err) {
        // A chunk is one atomic D1 transaction: if it throws for any reason,
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
    const quotaRow = await c.env.DB.prepare(
      'SELECT pushed_today, last_push_date FROM users WHERE id = ?'
    )
      .bind(user.id)
      .first<{ pushed_today: number; last_push_date: string | null }>();

    if (!quotaRow) {
      return c.json({ error: 'User not found' }, 404);
    }

    const pushedToday = quotaRow.last_push_date === today ? quotaRow.pushed_today : 0;
    const award = Math.min(creditsEarned, Math.max(0, DAILY_PUSH_CREDIT_CAP - pushedToday));

    if (award <= 0) {
      capReached = true;
      break;
    }

    const result = await c.env.DB.prepare(
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

  return c.json({
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
 * GET /api/jobs/pull
 * Give-to-Get Economy: Users consume jobs here, spending their API credits.
 * 1 job pulled = 1 credit spent. Falls back to a strict daily free quota if out of credits.
 */
app.get('/api/jobs/pull', async (c) => {
  const user = c.get('user');
  const limitParam = parseInt(c.req.query('limit') || '10', 10);
  if (!Number.isFinite(limitParam)) {
    return c.json({ error: 'Invalid limit parameter' }, 400);
  }
  const limit = Math.min(Math.max(limitParam, 1), 100);
  const today = new Date().toISOString().split('T')[0];

  type Reservation = { want: number; fromCredits: boolean; warningMessage?: string };
  let reservation: Reservation | null = null;

  // Read-modify-write on credits/quota is racy under concurrent requests from the
  // same user, so each attempt "reserves" its slice with a single conditional
  // UPDATE guarded by the precondition (current_credits >= want, or the quota not
  // being exceeded). If another concurrent request wins the row first, the guard
  // fails (0 rows changed) and we retry with freshly-read state instead of
  // overspending credits or double-spending the daily quota.
  for (let attempt = 0; attempt < 3 && !reservation; attempt++) {
    const userData = await c.env.DB.prepare(
      'SELECT current_credits, pulled_today, last_pull_date FROM users WHERE id = ?'
    )
      .bind(user.id)
      .first();

    if (!userData) {
      return c.json({ error: 'User not found' }, 404);
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

      const result = await c.env.DB.prepare(
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
      // Freerider State: blocked once the daily free quota is exhausted
      if (pulledToday >= DAILY_QUOTA) {
        return c.json(
          { error: 'Daily quota exceeded. Push more jobs to earn credits.' },
          403
        );
      }
      const want = Math.min(limit, DAILY_QUOTA - pulledToday);
      const warningMessage =
        limitParam > want
          ? `Requested ${limitParam} jobs but limited to ${want} due to your remaining daily free quota.`
          : undefined;

      const result = await c.env.DB.prepare(
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
    return c.json(
      { error: 'Could not process pull request due to concurrent updates, please retry.' },
      409
    );
  }

  // Exclude jobs this user has already pulled before so consuming the feed
  // actually advances instead of handing back the same newest N jobs forever.
  const candidates = await c.env.DB.prepare(
    `SELECT id, company, title, location, url, created_at FROM jobs
     WHERE is_flagged = 0
       AND id NOT IN (SELECT job_id FROM pulled_jobs WHERE user_id = ?)
     ORDER BY created_at DESC LIMIT ?`
  )
    .bind(user.id, reservation.want)
    .all();

  // Claim each candidate via INSERT OR IGNORE on the (user_id, job_id) primary
  // key *before* trusting it as delivered. Two concurrent requests for the same
  // user can both select the same candidate (neither has claimed it yet at
  // SELECT time) — only one INSERT wins the PK race, so only the winner keeps
  // that job. This is what actually prevents the same job being handed out
  // twice, not the SELECT filter above (which only stops *already-committed*
  // pulls from being re-served).
  let confirmed: any[] = [];
  if (candidates.results.length > 0) {
    const markSeenStmt = c.env.DB.prepare(
      'INSERT OR IGNORE INTO pulled_jobs (user_id, job_id) VALUES (?, ?)'
    );
    const claimResults = await c.env.DB.batch(
      candidates.results.map((job: any) => markSeenStmt.bind(user.id, job.id))
    );
    confirmed = candidates.results.filter((_: any, i: number) => claimResults[i].meta.changes > 0);
  }

  const jobsReturnedCount = confirmed.length;
  const unused = reservation.want - jobsReturnedCount;

  // Refund whatever portion of the reservation couldn't be fulfilled (e.g. the
  // shared pool ran dry, was already fully seen, or was lost to a concurrent
  // claim above), so users aren't charged for jobs they didn't actually receive.
  if (unused > 0) {
    if (reservation.fromCredits) {
      await c.env.DB.prepare(
        'UPDATE users SET current_credits = current_credits + ?, pulled_today = pulled_today - ? WHERE id = ?'
      )
        .bind(unused, unused, user.id)
        .run();
    } else {
      await c.env.DB.prepare(
        'UPDATE users SET pulled_today = pulled_today - ? WHERE id = ?'
      )
        .bind(unused, user.id)
        .run();
    }
  }

  if (jobsReturnedCount > 0) {
    await c.env.DB.prepare('UPDATE users SET total_pulled = total_pulled + ? WHERE id = ?')
      .bind(jobsReturnedCount, user.id)
      .run();
  }

  return c.json({
    success: true,
    warning: reservation.warningMessage,
    jobs: confirmed,
    deducted: reservation.fromCredits ? jobsReturnedCount : 0,
    quota_used: reservation.fromCredits ? 0 : jobsReturnedCount,
  });
});

/**
 * POST /api/jobs/report
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
app.post('/api/jobs/report', async (c) => {
  const user = c.get('user');
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { job_id, reason } = body;

  if (typeof job_id !== 'string' || job_id.length === 0) {
    return c.json({ error: 'Missing or invalid job_id' }, 400);
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return c.json({ error: 'Invalid reason' }, 400);
  }

  const job = await c.env.DB.prepare(
    'SELECT id, scraped_by_user_id, is_flagged FROM jobs WHERE id = ?'
  )
    .bind(job_id)
    .first<{ id: string; scraped_by_user_id: string; is_flagged: number }>();

  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  // Gate reporting on having actually received the job. Without this, reporting
  // becomes a free weapon against any contributor.
  const hasPulled = await c.env.DB.prepare(
    'SELECT 1 FROM pulled_jobs WHERE user_id = ? AND job_id = ?'
  )
    .bind(user.id, job_id)
    .first();

  if (!hasPulled) {
    return c.json({ error: 'You can only report a job you have pulled' }, 403);
  }

  const insert = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO job_reports (job_id, reporter_user_id, reason) VALUES (?, ?, ?)'
  )
    .bind(job_id, user.id, typeof reason === 'string' ? reason.slice(0, MAX_FIELD_LENGTH) : null)
    .run();

  if (insert.meta.changes === 0) {
    return c.json({ success: true, message: 'You have already reported this job.' });
  }

  const countRow = await c.env.DB.prepare(
    'SELECT COUNT(*) AS report_count FROM job_reports WHERE job_id = ?'
  )
    .bind(job_id)
    .first<{ report_count: number }>();

  const reportCount = countRow?.report_count ?? 0;
  let jobFlagged = false;
  let contributorBanned = false;

  // Flag exactly once, on the transition past the threshold. The is_flagged = 0
  // guard makes this idempotent under concurrent reports, so the contributor
  // can't be penalised twice for the same job.
  if (reportCount >= REPORTS_TO_FLAG_JOB && job.is_flagged === 0) {
    const flagResult = await c.env.DB.prepare(
      'UPDATE jobs SET is_flagged = 1 WHERE id = ? AND is_flagged = 0'
    )
      .bind(job_id)
      .run();

    if (flagResult.meta.changes > 0) {
      jobFlagged = true;

      // Claw back the credit earned for this job and record a strike. Credits
      // are floored at 0 rather than going negative, which would silently push
      // the contributor into the free-quota branch of the pull economy.
      const strike = await c.env.DB.prepare(
        `UPDATE users
         SET flagged_count = flagged_count + 1,
             current_credits = MAX(0, current_credits - 1)
         WHERE id = ?
         RETURNING flagged_count`
      )
        .bind(job.scraped_by_user_id)
        .first<{ flagged_count: number }>();

      if (strike && strike.flagged_count >= FLAGS_TO_BAN_USER) {
        const ban = await c.env.DB.prepare(
          'UPDATE users SET is_banned = 1 WHERE id = ? AND is_banned = 0'
        )
          .bind(job.scraped_by_user_id)
          .run();
        contributorBanned = ban.meta.changes > 0;
      }
    }
  }

  return c.json({
    success: true,
    report_count: reportCount,
    reports_needed_to_flag: REPORTS_TO_FLAG_JOB,
    job_flagged: jobFlagged,
    contributor_banned: contributorBanned,
  });
});

/**
 * GET /api/me
 * Returns the authenticated user's current Give-to-Get economy balance and stats.
 */
app.get('/api/me', async (c) => {
  const user = c.get('user');

  const userData = await c.env.DB.prepare(
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
    return c.json({ error: 'User not found' }, 404);
  }

  const today = new Date().toISOString().split('T')[0];
  const pulledToday = userData.last_pull_date === today ? userData.pulled_today : 0;
  const pushedToday = userData.last_push_date === today ? userData.pushed_today : 0;

  return c.json({
    id: userData.id,
    email: userData.email,
    current_credits: userData.current_credits,
    total_pushed: userData.total_pushed,
    total_pulled: userData.total_pulled,
    daily_quota_remaining: Math.max(0, DAILY_QUOTA - pulledToday),
    daily_push_credits_remaining: Math.max(0, DAILY_PUSH_CREDIT_CAP - pushedToday),
    flagged_count: userData.flagged_count,
  });
});

/**
 * GET /health
 * Unauthenticated liveness/readiness probe for uptime monitoring. Also verifies
 * the D1 binding actually answers, since a healthy Worker with a broken database
 * binding is not actually serving.
 */
app.get('/health', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ status: 'ok', database: 'ok' });
  } catch {
    return c.json({ status: 'degraded', database: 'unreachable' }, 503);
  }
});

/**
 * --- Global Error Handler ---
 * Safety net for unexpected exceptions (e.g. D1 errors) so clients always get
 * clean JSON instead of Hono's default error response.
 */
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
