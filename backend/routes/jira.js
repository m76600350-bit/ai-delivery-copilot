const express = require('express');
const { ensureSchema, getPool } = require('../db');
const { getValidAccessToken, getStoredToken, JIRA_API_BASE } = require('../lib/jiraAuth');

const router = express.Router();

const JQL = 'project = SCRUM ORDER BY updated DESC';
const BASE_FIELDS = ['summary', 'status', 'priority', 'assignee', 'labels', 'created', 'updated', 'resolutiondate', 'issuetype', 'project'];

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

// GET/POST /rest/api/3/search replaced the deprecated /rest/api/3/search
// endpoint (removed by Atlassian, returns 410 Gone). The new endpoint drops
// offset-based paging (`startAt`/`total`) for a cursor: each response may
// carry a `nextPageToken` to pass back on the next call, and `isLast`
// (or a missing token) marks the end of the result set.
// https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post
async function fetchAllIssues(accessToken, cloudId, fields) {
  const issues = [];
  let nextPageToken;
  const maxResults = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const body = { jql: JQL, maxResults, fields };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const res = await fetch(`${JIRA_API_BASE}/ex/jira/${cloudId}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Jira search failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const pageIssues = data.issues || [];
    issues.push(...pageIssues);

    if (data.isLast || !data.nextPageToken || pageIssues.length === 0) break;
    nextPageToken = data.nextPageToken;
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

// The three category *names* ("To Do"/"In Progress"/"Done") are localized
// to the requesting user same as status names are — a Russian site returns
// "К выполнению"/"В работе"/"Готово" here too. `key` is the one thing Jira
// never translates: always exactly "new"/"indeterminate"/"done" regardless
// of site language, so every category comparison in this file is on key,
// never name. `status_category` is stored as this key throughout.
const CATEGORY_KEY = { NEW: 'new', IN_PROGRESS: 'indeterminate', DONE: 'done' };

function mapJiraFields(issue, fieldMapping) {
  const f = issue.fields || {};
  const statusCategory = f.status?.statusCategory?.key || null;

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
    // Jira's changelog records status transitions using the status's
    // numeric id (stable, locale-independent) in from/to, alongside a
    // fromString/toString that's often the status's *default* name even
    // when f.status.name above is localized to the viewer's language — so
    // the id is what changelog-based category lookups must key on.
    statusId: f.status?.id || null,
    statusCategory,
    priority: f.priority?.name || null,
    assignee: f.assignee?.displayName || null,
    // Falls back to labels when no Team field is mapped, so team breakdowns
    // keep working before the user configures field mapping.
    team: mappedTeam,
    createdAt: f.created || null,
    updatedAt: f.updated || null,
    startedAt: statusCategory && statusCategory !== CATEGORY_KEY.NEW ? f.created : null,
    // The real resolution timestamp, not a heuristic — used as-is for
    // lead time and as the right edge of the cycle-time status timeline.
    resolvedAt: f.resolutiondate || null,
    sprint,
    storyPoints: Number.isFinite(storyPoints) ? storyPoints : null,
    labels: Array.isArray(f.labels) ? f.labels.join(', ') : '',
  };
}

// Site-wide status list (id/name/statusCategory), used to classify each
// *historical* status from the changelog into a category key.
//
// Keyed primarily by id, not name: the changelog's fromString/toString are
// Jira's *default* (English) status names regardless of the account's
// display locale, while this endpoint (like the issue search API) returns
// names localized to the requesting user — so on a non-English site
// "In Progress" from the changelog would never match a name-keyed map built
// from "В работе" here. The id space is locale-independent and shared
// between both endpoints, so it's the only reliable join key; byName is
// kept only as a defensive fallback for a changelog entry missing an id.
// The category value itself is `.key` (see CATEGORY_KEY above) — `.name` is
// localized too ("Готово" instead of "Done"), which was a second instance
// of the exact same bug caught only by testing against a real Jira site.
async function fetchStatusCategoryMap(accessToken, cloudId) {
  const res = await fetch(`${JIRA_API_BASE}/ex/jira/${cloudId}/rest/api/3/status`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Failed to list Jira statuses: ${res.status} ${await res.text()}`);
  }

  const statuses = await res.json();
  const byId = {};
  const byName = {};
  for (const s of statuses) {
    const category = s.statusCategory?.key || null;
    if (s.id != null) byId[String(s.id)] = category;
    if (s.name) byName[s.name] = category;
  }
  return { byId, byName };
}

