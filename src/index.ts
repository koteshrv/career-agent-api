import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  user: {
    id: string;
    email: string;
  };
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// --- Rate Limiting Middleware (Basic In-Memory for edge instances) ---
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
app.use('*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxRequests = 100;

  const record = rateLimitMap.get(ip);
  if (!record || record.resetTime < now) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
  } else {
    record.count++;
    if (record.count > maxRequests) {
      return c.json({ error: 'Too Many Requests' }, 429);
    }
  }
  await next();
});

// --- Auth Middleware ---
const authMiddleware = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = await verify(token, c.env.JWT_SECRET);
    
    // Check if user is banned
    const user = await c.env.DB.prepare('SELECT id, email, is_banned FROM users WHERE id = ?')
      .bind(payload.id)
      .first();

    if (!user) {
      return c.json({ error: 'User not found' }, 401);
    }

    if (user.is_banned) {
      return c.json({ error: 'User is banned' }, 403);
    }

    c.set('user', { id: user.id, email: user.email });
    await next();
  } catch (err) {
    const error = err as Error;
    return c.json({ error: 'Invalid token', details: error.message || error.toString() }, 401);
  }
};

// --- Routes ---

app.get('/', (c) => c.text('Career Agent API is running!'));

app.post('/api/auth/login', async (c) => {
  const { email, sso_provider } = await c.req.json();

  if (!email || !sso_provider) {
    return c.json({ error: 'Missing email or sso_provider' }, 400);
  }

  let user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first();

  let userId: string;

  if (!user) {
    userId = crypto.randomUUID();
    await c.env.DB.prepare(
      'INSERT INTO users (id, email, sso_provider, current_credits) VALUES (?, ?, ?, 300)'
    )
      .bind(userId, email, sso_provider)
      .run();
  } else {
    userId = user.id as string;
  }

  const payload = {
    id: userId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };
  
  const token = await sign(payload, c.env.JWT_SECRET);

  return c.json({
    access_token: token,
    token_type: 'bearer',
    expires_in: 604800,
  });
});

app.use('/api/jobs/*', authMiddleware);

app.post('/api/jobs/push', async (c) => {
  const user = c.get('user');
  const { jobs } = await c.req.json();

  if (!jobs || !Array.isArray(jobs)) {
    return c.json({ error: 'Invalid payload, expected array of jobs' }, 400);
  }

  let creditsEarned = 0;

  const stmts = [];
  const insertJobStmt = c.env.DB.prepare(
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
    for (const result of results) {
      if (result.meta.changes > 0) {
        creditsEarned++;
      }
    }
  }

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

app.get('/api/jobs/pull', async (c) => {
  const user = c.get('user');
  const limitParam = parseInt(c.req.query('limit') || '10', 10);
  const limit = Math.min(Math.max(limitParam, 1), 100);

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

  if (lastPullDate !== today) {
    pulledToday = 0;
    lastPullDate = today;
  }

  const DAILY_QUOTA = 50;
  let maxJobsToPull = limit;

  if (credits <= 0) {
    if (pulledToday >= DAILY_QUOTA) {
      return c.json({ 
        error: 'Daily quota exceeded. Push more jobs to earn credits.' 
      }, 403);
    }
    maxJobsToPull = Math.min(limit, DAILY_QUOTA - pulledToday);
  } else {
    maxJobsToPull = Math.min(limit, credits);
  }

  const jobs = await c.env.DB.prepare(
    'SELECT id, company, title, location, url, created_at FROM jobs ORDER BY created_at DESC LIMIT ?'
  )
    .bind(maxJobsToPull)
    .all();

  const jobsReturnedCount = jobs.results.length;

  if (jobsReturnedCount > 0) {
    if (credits > 0) {
      await c.env.DB.prepare(
        'UPDATE users SET current_credits = current_credits - ?, total_pulled = total_pulled + ?, pulled_today = ?, last_pull_date = ? WHERE id = ?'
      )
        .bind(jobsReturnedCount, jobsReturnedCount, pulledToday + jobsReturnedCount, today, user.id)
        .run();
    } else {
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

