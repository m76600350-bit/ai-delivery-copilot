const express = require('express');
const { ensureSchema, getPool } = require('../db');
const { getValidAccessToken, getStoredToken, JIRA_API_BASE } = require('../lib/jiraAuth');

const router = express.Router();

const JQL = 'project = SCRUM ORDER BY updated DESC';
const BASE_FIELDS = ['summary', 'status', 'priority', 'assignee', 'labels', 'created', 'updated', 'issuetype', 'project'];

// Internal field names the app understands; each can be pointed at a
// Jira custom field id via jira_field_mapping since those ids are
// different on every Jira Cloud site and can't be hardcoded.
const CANONICAL_FIELDS = ['sprint', 'team', 'story_points'];

// Fields whose changes are worth recording in issue_history; everything else
// on the row is just kept in sync silently.
const TRACKED_FIELDS = ['status', 'assignee', 'sprint', 'priority'];

async function getFieldMapping(cloudId) {
  await ensureSchema();
  const { rows } = await getPool().query(
    'SELECT canonical_field, jira_field_id FROM jira_field_mapping WHERE cloud_id = $1',
    [cloudId]
  );
  const mapping = {};
  for (const row of rows) {
    mapping[row.canonical_field] = row.jira_field_id;
  }
  return mapping;
}

