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
        site_url TEXT,
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
        lead_time_days NUMERIC,
        reopen_count INTEGER NOT NULL DEFAULT 0,
        sprint TEXT,
        story_points NUMERIC,
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

      -- Maps our internal canonical field names (sprint, team, story_points, ...)
      -- to the actual Jira custom field id for a given site, since those ids
      -- differ per Jira Cloud instance and can't be hardcoded.
      CREATE TABLE IF NOT EXISTS jira_field_mapping (
        id SERIAL PRIMARY KEY,
        cloud_id TEXT NOT NULL,
        canonical_field TEXT NOT NULL,
        jira_field_id TEXT NOT NULL,
        UNIQUE (cloud_id, canonical_field)
      );

      -- Single-row table (id always 1) tracking the currently running (or
      -- most recently finished) sync, so a separate request can poll it for
      -- progress while POST /api/jira/sync is still in flight — the two
      -- requests may land on different serverless invocations, so this has
      -- to live in the DB rather than in-process memory.
      CREATE TABLE IF NOT EXISTS sync_progress (
        id INTEGER PRIMARY KEY DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle',
        total INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        CONSTRAINT sync_progress_singleton CHECK (id = 1)
      );

      -- Append-only log of past sync runs, shown in Settings — distinct from
      -- sync_progress, which only ever holds the *current* run's state.
      CREATE TABLE IF NOT EXISTS sync_history (
        id SERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ,
        source TEXT NOT NULL DEFAULT 'Jira API',
        total INTEGER,
        status TEXT NOT NULL,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sync_history_started_at ON sync_history(started_at DESC);

      -- Backfills columns on tables created before they existed.
      ALTER TABLE issues ADD COLUMN IF NOT EXISTS story_points NUMERIC;
      ALTER TABLE issues ADD COLUMN IF NOT EXISTS lead_time_days NUMERIC;
      ALTER TABLE issues ADD COLUMN IF NOT EXISTS reopen_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE jira_tokens ADD COLUMN IF NOT EXISTS site_url TEXT;
    `).then(() => true).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

module.exports = { getPool, ensureSchema };
