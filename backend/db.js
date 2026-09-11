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

      -- One row per Jira sprint we've decided to track — only the active
      -- sprint(s) and the last few closed ones per board (see the Agile sync
      -- in routes/jira.js), not full sprint history.
      CREATE TABLE IF NOT EXISTS sprints (
        id SERIAL PRIMARY KEY,
        jira_sprint_id INTEGER UNIQUE NOT NULL,
        name TEXT,
        start_date TIMESTAMPTZ,
        end_date TIMESTAMPTZ,
        complete_date TIMESTAMPTZ,
        state TEXT,
        goal TEXT,
        board_id INTEGER
      );

      -- issue_sprints is a many-to-many junction rather than a column on
      -- issues, since an issue can (and often does) pass through more than
      -- one sprint over its lifetime — a single issues.sprint_id would only
      -- ever capture the latest one. added_after_sprint_start answers "was
      -- this issue in the sprint at kickoff, or added mid-sprint" for that
      -- specific issue/sprint pairing.
      CREATE TABLE IF NOT EXISTS issue_sprints (
        issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        sprint_id INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
        added_after_sprint_start BOOLEAN,
        PRIMARY KEY (issue_id, sprint_id)
      );

      CREATE INDEX IF NOT EXISTS idx_issue_sprints_sprint_id ON issue_sprints(sprint_id);

      -- One row per Jira issue link, from the perspective of issue_id (the
      -- link's issuelinks field on that issue) — link_type is the phrase
      -- describing that direction (e.g. "is blocked by", "blocks"), not just
      -- the link type's name, so "блокер" detection can match on it directly.
      -- linked_issue_id is nullable: the other issue may not be synced (a
      -- different, unsynced project) — linked_issue_key always identifies it.
      -- Rebuilt from scratch for an issue on every sync (delete then
      -- re-insert), so it never accumulates stale links.
      CREATE TABLE IF NOT EXISTS issue_links (
        id SERIAL PRIMARY KEY,
        issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        linked_issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
        linked_issue_key TEXT NOT NULL,
        link_type TEXT,
        linked_issue_status TEXT,
        linked_issue_status_category TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_issue_links_issue_id ON issue_links(issue_id);

      -- One row per (team, assignee) — the role assigned via Настройки →
      -- "Команды и роли". A missing row means "роль не задана"; such members
      -- are excluded from the WIP-limit sum in routes/teams.js.
      CREATE TABLE IF NOT EXISTS team_roles (
        id SERIAL PRIMARY KEY,
        team TEXT NOT NULL,
        assignee_name TEXT NOT NULL,
        role TEXT NOT NULL,
        UNIQUE (team, assignee_name)
      );

      -- One-time migration: the very first version of wip_limits (global,
      -- one row per status, no team/role) predates the per-team/per-role
      -- redesign below and is structurally incompatible with it — drop it
      -- once, identified by having status_name but no team column, before
      -- the CREATE TABLE IF NOT EXISTS below runs, so that statement always
      -- ends up creating (or already finding) the new schema. This never
      -- fires again once the table is on the new schema.
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'wip_limits' AND column_name = 'status_name'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'wip_limits' AND column_name = 'team'
        ) THEN
          DROP TABLE wip_limits;
        END IF;
      END $$;

      -- Per-(team, status, role) WIP-per-person limit, configured via the
      -- "Настройка WIP" modal in Настройки. A team's overall limit (used in
      -- the "Команды" table and the WIP health signal) is the sum, over
      -- every row for that team, of limit_value * how many of that team's
      -- members currently have that role in team_roles — NOT a flat
      -- per-status limit the way the first cut of this feature had it, and
      -- not global across teams either.
      CREATE TABLE IF NOT EXISTS wip_limits (
        id SERIAL PRIMARY KEY,
        team TEXT NOT NULL,
        status_name TEXT NOT NULL,
        role TEXT NOT NULL,
        limit_value INTEGER,
        UNIQUE (team, status_name, role)
      );

      -- One row per point where an issue's status *category* changed —
      -- the first row for an issue is a synthetic "genesis" entry at
      -- created_at with whatever category it started in, every other row
      -- is a real changelog transition. This is what lets the Спринты
      -- screen reconstruct "what category was this issue in as of day D"
      -- (burndown/CFD) without re-fetching changelog: take the last row
      -- with changed_at <= D. Built from the same changelog replay as
      -- cycle_time/status_time_breakdown (see computeLeadCycleReopen),
      -- rebuilt from scratch (delete then re-insert) whenever that replay
      -- actually runs — same as issue_links.
      CREATE TABLE IF NOT EXISTS issue_status_events (
        id SERIAL PRIMARY KEY,
        issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        changed_at TIMESTAMPTZ NOT NULL,
        status TEXT,
        status_category TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_issue_status_events_issue_id ON issue_status_events(issue_id, changed_at);

      -- Backfills columns on tables created before they existed.
      ALTER TABLE issues ADD COLUMN IF NOT EXISTS story_points NUMERIC;
      ALTER TABLE issues ADD COLUMN IF NOT EXISTS lead_time_days NUMERIC;
      ALTER TABLE issues ADD COLUMN IF NOT EXISTS reopen_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE jira_tokens ADD COLUMN IF NOT EXISTS site_url TEXT;
      ALTER TABLE sync_history ADD COLUMN IF NOT EXISTS sprints_synced INTEGER;
      ALTER TABLE sync_history ADD COLUMN IF NOT EXISTS sprint_issue_links INTEGER;
      -- Per-status total time spent, computed from the same changelog replay
      -- as cycle_time (see computeLeadCycleReopen) — [{status, days}] in
      -- chronological order of first entering each status. NULL means it
      -- hasn't been computed for this issue yet (changelog fetch failed or
      -- predates this column), not "zero time anywhere" — the Задачи detail
      -- panel hides the block entirely in that case rather than showing an
      -- empty/misleading list.
      ALTER TABLE issues ADD COLUMN IF NOT EXISTS status_time_breakdown JSONB;

      -- Which widgets are on the Dashboard (Overview) and in what order —
      -- no drag&drop, so "order" only ever changes by widgets being
      -- added/removed, never reshuffled in place. enabled = false is a soft
      -- remove (keeps its old position, so re-adding restores where it was)
      -- rather than deleting the row.
      CREATE TABLE IF NOT EXISTS dashboard_widgets (
        id SERIAL PRIMARY KEY,
        widget_type TEXT UNIQUE NOT NULL,
        position INTEGER NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true
      );

      -- Seeds the four pre-existing dashboard blocks as the default widget
      -- set, but only the very first time (table genuinely empty) — a user
      -- who has since removed everything keeps a blank dashboard rather
      -- than having it silently repopulate.
      INSERT INTO dashboard_widgets (widget_type, position, enabled)
      SELECT * FROM (VALUES
        ('stats_cards', 0, true),
        ('by_status', 1, true),
        ('by_team', 2, true),
        ('by_type', 3, true)
      ) AS defaults(widget_type, position, enabled)
      WHERE NOT EXISTS (SELECT 1 FROM dashboard_widgets);
    `).then(() => true).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

module.exports = { getPool, ensureSchema };