async function fetchAllIssues(accessToken, cloudId, fields) {
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
      body: JSON.stringify({ jql: JQL, startAt, maxResults, fields }),
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

// Jira custom fields come back in several shapes depending on field type:
// a plain scalar, a single option object ({name} or {value}), or (for
// Sprint) an array of sprint objects — the most recent one wins.
function extractFieldValue(rawValue) {
  if (rawValue == null) return null;
  if (typeof rawValue === 'number') return rawValue;
  if (Array.isArray(rawValue)) {
    return rawValue.length ? extractFieldValue(rawValue[rawValue.length - 1]) : null;
  }
  if (typeof rawValue === 'object') {
    if (typeof rawValue.name === 'string') return rawValue.name;
    if (typeof rawValue.value === 'string') return rawValue.value;
    return null;
  }
  return String(rawValue);
}

function mapJiraFields(issue, fieldMapping) {
  const f = issue.fields || {};
  const statusCategory = f.status?.statusCategory?.name || null;

  const sprint = fieldMapping.sprint ? extractFieldValue(f[fieldMapping.sprint]) : null;
  const mappedTeam = fieldMapping.team ? extractFieldValue(f[fieldMapping.team]) : null;
  const storyPointsRaw = fieldMapping.story_points ? extractFieldValue(f[fieldMapping.story_points]) : null;
  const storyPoints = storyPointsRaw == null || storyPointsRaw === '' ? null : Number(storyPointsRaw);

  return {
    issueKey: issue.key,
    project: f.project?.key || null,
    issueType: f.issuetype?.name || null,
    summary: f.summary || null,
    status: f.status?.name || null,
    statusCategory,
    priority: f.priority?.name || null,
    assignee: f.assignee?.displayName || null,
    // Falls back to labels when no Team field is mapped, so team breakdowns
    // keep working before the user configures field mapping.
    team: mappedTeam,
    createdAt: f.created || null,
    updatedAt: f.updated || null,
    startedAt: statusCategory && statusCategory !== 'To Do' ? f.created : null,
    resolvedAt: statusCategory === 'Done' ? f.updated : null,
    sprint,
    storyPoints: Number.isFinite(storyPoints) ? storyPoints : null,
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

// GET /api/jira/fields — lists every field on the connected Jira site
// (id + name) so the frontend can offer them as field-mapping options.
router.get('/fields', async (req, res) => {
  try {
    const { accessToken, cloudId } = await getValidAccessToken();
    const response = await fetch(`${JIRA_API_BASE}/ex/jira/${cloudId}/rest/api/3/field`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to list Jira fields: ${response.status} ${await response.text()}`);
    }

    const fields = await response.json();
    res.json(fields.map((f) => ({ id: f.id, name: f.name })));
  } catch (err) {
    if (err.code === 'NOT_CONNECTED') {
      return res.status(401).json({ error: 'Jira is not connected. Go to /api/auth/login first.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jira/field-mapping — current canonical-field -> Jira field id mapping.
router.get('/field-mapping', async (req, res) => {
  try {
    const token = await getStoredToken();
    if (!token) {
      return res.status(401).json({ error: 'Jira is not connected. Go to /api/auth/login first.' });
    }
    const mapping = await getFieldMapping(token.cloud_id);
    res.json({ mapping });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jira/field-mapping — body: { mapping: { sprint, team, story_points } }.
// Omitting/blanking a field clears its mapping (sync then falls back to null/labels for it).
router.post('/field-mapping', async (req, res) => {
  try {
    await ensureSchema();
    const token = await getStoredToken();
    if (!token) {
      return res.status(401).json({ error: 'Jira is not connected. Go to /api/auth/login first.' });
    }

    const mapping = req.body?.mapping || {};
    const pool = getPool();

    for (const field of CANONICAL_FIELDS) {
      const jiraFieldId = mapping[field] || null;
      if (jiraFieldId) {
        await pool.query(
          `INSERT INTO jira_field_mapping (cloud_id, canonical_field, jira_field_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (cloud_id, canonical_field) DO UPDATE SET jira_field_id = EXCLUDED.jira_field_id`,
          [token.cloud_id, field, jiraFieldId]
        );
      } else {
        await pool.query(
          'DELETE FROM jira_field_mapping WHERE cloud_id = $1 AND canonical_field = $2',
          [token.cloud_id, field]
        );
      }
    }

    res.json({ ok: true, mapping: await getFieldMapping(token.cloud_id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    await ensureSchema();
    const { accessToken, cloudId } = await getValidAccessToken();

    // Field mapping is optional — unmapped canonical fields simply come back
    // null (team falls back to labels) instead of blocking the sync.
    const fieldMapping = await getFieldMapping(cloudId);
    const extraFields = CANONICAL_FIELDS.map((f) => fieldMapping[f]).filter(Boolean);
    const fields = [...new Set([...BASE_FIELDS, ...extraFields])];

    const rawIssues = await fetchAllIssues(accessToken, cloudId, fields);
    const pool = getPool();

    let createdCount = 0;
    let updatedCount = 0;

    for (const raw of rawIssues) {
      const mapped = mapJiraFields(raw, fieldMapping);
      if (!mapped.team) {
        mapped.team = mapped.labels || null;
      }
      const cycleTime = computeCycleTime(mapped.startedAt, mapped.resolvedAt);

      const { rows } = await pool.query('SELECT * FROM issues WHERE issue_key = $1', [mapped.issueKey]);
      const existing = rows[0];

      if (!existing) {
        await pool.query(
          `INSERT INTO issues (
             issue_key, project, issue_type, summary, status, status_category,
             priority, assignee, team, created_at, updated_at, started_at,
             resolved_at, cycle_time, sprint, story_points, labels, last_synced_at, is_deleted
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now(), false)`,
          [
            mapped.issueKey, mapped.project, mapped.issueType, mapped.summary,
            mapped.status, mapped.statusCategory, mapped.priority, mapped.assignee,
            mapped.team, mapped.createdAt, mapped.updatedAt, mapped.startedAt,
            mapped.resolvedAt, cycleTime, mapped.sprint, mapped.storyPoints, mapped.labels,
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
           priority = $6, assignee = $7, team = $8, created_at = $9, updated_at = $10, started_at = $11,
           resolved_at = $12, cycle_time = $13, sprint = $14, story_points = $15, labels = $16, last_synced_at = now()
         WHERE id = $17`,
        [
          mapped.project, mapped.issueType, mapped.summary, mapped.status, mapped.statusCategory,
          mapped.priority, mapped.assignee, mapped.team, mapped.createdAt, mapped.updatedAt, mapped.startedAt,
          mapped.resolvedAt, cycleTime, mapped.sprint, mapped.storyPoints, mapped.labels, existing.id,
        ]
      );
      updatedCount += 1;
    }

    res.json({
      total: rawIssues.length,
      created: createdCount,
      updated: updatedCount,
      fieldMappingConfigured: extraFields.length > 0,
    });
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
        sprint: row.sprint,
        storyPoints: row.story_points,
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