// Atlassian's own docs/community reports disagree on the exact envelope of
// GET /rest/api/3/issue/{id}/changelog — some show offset paging
// (startAt/maxResults/total), others token-based (nextPageToken/isLast),
// and the entry array itself is described as both `values` and `histories`
// depending on the source. This handles either shape rather than betting on
// one, since there's no way to verify against a real Jira site here.
async function fetchChangelog(accessToken, cloudId, issueIdOrKey) {
  const histories = [];
  let nextPageToken;
  let startAt = 0;
  const maxResults = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (nextPageToken) params.set('nextPageToken', nextPageToken);
    else if (startAt) params.set('startAt', String(startAt));

    const res = await fetch(
      `${JIRA_API_BASE}/ex/jira/${cloudId}/rest/api/3/issue/${issueIdOrKey}/changelog?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
    );

    if (!res.ok) {
      throw new Error(`Failed to fetch changelog for ${issueIdOrKey}: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const page = data.values || data.histories || [];
    histories.push(...page);

    if (page.length === 0 || data.isLast === true) break;

    if (data.nextPageToken) {
      nextPageToken = data.nextPageToken;
      continue;
    }

    // Offset-paged shape: keep going while more pages remain by count; if
    // neither a token nor a total is present, there's no reliable signal
    // for more pages, so stop rather than loop forever.
    startAt += page.length;
    if (typeof data.total !== 'number' || startAt >= data.total) break;
  }

  return histories;
}

function roundDays(ms) {
  return Math.round((ms / 86400000) * 100) / 100;
}

