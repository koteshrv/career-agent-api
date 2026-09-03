import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import { cors } from 'hono/cors';

/**
 * Cloudflare Worker Bindings
 * Defines the environment variables and resources available to the Worker.
 */
type Bindings = {
  DB: D1Database;      // Cloudflare D1 Serverless SQLite Database
  JWT_SECRET: string;  // Secret key used to sign and verify JWTs
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
 * Restricts the API so it only accepts requests from your official frontend.
 * (Change the origin to your production frontend URL when deployed!)
 */
app.use('*', cors({
  origin: ['http://localhost:5173'],
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

app.use('*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 100;

  const record = rateLimitMap.get(ip);
  if (!record || record.resetTime < now) {
    // Initialize or reset the window for this IP
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
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
  const { idp_token, sso_provider } = await c.req.json();

  if (!idp_token || !sso_provider) {
    return c.json({ error: 'Missing idp_token or sso_provider' }, 400);
  }

  let email: string | null = null;

  try {
    if (sso_provider === 'google') {
      // Validate Google ID Token against Google's TokenInfo endpoint
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idp_token}`);
      if (!res.ok) throw new Error('Invalid Google token');
      const data = (await res.json()) as any;
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
 * Apply the Authentication Middleware to all Job Economy routes
 */
app.use('/api/jobs/*', authMiddleware);

/**
 * POST /api/jobs/push
 * Give-to-Get Economy: Users upload scraped jobs here to earn API credits.
 * 1 unique job successfully inserted = 1 credit earned.
 */
app.post('/api/jobs/push', async (c) => {
  const user = c.get('user');
  const { jobs } = await c.req.json();

  if (!jobs || !Array.isArray(jobs)) {
    return c.json({ error: 'Invalid payload, expected array of jobs' }, 400);
  }

  let creditsEarned = 0;

  // Utilize D1 Batch API to execute multiple inserts in a single network transaction
  const stmts = [];
  const insertJobStmt = c.env.DB.prepare(
    // INSERT OR IGNORE skips the insert if the URL violates the UNIQUE constraint
    'INSERT OR IGNORE INTO jobs (id, company, title, location, url, scraped_by_user_id) VALUES (?, ?, ?, ?, ?, ?)'
  );

  for (const job of jobs) {
    const jobId = crypto.randomUUID();
    stmts.push(
      insertJobStmt.bind(jobId, job.company, job.title, job.location, job.url, user.id)
    );
  }

  if (stmts.length > 0) {
    const results = await c.env.DB.batch(stmts);
    
    // Tally up credits based on how many rows were actually written (ignoring duplicates)
    for (const result of results) {
      if (result.meta.changes > 0) {
        creditsEarned++;
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
  const limit = Math.min(Math.max(limitParam, 1), 100);

  // Retrieve current economy state for the user
  const userData = await c.env.DB.prepare(
    'SELECT current_credits, pulled_today, last_pull_date FROM users WHERE id = ?'
  )
    .bind(user.id)
    .first();

  if (!userData) {
    return c.json({ error: 'User not found' }, 404);
  }

  let credits = userData.current_credits as number;
  let pulledToday = userData.pulled_today as number;
  let lastPullDate = userData.last_pull_date as string | null;
  
  const today = new Date().toISOString().split('T')[0];

  // Reset daily free quota tracker if a new day has started
  if (lastPullDate !== today) {
    pulledToday = 0;
    lastPullDate = today;
  }

  const DAILY_QUOTA = 50;
  let maxJobsToPull = limit;

  // Economy Enforcement
  if (credits <= 0) {
    // Freerider State: Block request if daily free quota is exhausted
    if (pulledToday >= DAILY_QUOTA) {
      return c.json({ 
        error: 'Daily quota exceeded. Push more jobs to earn credits.' 
      }, 403);
    }
    // Cap the request limit to whatever free quota is remaining today
    maxJobsToPull = Math.min(limit, DAILY_QUOTA - pulledToday);
  } else {
    // Contributor State: Limit by their requested amount or their remaining positive credits
    maxJobsToPull = Math.min(limit, credits);
  }

  // Fetch jobs from the database
  const jobs = await c.env.DB.prepare(
    'SELECT id, company, title, location, url, created_at FROM jobs ORDER BY created_at DESC LIMIT ?'
  )
    .bind(maxJobsToPull)
    .all();

  const jobsReturnedCount = jobs.results.length;

  if (jobsReturnedCount > 0) {
    if (credits > 0) {
      // Deduct credits and update usage stats
      await c.env.DB.prepare(
        'UPDATE users SET current_credits = current_credits - ?, total_pulled = total_pulled + ?, pulled_today = ?, last_pull_date = ? WHERE id = ?'
      )
        .bind(jobsReturnedCount, jobsReturnedCount, pulledToday + jobsReturnedCount, today, user.id)
        .run();
    } else {
      // User is on the free tier; only update usage stats (do not create negative credits)
      await c.env.DB.prepare(
        'UPDATE users SET total_pulled = total_pulled + ?, pulled_today = ?, last_pull_date = ? WHERE id = ?'
      )
        .bind(jobsReturnedCount, pulledToday + jobsReturnedCount, today, user.id)
        .run();
    }
  }

  return c.json({
    success: true,
    jobs: jobs.results,
    deducted: credits > 0 ? jobsReturnedCount : 0,
    quota_used: credits <= 0 ? jobsReturnedCount : 0
  });
});

export default app;
