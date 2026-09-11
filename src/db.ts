import { Pool, types } from 'pg';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

// pg's default type parser turns a DATE column into a JS Date object. Every
// daily-quota/cap check in this app compares a stored date against
// `new Date().toISOString().split('T')[0]` (a plain 'YYYY-MM-DD' string) with
// `===` — against a Date object that's always false, silently breaking same-
// day quota/cap tracking (a fresh reset is indistinguishable from "already
// used today"). Parsing DATE as the raw string Postgres sends keeps it
// directly comparable to that format everywhere it's used.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Fail fast rather than queue indefinitely if the pool is exhausted.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Guards against one runaway/hung query pinning a connection forever —
  // this is a shared crowdsourced API, so no single request's query should
  // be able to starve the pool for everyone else.
  statement_timeout: 10_000,
});

class PgStatement {
  queryText: string;
  params: any[];

  constructor(queryText: string, params: any[] = []) {
    // Convert ? to $1, $2, etc. for Postgres
    let counter = 1;
    this.queryText = queryText.replace(/\?/g, () => `$${counter++}`);
    this.params = params;
  }

  bind(...params: any[]) {
    return new PgStatement(this.queryText.replace(/\$\d+/g, '?'), params);
  }

  async first<T = any>(): Promise<T | null> {
    const res = await pool.query(this.queryText, this.params);
    return (res.rows[0] as T) || null;
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    const res = await pool.query(this.queryText, this.params);
    return { results: res.rows as T[] };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    const res = await pool.query(this.queryText, this.params);
    return { success: true, meta: { changes: res.rowCount ?? 0 } };
  }
}

// Exported only so tests can call pool.end() during teardown — application
// code should go through DB, not the pool directly.
export { pool };

export const DB = {
  prepare: (queryText: string) => new PgStatement(queryText),
  batch: async (statements: PgStatement[]) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results: { success: boolean; meta: { changes: number } }[] = [];
      for (const stmt of statements) {
        const res = await client.query(stmt.queryText, stmt.params);
        results.push({ success: true, meta: { changes: res.rowCount ?? 0 } });
      }
      await client.query('COMMIT');
      return results;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
};
