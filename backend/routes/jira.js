const express = require('express');
const { ensureSchema, getPool } = require('../db');
const { getValidAccessToken, JIRA_API_BASE } = require('../lib/jiraAuth');

const router = express.Router();

const JQL = 'project = SCRUM ORDER BY updated DESC';
const FIELDS = ['summary', 'status', 'priority', 'assignee', 'labels', 'created', 'updated', 'issuetype', 'project'];

// Fields whose changes are worth recording in issue_history; everything else
// on the row is just kept in sync silently.
const TRACKED_FIELDS = ['status', 'assignee', 'sprint', 'priority'];

async function fetchAllIssues(accessToken, cloudId) {
  const issues = [];
  let startAt = 0;
  const maxResults = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(`${JIRA_API_BASE}/ex/jira/${cloudId}/rest/api/3/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ jql: JQL, startAt, maxResults, fields: FIELDS }),
    });

    if (!res.ok) {
      throw new Error(`Jira search failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    issues.push(...data.issues);
    startAt += data.issues.length;
    if (data.issues.length === 0 || startAt >= data.total) break;
  }

  return issues;
}

// Jira's REST search doesn't return the Sprint field's name/id without
// knowing the site's custom field id, so it's left null here — filled in
// once the correct customfield_XXXXX id for this Jira site is known.
function mapJiraFields(issue) {
  const f = issue.fields || {};
  const statusCategory = f.status?.statusCategory?.name || null;

  return {
    issueKey: issue.key,
    project: f.project?.key || null,
    issueType: f.issuetype?.name || null,
    summary: f.summary || null,
    status: f.status?.name || null,
    statusCategory,
    priority: f.priority?.name || null,
    assignee: f.assignee?.displayName || null,
    team: null,
    createdAt: f.created || null,
    updatedAt: f.updated || null,
    startedAt: statusCategory && statusCategory !== 'To Do' ? f.created : null,
    resolvedAt: statusCategory === 'Done' ? f.updated : null,
    sprint: null,
    labels: Array.isArray(f.labels) ? f.labels.join(', ') : '',
  };
}

function computeCycleTime(startedAt, resolvedAt) {
  if (!startedAt || !resolvedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(resolvedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round(((end - start) / (1000 * 60 * 60 * 24)) * 100) / 100;
}

router.post('/sync', async (req, res) => {
  try {
    await ensureSchema();
    const { accessToken, cloudId } = await getValidAccessToken();
    const rawIssues = await fetchAllIssues(accessToken, cloudId);
    const pool = getPool();

    let createdCount = 0;
    let updatedCount = 0;

    for (const raw of rawIssues) {
      const mapped = mapJiraFields(raw);
      const cycleTime = computeCycleTime(mapped.startedAt, mapped.resolvedAt);

      const { rows } = await pool.query('SELECT * FROM issues WHERE issue_key = $1', [mapped.issueKey]);
      const existing = rows[0];

      if (!existing) {
        await pool.query(
          `INSERT INTO issues (
             issue_key, project, issue_type, summary, status, status_category,
             priority, assignee, team, created_at, updated_at, started_at,
             resolved_at, cycle_time, sprint, labels, last_synced_at, is_deleted
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), false)`,
          [
            mapped.issueKey, mapped.project, mapped.issueType, mapped.summary,
            mapped.status, mapped.statusCategory, mapped.priority, mapped.assignee,
            mapped.team, mapped.createdAt, mapped.updatedAt, mapped.startedAt,
            mapped.resolvedAt, cycleTime, mapped.sprint, mapped.labels,
          ]
        );
        createdCount += 1;
        continue;
      }

      // Diff tracked fields against the stored row and log each change
      // before overwriting it, so issue_history captures the transition.
      for (const field of TRACKED_FIELDS) {
        const oldValue = existing[field] == null ? null : String(existing[field]);
        const newValue = mapped[field] == null ? null : String(mapped[field]);
        if (oldValue !== newValue) {
          await pool.query(
            `INSERT INTO issue_history (issue_id, field, old_value, new_value) VALUES ($1, $2, $3, $4)`,
            [existing.id, field, oldValue, newValue]
          );
        }
      }

      await pool.query(
        `UPDATE issues SET
           project = $1, issue_type = $2, summary = $3, status = $4, status_category = $5,
           priority = $6, assignee = $7, created_at = $8, updated_at = $9, started_at = $10,
           resolved_at = $11, cycle_time = $12, sprint = $13, labels = $14, last_synced_at = now()
         WHERE id = $15`,
        [
          mapped.project, mapped.issueType, mapped.summary, mapped.status, mapped.statusCategory,
          mapped.priority, mapped.assignee, mapped.createdAt, mapped.updatedAt, mapped.startedAt,
          mapped.resolvedAt, cycleTime, mapped.sprint, mapped.labels, existing.id,
        ]
      );
      updatedCount += 1;
    }

    res.json({ total: rawIssues.length, created: createdCount, updated: updatedCount });
  } catch (err) {
    if (err.code === 'NOT_CONNECTED') {
      return res.status(401).json({ error: 'Jira is not connected. Go to /api/auth/login first.' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();

    const tokenRes = await pool.query('SELECT id FROM jira_tokens ORDER BY id DESC LIMIT 1');
    const countRes = await pool.query('SELECT COUNT(*)::int AS count FROM issues WHERE is_deleted = false');
    const lastSyncRes = await pool.query('SELECT MAX(last_synced_at) AS last_synced_at FROM issues');

    res.json({
      connected: tokenRes.rows.length > 0,
      issueCount: countRes.rows[0].count,
      lastSyncedAt: lastSyncRes.rows[0].last_synced_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Returns DB-backed issues in the same shape as POST /api/upload, so the
// frontend Dashboard can render either source interchangeably.
router.get('/issues', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();

    const { rows } = await pool.query(
      'SELECT * FROM issues WHERE is_deleted = false ORDER BY updated_at DESC NULLS LAST'
    );

    const byStatus = {};
    const byTeam = {};
    const byType = {};
    const issues = [];

    for (const row of rows) {
      const status = row.status || 'Без статуса';
      const type = row.issue_type || 'Без типа';
      byStatus[status] = (byStatus[status] || 0) + 1;
      byType[type] = (byType[type] || 0) + 1;

      const teamSource = row.team || row.labels || '';
      const teams = String(teamSource).split(/[,;]/).map((t) => t.trim()).filter(Boolean);
      if (teams.length === 0) {
        byTeam['Без команды'] = (byTeam['Без команды'] || 0) + 1;
      } else {
        for (const team of teams) {
          byTeam[team] = (byTeam[team] || 0) + 1;
        }
      }

      issues.push({
        code: row.issue_key,
        name: row.summary,
        status: row.status,
        labels: row.labels,
        cycleTime: row.cycle_time,
        leadTime: '',
        createdAt: row.created_at,
        type: row.issue_type,
      });
    }

    const lastSyncRes = await pool.query('SELECT MAX(last_synced_at) AS last_synced_at FROM issues');

    res.json({
      total: rows.length,
      byStatus,
      byTeam,
      byType,
      issues,
      lastSyncedAt: lastSyncRes.rows[0].last_synced_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
