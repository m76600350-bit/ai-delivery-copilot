const { Pool } = require('@neondatabase/serverless');

let pool;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

// Cached across warm serverless invocations so schema creation only runs once per instance.
let schemaReady = null;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS jira_tokens (
        id SERIAL PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        cloud_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS issues (
        id SERIAL PRIMARY KEY,
        issue_key TEXT UNIQUE NOT NULL,
        project TEXT,
        issue_type TEXT,
        summary TEXT,
        status TEXT,
        status_category TEXT,
        priority TEXT,
        assignee TEXT,
        team TEXT,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        cycle_time NUMERIC,
        sprint TEXT,
        labels TEXT,
        last_synced_at TIMESTAMPTZ,
        is_deleted BOOLEAN NOT NULL DEFAULT false
      );

      CREATE TABLE IF NOT EXISTS issue_history (
        id SERIAL PRIMARY KEY,
        issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_issue_history_issue_id ON issue_history(issue_id);
    `).then(() => true).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

module.exports = { getPool, ensureSchema };