// Cycle time = total time spent in "In Progress"-category statuses, summed
// across every such period (so a reopened-then-restarted issue counts both
// stretches) — computed by replaying the changelog's status transitions
// into a chronological timeline of status segments from creation to
// resolution. Lead time is the simple created→resolved span. Both are null
// for unresolved issues; reopen_count (Done → not-Done) is tracked
// regardless of current resolution state since it's a historical fact.
function computeLeadCycleReopen({
  issueKey,
  createdAt,
  resolvedAt,
  currentStatusId,
  currentStatus,
  histories,
  statusCategoryByName,
  debug,
}) {
  const { byId, byName } = statusCategoryByName;
  // id first (locale-independent — see fetchStatusCategoryMap), name as a
  // defensive fallback for a changelog entry that somehow lacks an id.
  const categoryOf = (id, name) => {
    if (id != null && byId[String(id)] !== undefined) return byId[String(id)];
    if (name != null && byName[name] !== undefined) return byName[name];
    return null;
  };

  const statusEvents = histories
    .filter((h) => Array.isArray(h.items) && h.created)
    .flatMap((h) =>
      h.items
        .filter((item) => item.field === 'status')
        .map((item) => ({
          time: h.created,
          fromId: item.from,
          toId: item.to,
          fromName: item.fromString,
          toName: item.toString,
        }))
    )
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  let reopenCount = 0;
  for (const ev of statusEvents) {
    if (categoryOf(ev.fromId, ev.fromName) === CATEGORY_KEY.DONE && categoryOf(ev.toId, ev.toName) !== CATEGORY_KEY.DONE) {
      reopenCount += 1;
    }
  }

  const leadTimeDays =
    createdAt && resolvedAt
      ? roundDays(new Date(resolvedAt).getTime() - new Date(createdAt).getTime())
      : null;

  if (!resolvedAt) {
    if (debug) {
      console.log(`[cycle-time] ${issueKey}: unresolved, skipping cycle time (lead=${leadTimeDays})`);
    }
    return { leadTimeDays: null, cycleTimeDays: null, reopenCount };
  }

  // Replay transitions into contiguous [status, start, end) segments.
  const segments = [];
  let segStart = createdAt;
  let segId = statusEvents.length ? statusEvents[0].fromId : currentStatusId;
  let segName = statusEvents.length ? statusEvents[0].fromName : currentStatus;

  for (const ev of statusEvents) {
    segments.push({ statusId: segId, statusName: segName, start: segStart, end: ev.time });
    segStart = ev.time;
    segId = ev.toId;
    segName = ev.toName;
  }
  segments.push({ statusId: segId, statusName: segName, start: segStart, end: resolvedAt });

  let cycleMs = 0;
  const segmentLog = [];
  for (const seg of segments) {
    const category = categoryOf(seg.statusId, seg.statusName);
    const ms = new Date(seg.end).getTime() - new Date(seg.start).getTime();
    const counted = category === CATEGORY_KEY.IN_PROGRESS && ms > 0;
    if (counted) cycleMs += ms;
    if (debug) {
      segmentLog.push({
        status: `${seg.statusName} (id=${seg.statusId})`,
        category,
        start: seg.start,
        end: seg.end,
        days: roundDays(ms),
        counted,
      });
    }
  }

  if (debug) {
    console.log(`[cycle-time] ${issueKey}: created=${createdAt} resolved=${resolvedAt}`);
    console.log(`[cycle-time] ${issueKey}: segments=`, JSON.stringify(segmentLog, null, 2));
    console.log(`[cycle-time] ${issueKey}: cycleTimeDays=${roundDays(cycleMs)} leadTimeDays=${leadTimeDays} reopenCount=${reopenCount}`);
  }

  return { leadTimeDays, cycleTimeDays: roundDays(cycleMs), reopenCount };
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

// Upserts only the given fields into the singleton sync_progress row.
// Column defaults cover any field a partial patch omits, so this is safe to
// call with {completed} alone even if (in principle) no row exists yet.
async function setSyncProgress(pool, patch) {
  const fields = Object.keys(patch);
  const values = Object.values(patch);
  const insertCols = ['id', ...fields].join(', ');
  const insertPlaceholders = ['1', ...fields.map((_, i) => `$${i + 1}`)].join(', ');
  const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');

  await pool.query(
    `INSERT INTO sync_progress (${insertCols})
     VALUES (${insertPlaceholders})
     ON CONFLICT (id) DO UPDATE SET ${setClause}`,
    values
  );
}

router.post('/sync', async (req, res) => {
  const pool = getPool();
  try {
    await ensureSchema();
    const { accessToken, cloudId } = await getValidAccessToken();

    // Field mapping is optional — unmapped canonical fields simply come back
    // null (team falls back to labels) instead of blocking the sync.
    const fieldMapping = await getFieldMapping(cloudId);
    const extraFields = CANONICAL_FIELDS.map((f) => fieldMapping[f]).filter(Boolean);
    const fields = [...new Set([...BASE_FIELDS, ...extraFields])];

    const rawIssues = await fetchAllIssues(accessToken, cloudId, fields);
    const statusCategoryByName = await fetchStatusCategoryMap(accessToken, cloudId);

    await setSyncProgress(pool, {
      status: 'running',
      total: rawIssues.length,
      completed: 0,
      error: null,
      started_at: new Date(),
      finished_at: null,
    });

    let createdCount = 0;
    let updatedCount = 0;
    let completed = 0;

    for (const raw of rawIssues) {
      const mapped = mapJiraFields(raw, fieldMapping);
      if (!mapped.team) {
        mapped.team = mapped.labels || null;
      }

      const { rows } = await pool.query('SELECT * FROM issues WHERE issue_key = $1', [mapped.issueKey]);
      const existing = rows[0];

      // The changelog fetch is what makes sync slow (one extra Jira request
      // per issue), so it's skipped whenever Jira's own `updated` timestamp
      // hasn't moved since the last sync — nothing that could affect lead
      // time, cycle time, or reopen count can have happened in that case.
      const existingUpdatedAt = existing?.updated_at ? new Date(existing.updated_at).getTime() : null;
      const newUpdatedAt = mapped.updatedAt ? new Date(mapped.updatedAt).getTime() : null;
      const needsHistory = !existing || existingUpdatedAt !== newUpdatedAt;

      let leadTimeDays = existing?.lead_time_days ?? null;
      let cycleTimeDays = existing?.cycle_time ?? null;
      let reopenCount = existing?.reopen_count ?? 0;

      if (needsHistory) {
        const histories = await fetchChangelog(accessToken, cloudId, mapped.issueKey);
        const computed = computeLeadCycleReopen({
          issueKey: mapped.issueKey,
          createdAt: mapped.createdAt,
          resolvedAt: mapped.resolvedAt,
          currentStatusId: mapped.statusId,
          currentStatus: mapped.status,
          histories,
          statusCategoryByName,
          debug: Boolean(process.env.DEBUG_CYCLE_TIME),
        });
        leadTimeDays = computed.leadTimeDays;
        cycleTimeDays = computed.cycleTimeDays;
        reopenCount = computed.reopenCount;
      }

      if (!existing) {
        await pool.query(
          `INSERT INTO issues (
             issue_key, project, issue_type, summary, status, status_category,
             priority, assignee, team, created_at, updated_at, started_at,
             resolved_at, cycle_time, lead_time_days, reopen_count, sprint,
             story_points, labels, last_synced_at, is_deleted
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now(), false)`,
          [
            mapped.issueKey, mapped.project, mapped.issueType, mapped.summary,
            mapped.status, mapped.statusCategory, mapped.priority, mapped.assignee,
            mapped.team, mapped.createdAt, mapped.updatedAt, mapped.startedAt,
            mapped.resolvedAt, cycleTimeDays, leadTimeDays, reopenCount, mapped.sprint,
            mapped.storyPoints, mapped.labels,
          ]
        );
        createdCount += 1;
      } else {
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
             resolved_at = $12, cycle_time = $13, lead_time_days = $14, reopen_count = $15, sprint = $16,
             story_points = $17, labels = $18, last_synced_at = now()
           WHERE id = $19`,
          [
            mapped.project, mapped.issueType, mapped.summary, mapped.status, mapped.statusCategory,
            mapped.priority, mapped.assignee, mapped.team, mapped.createdAt, mapped.updatedAt, mapped.startedAt,
            mapped.resolvedAt, cycleTimeDays, leadTimeDays, reopenCount, mapped.sprint,
            mapped.storyPoints, mapped.labels, existing.id,
          ]
        );
        updatedCount += 1;
      }

      completed += 1;
      await setSyncProgress(pool, { completed });
    }

    await setSyncProgress(pool, { status: 'done', finished_at: new Date() });

    res.json({
      total: rawIssues.length,
      created: createdCount,
      updated: updatedCount,
      fieldMappingConfigured: extraFields.length > 0,
    });
  } catch (err) {
    await setSyncProgress(pool, { status: 'error', error: err.message, finished_at: new Date() }).catch(() => {});

    if (err.code === 'NOT_CONNECTED') {
      return res.status(401).json({ error: 'Jira is not connected. Go to /api/auth/login first.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jira/sync/progress — polled by the frontend while a sync is in
// flight (a separate request may land on a different serverless instance,
// so progress can't just live in memory on the /sync handler).
router.get('/sync/progress', async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await getPool().query('SELECT * FROM sync_progress WHERE id = 1');
    const row = rows[0];
    if (!row) {
      return res.json({ status: 'idle', total: 0, completed: 0 });
    }
    res.json({
      status: row.status,
      total: row.total,
      completed: row.completed,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jira/debug/:issueKey/changelog — raw changelog + the exact
// segments computeLeadCycleReopen builds from it, for diagnosing a wrong
// cycle time on a real site without needing Vercel log access.
router.get('/debug/:issueKey/changelog', async (req, res) => {
  try {
    const { accessToken, cloudId } = await getValidAccessToken();
    const { issueKey } = req.params;

    const issueRes = await fetch(
      `${JIRA_API_BASE}/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}?fields=created,resolutiondate,status`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
    );
    if (!issueRes.ok) {
      return res.status(502).json({ error: `Failed to fetch issue: ${issueRes.status} ${await issueRes.text()}` });
    }
    const issue = await issueRes.json();
    const f = issue.fields || {};

    const histories = await fetchChangelog(accessToken, cloudId, issueKey);
    const statusCategoryByName = await fetchStatusCategoryMap(accessToken, cloudId);

    const statusEvents = histories
      .filter((h) => Array.isArray(h.items) && h.created)
      .flatMap((h) => h.items.filter((item) => item.field === 'status').map((item) => ({ time: h.created, ...item })));

    const computed = computeLeadCycleReopen({
      issueKey,
      createdAt: f.created,
      resolvedAt: f.resolutiondate || null,
      currentStatusId: f.status?.id || null,
      currentStatus: f.status?.name || null,
      histories,
      statusCategoryByName,
      debug: false,
    });

    res.json({
      issueKey,
      created: f.created,
      resolutiondate: f.resolutiondate || null,
      currentStatus: {
        id: f.status?.id,
        name: f.status?.name,
        categoryName: f.status?.statusCategory?.name,
        categoryKey: f.status?.statusCategory?.key,
      },
      rawStatusEvents: statusEvents,
      statusCategoryMap: statusCategoryByName,
      computed,
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

    const tokenRes = await pool.query('SELECT id, site_url FROM jira_tokens ORDER BY id DESC LIMIT 1');
    const countRes = await pool.query('SELECT COUNT(*)::int AS count FROM issues WHERE is_deleted = false');
    const lastSyncRes = await pool.query('SELECT MAX(last_synced_at) AS last_synced_at FROM issues');

    res.json({
      connected: tokenRes.rows.length > 0,
      issueCount: countRes.rows[0].count,
      lastSyncedAt: lastSyncRes.rows[0].last_synced_at,
      siteUrl: tokenRes.rows[0]?.site_url || null,
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
        team: row.team,
        cycleTime: row.cycle_time,
        leadTime: row.lead_time_days,
        reopenCount: row.reopen_count,
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

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// Every list/filters/export query needs the same WHERE clause, built from
// the same query params — kept in one place so the three stay consistent.
function buildTaskFilters(query) {
  const conditions = ['is_deleted = false'];
  const params = [];

  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(issue_key ILIKE $${params.length} OR summary ILIKE $${params.length})`);
  }

  const statuses = toArray(query.status);
  if (statuses.length) {
    params.push(statuses);
    conditions.push(`COALESCE(status, 'Без статуса') = ANY($${params.length}::text[])`);
  }

  const teams = toArray(query.team);
  if (teams.length) {
    params.push(teams);
    conditions.push(`COALESCE(team, 'Без команды') = ANY($${params.length}::text[])`);
  }

  const types = toArray(query.type);
  if (types.length) {
    params.push(types);
    conditions.push(`COALESCE(issue_type, 'Без типа') = ANY($${params.length}::text[])`);
  }

  const priorities = toArray(query.priority);
  if (priorities.length) {
    params.push(priorities);
    conditions.push(`COALESCE(priority, 'Без приоритета') = ANY($${params.length}::text[])`);
  }

  return { where: conditions.join(' AND '), params };
}

const FINAL_STATUS_CATEGORY = CATEGORY_KEY.DONE;

function withDaysInStatus(row) {
  const daysInStatus =
    row.status_category === FINAL_STATUS_CATEGORY
      ? null
      : Math.max(0, Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 86400000));

  return {
    id: row.id,
    issueKey: row.issue_key,
    project: row.project,
    issueType: row.issue_type,
    summary: row.summary,
    status: row.status,
    statusCategory: row.status_category,
    priority: row.priority,
    assignee: row.assignee,
    team: row.team,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    cycleTime: row.cycle_time,
    leadTimeDays: row.lead_time_days,
    reopenCount: row.reopen_count,
    sprint: row.sprint,
    storyPoints: row.story_points,
    labels: row.labels,
    lastSyncedAt: row.last_synced_at,
    daysInStatus,
  };
}

const TASK_LIST_SELECT = `
  SELECT
    id, issue_key, project,
    COALESCE(issue_type, 'Без типа') AS issue_type,
    summary,
    COALESCE(status, 'Без статуса') AS status,
    status_category,
    COALESCE(priority, 'Без приоритета') AS priority,
    assignee,
    COALESCE(team, 'Без команды') AS team,
    created_at, updated_at, started_at, resolved_at, cycle_time,
    lead_time_days, reopen_count,
    sprint, story_points, labels, last_synced_at
  FROM issues
`;

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const CSV_COLUMNS = [
  ['Ключ', (t) => t.issueKey],
  ['Название', (t) => t.summary],
  ['Тип', (t) => t.issueType],
  ['Команда', (t) => t.team],
  ['Исполнитель', (t) => t.assignee || ''],
  ['Статус', (t) => t.status],
  ['Приоритет', (t) => t.priority],
  ['Дней в статусе', (t) => (t.daysInStatus == null ? '' : t.daysInStatus)],
  ['Cycle time', (t) => (t.cycleTime == null ? '' : t.cycleTime)],
  ['Lead time', (t) => (t.leadTimeDays == null ? '' : t.leadTimeDays)],
  ['Story Points', (t) => (t.storyPoints == null ? '' : t.storyPoints)],
  ['Спринт', (t) => t.sprint || ''],
];

function toCsv(tasks) {
  const header = CSV_COLUMNS.map(([label]) => csvEscape(label)).join(',');
  const rows = tasks.map((t) => CSV_COLUMNS.map(([, get]) => csvEscape(get(t))).join(','));
  // BOM so Excel opens the UTF-8 file (Cyrillic headers/values) without mangling it.
  return '﻿' + [header, ...rows].join('\r\n');
}

const PAGE_SIZE = 20;

// GET /api/jira/tasks — paginated, filterable, searchable issue list backing
// the "Задачи" screen. Pass ?export=csv to instead download every matching
// row (ignoring pagination) as a CSV attachment.
router.get('/tasks', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();
    const { where, params } = buildTaskFilters(req.query);

    if (req.query.export === 'csv') {
      const { rows } = await pool.query(
        `${TASK_LIST_SELECT} WHERE ${where} ORDER BY updated_at DESC NULLS LAST`,
        params
      );
      const csv = toCsv(rows.map(withDaysInStatus));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="tasks.csv"');
      return res.send(csv);
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const countRes = await pool.query(`SELECT COUNT(*)::int AS count FROM issues WHERE ${where}`, params);
    const listParams = [...params, PAGE_SIZE, offset];
    const { rows } = await pool.query(
      `${TASK_LIST_SELECT} WHERE ${where} ORDER BY updated_at DESC NULLS LAST LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    const token = await getStoredToken();

    res.json({
      items: rows.map(withDaysInStatus),
      total: countRes.rows[0].count,
      page,
      pageSize: PAGE_SIZE,
      siteUrl: token?.site_url || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jira/tasks/filters — distinct values for each filter dropdown,
// reflecting what's actually in the DB rather than a hardcoded list.
router.get('/tasks/filters', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();

    const [statuses, teams, types, priorities] = await Promise.all([
      pool.query(
        `SELECT DISTINCT COALESCE(status, 'Без статуса') AS v FROM issues WHERE is_deleted = false ORDER BY v`
      ),
      pool.query(
        `SELECT DISTINCT COALESCE(team, 'Без команды') AS v FROM issues WHERE is_deleted = false ORDER BY v`
      ),
      pool.query(
        `SELECT DISTINCT COALESCE(issue_type, 'Без типа') AS v FROM issues WHERE is_deleted = false ORDER BY v`
      ),
      pool.query(
        `SELECT DISTINCT COALESCE(priority, 'Без приоритета') AS v FROM issues WHERE is_deleted = false ORDER BY v`
      ),
    ]);

    res.json({
      statuses: statuses.rows.map((r) => r.v),
      teams: teams.rows.map((r) => r.v),
      types: types.rows.map((r) => r.v),
      priorities: priorities.rows.map((r) => r.v),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
