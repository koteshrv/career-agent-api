import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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

  async first() {
  async first<T = any>(): Promise<T | null> {
    const res = await pool.query(this.queryText, this.params);
    return res.rows[0] || null;
    return (res.rows[0] as T) || null;
  }

  async all() {
  async all<T = any>(): Promise<{ results: T[] }> {
    const res = await pool.query(this.queryText, this.params);
    return { results: res.rows };
    return { results: res.rows as T[] };
  }

  async run() {
  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    const res = await pool.query(this.queryText, this.params);
    return { success: true, meta: { changes: res.rowCount } };
    return { success: true, meta: { changes: res.rowCount ?? 0 } };
  }
}

export const DB = {
  prepare: (queryText: string) => new PgStatement(queryText),
  batch: async (statements: PgStatement[]) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      const results: { success: boolean; meta: { changes: number } }[] = [];
      for (const stmt of statements) {
        const res = await client.query(stmt.queryText, stmt.params);
        results.push({ success: true, meta: { changes: res.rowCount } });
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
