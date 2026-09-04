import { Hono } from 'hono';
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
const authMiddleware = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.split(' ')[1];
  
  try {
    // Verify the JWT signature using the backend secret and HS256 algorithm.
    // Throws an error if the token is forged, tampered with, or expired.
    const payload = await verify(token, c.env.JWT_SECRET, 'HS256');
    
    // Validate user state in the database
    const user = await c.env.DB.prepare('SELECT id, email, is_banned FROM users WHERE id = ?')
      .bind(payload.id)
      .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 401);
    }

    if (user.is_banned) {
      return c.json({ error: 'User is banned' }, 403);
    }

    // Attach user payload to the request context for downstream routes
    c.set('user', { id: user.id, email: user.email });
    await next();
  } catch (err) {
    const error = err as Error;
    return c.json({ error: 'Invalid token', details: error.message || error.toString() }, 401);
  }
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
        email = emails.find((e) => e.primary)?.email || emails[0]?.email;
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
      'INSERT INTO users (id, email, sso_provider, current_credits) VALUES (?, ?, ?, 300)'
    )
      .bind(userId, email, sso_provider)
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

  const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

  // Filter out malformed entries up front. Without this, a single job missing a
  // required NOT NULL column fails the whole chunk's batch transaction below,
  // costing every valid job in that chunk its credit.
  const validJobs = jobs.filter(
    (job) =>
      job &&
      typeof job === 'object' &&
      isNonEmptyString(job.company) &&
      isNonEmptyString(job.title) &&
      isNonEmptyString(job.url) &&
      (job.location === undefined || job.location === null || typeof job.location === 'string')
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

  // Credit the user's account for their contributions
  if (creditsEarned > 0) {
    await c.env.DB.prepare(
      'UPDATE users SET current_credits = current_credits + ?, total_pushed = total_pushed + ? WHERE id = ?'
    )
      .bind(creditsEarned, creditsEarned, user.id)
      .run();
  }

  return c.json({
    success: true,
    message: `Pushed ${jobs.length} jobs.`,
    credits_earned: creditsEarned,
    invalid_skipped: invalidSkipped,
    failed,
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
  const DAILY_QUOTA = 50;

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
     WHERE id NOT IN (SELECT job_id FROM pulled_jobs WHERE user_id = ?)
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
 * GET /api/me
 * Returns the authenticated user's current Give-to-Get economy balance and stats.
 */
app.get('/api/me', async (c) => {
  const user = c.get('user');

  const userData = await c.env.DB.prepare(
    'SELECT id, email, current_credits, total_pushed, total_pulled, pulled_today, last_pull_date FROM users WHERE id = ?'
  )
    .bind(user.id)
    .first();

  if (!userData) {
    return c.json({ error: 'User not found' }, 404);
  }

  const today = new Date().toISOString().split('T')[0];
  const DAILY_QUOTA = 50;
  const pulledToday = userData.last_pull_date === today ? (userData.pulled_today as number) : 0;

  return c.json({
    id: userData.id,
    email: userData.email,
    current_credits: userData.current_credits,
    total_pushed: userData.total_pushed,
    total_pulled: userData.total_pulled,
    daily_quota_remaining: Math.max(0, DAILY_QUOTA - pulledToday),
  });
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
