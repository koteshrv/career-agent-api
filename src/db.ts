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
    const res = await pool.query(this.queryText, this.params);
    return res.rows[0] || null;
  }

  async all() {
    const res = await pool.query(this.queryText, this.params);
    return { results: res.rows };
  }

  async run() {
    const res = await pool.query(this.queryText, this.params);
    return { success: true, meta: { changes: res.rowCount } };
  }
}

export const DB = {
  prepare: (queryText: string) => new PgStatement(queryText),
  batch: async (statements: PgStatement[]) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const stmt of statements) {
        const res = await client.query(stmt.queryText, stmt.params);
        results.push({ success: true, meta: { changes: res.rowCount } });
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
