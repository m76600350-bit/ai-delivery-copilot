const express = require('express');
const { ensureSchema, getPool } = require('../db');
const { getValidAccessToken, getStoredToken, JIRA_API_BASE } = require('../lib/jiraAuth');

const router = express.Router();

const BASE_FIELDS = ['summary', 'status', 'priority', 'assignee', 'labels', 'created', 'updated', 'resolutiondate', 'issuetype', 'project', 'issuelinks'];

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

// The new /search/jql endpoint rejects a fully unbounded query ("Неограниченные
// запросы JQL здесь не допускаются") — a plain "updated >= -Nd" satisfies that
// check while still covering effectively all issues (10 years back).
const SYNC_JQL = 'updated >= -3650d ORDER BY updated DESC';

// GET/POST /rest/api/3/search replaced the deprecated /rest/api/3/search
// endpoint (removed by Atlassian, returns 410 Gone). The new endpoint drops
// offset-based paging (`startAt`/`total`) for a cursor: each response may
// carry a `nextPageToken` to pass back on the next call, and `isLast`
// (or a missing token) marks the end of the result set.
// https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post
async function fetchAllIssues(accessToken, cloudId, fields, jql) {
  const issues = [];
  let nextPageToken;
  const maxResults = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const body = { jql, maxResults, fields };
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

// A Jira issuelinks entry carries exactly one of inwardIssue/outwardIssue —
// which one determines which phrase of the link type applies from *this*
// issue's perspective ("is blocked by" vs "blocks", for the standard
// "Blocks" link type). Storing that phrase directly (rather than just the
// link type name) is what lets the blocker query below match on it without
// having to know every possible link type name a site might define.
function extractIssueLinks(issue) {
  const links = issue.fields?.issuelinks || [];
  const result = [];
  for (const link of links) {
    const other = link.inwardIssue || link.outwardIssue;
    if (!other) continue;
    const phrase = link.inwardIssue ? link.type?.inward : link.type?.outward;
    result.push({
      linkedIssueKey: other.key,
      linkType: phrase || link.type?.name || null,
      linkedIssueStatus: other.fields?.status?.name || null,
      linkedIssueStatusCategory: other.fields?.status?.statusCategory?.key || null,
    });
  }
  return result;
}

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

// Cycle time = elapsed time from the issue's first move out of the "To Do"
// category until resolution, minus any time spent back in "Done" (e.g. a
// reopen-then-restart still counts both work stretches, but not the Done
// gap between them) — computed by replaying the changelog's status
// transitions into a chronological timeline of status segments. Everything
// from that first move onward counts *regardless of category*, including a
// workflow's intermediate review/QA statuses that happen to be categorized
// "To Do" (common for board-column reasons) rather than "In Progress" —
// only the leading backlog run before work starts, and Done time, are
// excluded. Lead time is the simple created→resolved span. Both are null
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
  let hasStartedWork = false;
  const segmentLog = [];
  for (const seg of segments) {
    const category = categoryOf(seg.statusId, seg.statusName);
    if (!hasStartedWork && category !== CATEGORY_KEY.NEW) {
      hasStartedWork = true;
    }
    const ms = new Date(seg.end).getTime() - new Date(seg.start).getTime();
    const counted = hasStartedWork && category !== CATEGORY_KEY.DONE && ms > 0;
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

// GET /api/jira/team-roles — every (team, assignee) pair actually present in
// already-synced issues, grouped by team, each with whatever role has been
// assigned via team_roles (null if none — "роль не задана", and such
// members are excluded from the WIP-limit sum in routes/teams.js).
router.get('/team-roles', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();
    const [{ rows: memberRows }, { rows: roleRows }] = await Promise.all([
      pool.query(
        `SELECT DISTINCT COALESCE(team, 'Без команды') AS team, assignee
         FROM issues WHERE is_deleted = false AND assignee IS NOT NULL
         ORDER BY team, assignee`
      ),
      pool.query('SELECT team, assignee_name, role FROM team_roles'),
    ]);

    const roleByKey = new Map(roleRows.map((r) => [`${r.team} ${r.assignee_name}`, r.role]));
    const byTeam = new Map();
    for (const { team, assignee } of memberRows) {
      if (!byTeam.has(team)) byTeam.set(team, []);
      byTeam.get(team).push({ assignee, role: roleByKey.get(`${team} ${assignee}`) || null });
    }

    const teams = [...byTeam.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([team, members]) => ({ team, members }));

    res.json({ teams });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jira/team-roles — body: { team, assignee, role }. Upserts one
// member's role; an empty/null role clears it back to "роль не задана"
// instead of storing a meaningless row.
router.post('/team-roles', async (req, res) => {
  try {
    await ensureSchema();
    const { team, assignee, role } = req.body || {};
    if (!team || !assignee) {
      return res.status(400).json({ error: 'team and assignee are required' });
    }

    const pool = getPool();
    if (!role || !role.trim()) {
      await pool.query('DELETE FROM team_roles WHERE team = $1 AND assignee_name = $2', [team, assignee]);
    } else {
      await pool.query(
        `INSERT INTO team_roles (team, assignee_name, role) VALUES ($1, $2, $3)
         ON CONFLICT (team, assignee_name) DO UPDATE SET role = EXCLUDED.role`,
        [team, assignee, role.trim()]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jira/wip-limits?team=... — everything the "Настройка WIP" modal
// needs for one team once it's been picked in step 1: that team's
// currently-used indeterminate statuses, the roles already assigned to its
// members (team_roles), and whatever (status, role, limit) rows already
// exist for it.
router.get('/wip-limits', async (req, res) => {
  try {
    await ensureSchema();
    const team = req.query.team;
    if (!team) {
      return res.status(400).json({ error: 'team is required' });
    }

    const pool = getPool();
    const [{ rows: statusRows }, { rows: roleRows }, { rows: limitRows }] = await Promise.all([
      pool.query(
        `SELECT DISTINCT status FROM issues
         WHERE is_deleted = false AND status_category = 'indeterminate' AND status IS NOT NULL
           AND COALESCE(team, 'Без команды') = $1
         ORDER BY status`,
        [team]
      ),
      pool.query('SELECT DISTINCT role FROM team_roles WHERE team = $1 ORDER BY role', [team]),
      pool.query(
        'SELECT status_name, role, limit_value FROM wip_limits WHERE team = $1 ORDER BY status_name, role',
        [team]
      ),
    ]);

    res.json({
      statuses: statusRows.map((r) => r.status),
      roles: roleRows.map((r) => r.role),
      limits: limitRows.map((r) => ({ statusName: r.status_name, role: r.role, limitValue: r.limit_value })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jira/wip-limits — body: { team, entries: [{ statusName, role,
// limitValue }, ...] }. The modal's explicit "Сохранить" replaces this
// team's whole WIP config at once (delete-then-insert), rather than
// per-field autosave — a one-off modal action, unlike the rest of Settings.
router.post('/wip-limits', async (req, res) => {
  try {
    await ensureSchema();
    const { team, entries } = req.body || {};
    if (!team) {
      return res.status(400).json({ error: 'team is required' });
    }

    const pool = getPool();
    await pool.query('DELETE FROM wip_limits WHERE team = $1', [team]);

    for (const entry of Array.isArray(entries) ? entries : []) {
      const statusName = entry?.statusName;
      const role = entry?.role;
      if (!statusName || !role) continue;
      const limitValue =
        entry.limitValue == null || entry.limitValue === ''
          ? null
          : Math.max(0, Math.trunc(Number(entry.limitValue)) || 0);
      await pool.query(
        `INSERT INTO wip_limits (team, status_name, role, limit_value) VALUES ($1, $2, $3, $4)
         ON CONFLICT (team, status_name, role) DO UPDATE SET limit_value = EXCLUDED.limit_value`,
        [team, statusName, role, limitValue]
      );
    }

    res.json({ ok: true });
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

// How many most-recently-completed sprints (per board) to keep, on top of
// whatever's currently active — pulling a board's entire sprint history
// isn't practical (or useful) for this feature.
const CLOSED_SPRINTS_TO_KEEP = 3;

// GET /rest/agile/1.0/board?projectKeyOrId=... — every board associated
// with a Jira project, paginated via startAt/maxResults/isLast (same
// offset-paging style as the rest of the Agile API, unlike the newer
// cursor-based /rest/api/3/search/jql).
async function fetchBoardsForProject(accessToken, cloudId, projectKey) {
  const boards = [];
  let startAt = 0;
  const maxResults = 50;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(
      `${JIRA_API_BASE}/ex/jira/${cloudId}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&startAt=${startAt}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
    );
    if (!res.ok) {
      throw new Error(`Failed to list boards for project ${projectKey}: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    const values = data.values || [];
    boards.push(...values);

    startAt += values.length;
    if (data.isLast || values.length === 0) break;
  }

  return boards;
}

// GET /rest/agile/1.0/board/{boardId}/sprint?state=active,closed — a
// Kanban-only board has no sprints and answers 400 ("does not support
// sprints"); that's expected, not a real error, so it's treated as "no
// sprints on this board" rather than aborting the whole sync.
async function fetchSprintsForBoard(accessToken, cloudId, boardId) {
  const sprints = [];
  let startAt = 0;
  const maxResults = 50;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(
      `${JIRA_API_BASE}/ex/jira/${cloudId}/rest/agile/1.0/board/${boardId}/sprint?state=active,closed&startAt=${startAt}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
    );
    if (res.status === 400) return [];
    if (!res.ok) {
      throw new Error(`Failed to list sprints for board ${boardId}: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    const values = data.values || [];
    sprints.push(...values);

    startAt += values.length;
    if (data.isLast || values.length === 0) break;
  }

  return sprints;
}

// Active sprint(s) as-is, plus only the most recently completed
// CLOSED_SPRINTS_TO_KEEP — the practical limit from the sync requirements,
// rather than every sprint the board has ever run.
function selectSprintsToTrack(sprints) {
  const active = sprints.filter((s) => s.state === 'active');
  const closed = sprints
    .filter((s) => s.state === 'closed')
    .sort((a, b) => new Date(b.completeDate || b.endDate || 0).getTime() - new Date(a.completeDate || a.endDate || 0).getTime())
    .slice(0, CLOSED_SPRINTS_TO_KEEP);
  return [...active, ...closed];
}

// GET /rest/agile/1.0/sprint/{sprintId}/issue?fields=created — only the
// `created` field is requested since that's all this needs (whether the
// issue existed before the sprint's start_date); offset-paged like the
// board/sprint endpoints above.
async function fetchSprintIssueKeys(accessToken, cloudId, sprintId) {
  const issues = [];
  let startAt = 0;
  const maxResults = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(
      `${JIRA_API_BASE}/ex/jira/${cloudId}/rest/agile/1.0/sprint/${sprintId}/issue?fields=created&startAt=${startAt}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
    );
    if (!res.ok) {
      throw new Error(`Failed to list issues for sprint ${sprintId}: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    const pageIssues = data.issues || [];
    issues.push(...pageIssues);

    startAt += pageIssues.length;
    if (pageIssues.length === 0 || (typeof data.total === 'number' && startAt >= data.total)) break;
  }

  return issues;
}

// Best-effort Agile-API enrichment layered on top of the main issue sync:
// for every Jira project already present in `issues`, find its board(s),
// pick the sprints worth tracking (see selectSprintsToTrack), and record
// which already-synced issues were in each one — plus whether each issue
// was there from kickoff or added mid-sprint (created_at vs. the sprint's
// start_date; changelog-based detection would be more precise but means an
// extra Jira request per issue on top of what the main sync already does).
// Runs after the issue loop and is intentionally isolated in its own
// try/catch at the call site — a Jira Software licensing/permission gap or
// a single misbehaving board shouldn't fail the whole sync.
async function syncSprintsForCloud(accessToken, cloudId, pool) {
  const { rows: projectRows } = await pool.query(
    `SELECT DISTINCT project FROM issues WHERE is_deleted = false AND project IS NOT NULL`
  );

  let sprintsSynced = 0;
  let sprintIssueLinks = 0;
  // First error message seen across every project/board, surfaced back to
  // the caller (sprintSyncError in the /sync response and sync_history) —
  // e.g. a 403 from the whole org lacking Agile-API scope would otherwise
  // fail every project identically and silently, with sprintsSynced simply
  // staying 0 and no visible signal of why.
  let firstError = null;

  for (const { project } of projectRows) {
    let boards;
    try {
      boards = await fetchBoardsForProject(accessToken, cloudId, project);
    } catch (err) {
      // A project without a visible board (or without Jira Software access)
      // just contributes no sprint data — move on to the next project.
      firstError = firstError || err.message;
      continue;
    }

    for (const board of boards) {
      let boardSprints;
      try {
        boardSprints = await fetchSprintsForBoard(accessToken, cloudId, board.id);
      } catch (err) {
        firstError = firstError || err.message;
        continue;
      }

      for (const sprint of selectSprintsToTrack(boardSprints)) {
        const { rows: upserted } = await pool.query(
          `INSERT INTO sprints (jira_sprint_id, name, start_date, end_date, complete_date, state, goal, board_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (jira_sprint_id) DO UPDATE SET
             name = EXCLUDED.name, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
             complete_date = EXCLUDED.complete_date, state = EXCLUDED.state, goal = EXCLUDED.goal,
             board_id = EXCLUDED.board_id
           RETURNING id`,
          [sprint.id, sprint.name || null, sprint.startDate || null, sprint.endDate || null,
           sprint.completeDate || null, sprint.state || null, sprint.goal || null, board.id]
        );
        const sprintRowId = upserted[0].id;
        sprintsSynced += 1;

        let sprintIssues;
        try {
          sprintIssues = await fetchSprintIssueKeys(accessToken, cloudId, sprint.id);
        } catch (err) {
          firstError = firstError || err.message;
          continue;
        }

        for (const sprintIssue of sprintIssues) {
          const { rows: issueRows } = await pool.query('SELECT id FROM issues WHERE issue_key = $1', [sprintIssue.key]);
          const issueRow = issueRows[0];
          // The sprint can include issues outside every synced project (rare
          // cross-project moves) or issues our own SYNC_JQL filtered out —
          // only link what we actually have a row for.
          if (!issueRow) continue;

          const issueCreatedAt = sprintIssue.fields?.created ? new Date(sprintIssue.fields.created).getTime() : null;
          const sprintStartAt = sprint.startDate ? new Date(sprint.startDate).getTime() : null;
          const addedAfterStart =
            issueCreatedAt != null && sprintStartAt != null ? issueCreatedAt > sprintStartAt : null;

          await pool.query(
            `INSERT INTO issue_sprints (issue_id, sprint_id, added_after_sprint_start)
             VALUES ($1, $2, $3)
             ON CONFLICT (issue_id, sprint_id) DO UPDATE SET added_after_sprint_start = EXCLUDED.added_after_sprint_start`,
            [issueRow.id, sprintRowId, addedAfterStart]
          );
          sprintIssueLinks += 1;
        }
      }
    }
  }

  return { sprintsSynced, sprintIssueLinks, firstError };
}

router.post('/sync', async (req, res) => {
  const pool = getPool();
  // Bypasses the "skip changelog if Jira's updated timestamp is unchanged"
  // optimization below, forcing every issue's lead/cycle/reopen to be
  // recomputed — needed after fixing a bug in that calculation itself,
  // since otherwise already-synced issues keep their stale stored values
  // forever (their `updated` in Jira never changes just because our code did).
  const force = req.query.force === '1' || req.body?.force === true;
  const startedAt = new Date();
  try {
    await ensureSchema();
    const { accessToken, cloudId } = await getValidAccessToken();

    // Field mapping is optional — unmapped canonical fields simply come back
    // null (team falls back to labels) instead of blocking the sync.
    const fieldMapping = await getFieldMapping(cloudId);
    const extraFields = CANONICAL_FIELDS.map((f) => fieldMapping[f]).filter(Boolean);
    const fields = [...new Set([...BASE_FIELDS, ...extraFields])];

    const rawIssues = await fetchAllIssues(accessToken, cloudId, fields, SYNC_JQL);
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
      const needsHistory = force || !existing || existingUpdatedAt !== newUpdatedAt;

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

      let issueRowId;
      if (!existing) {
        const { rows: insertedRows } = await pool.query(
          `INSERT INTO issues (
             issue_key, project, issue_type, summary, status, status_category,
             priority, assignee, team, created_at, updated_at, started_at,
             resolved_at, cycle_time, lead_time_days, reopen_count, sprint,
             story_points, labels, last_synced_at, is_deleted
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now(), false)
           RETURNING id`,
          [
            mapped.issueKey, mapped.project, mapped.issueType, mapped.summary,
            mapped.status, mapped.statusCategory, mapped.priority, mapped.assignee,
            mapped.team, mapped.createdAt, mapped.updatedAt, mapped.startedAt,
            mapped.resolvedAt, cycleTimeDays, leadTimeDays, reopenCount, mapped.sprint,
            mapped.storyPoints, mapped.labels,
          ]
        );
        issueRowId = insertedRows[0].id;
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
        issueRowId = existing.id;
        updatedCount += 1;
      }

      // Rebuilt from scratch each sync rather than diffed — issuelinks
      // changes (new/removed links, the other side's status moving) are
      // common enough that upserting per-link isn't worth the complexity.
      await pool.query('DELETE FROM issue_links WHERE issue_id = $1', [issueRowId]);
      const links = extractIssueLinks(raw);
      for (const link of links) {
        const { rows: linkedRows } = await pool.query('SELECT id FROM issues WHERE issue_key = $1', [link.linkedIssueKey]);
        await pool.query(
          `INSERT INTO issue_links (issue_id, linked_issue_id, linked_issue_key, link_type, linked_issue_status, linked_issue_status_category)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [issueRowId, linkedRows[0]?.id || null, link.linkedIssueKey, link.linkType, link.linkedIssueStatus, link.linkedIssueStatusCategory]
        );
      }

      completed += 1;
      await setSyncProgress(pool, { completed });
    }

    await setSyncProgress(pool, { status: 'done', finished_at: new Date() });

    // Best-effort — a Jira Software licensing/permission gap or a single bad
    // board shouldn't turn an otherwise-successful issue sync into a failure.
    let sprintsSynced = 0;
    let sprintIssueLinks = 0;
    let sprintSyncError = null;
    try {
      const sprintResult = await syncSprintsForCloud(accessToken, cloudId, pool);
      sprintsSynced = sprintResult.sprintsSynced;
      sprintIssueLinks = sprintResult.sprintIssueLinks;
      sprintSyncError = sprintResult.firstError;
    } catch (err) {
      sprintSyncError = err.message;
    }

    await pool.query(
      `INSERT INTO sync_history (started_at, finished_at, source, total, status, error, sprints_synced, sprint_issue_links)
       VALUES ($1, now(), 'Jira API', $2, 'success', $3, $4, $5)`,
      [startedAt, createdCount + updatedCount, sprintSyncError, sprintsSynced, sprintIssueLinks]
    ).catch(() => {});

    res.json({
      total: rawIssues.length,
      created: createdCount,
      updated: updatedCount,
      fieldMappingConfigured: extraFields.length > 0,
      sprintsSynced,
      sprintIssueLinks,
      sprintSyncError,
    });
  } catch (err) {
    await setSyncProgress(pool, { status: 'error', error: err.message, finished_at: new Date() }).catch(() => {});
    await pool.query(
      `INSERT INTO sync_history (started_at, finished_at, source, total, status, error)
       VALUES ($1, now(), 'Jira API', NULL, 'error', $2)`,
      [startedAt, err.message]
    ).catch(() => {});

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

// GET /api/jira/sync/history — recent sync runs for the Settings screen's
// "История синхронизаций" table.
router.get('/sync/history', async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `SELECT started_at, finished_at, source, total, status, error, sprints_synced, sprint_issue_links
       FROM sync_history ORDER BY started_at DESC LIMIT 20`
    );
    res.json({
      items: rows.map((r) => ({
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        source: r.source,
        total: r.total,
        status: r.status,
        error: r.error,
        sprintsSynced: r.sprints_synced,
        sprintIssueLinks: r.sprint_issue_links,
      })),
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

// Returns all synced issues from the DB, aggregated for the Dashboard view.
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
        updatedAt: row.updated_at,
        type: row.issue_type,
        sprint: row.sprint,
        storyPoints: row.story_points,
        project: row.project,
        priority: row.priority,
        assignee: row.assignee,
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

  const projects = toArray(query.project);
  if (projects.length) {
    params.push(projects);
    conditions.push(`COALESCE(project, 'Без проекта') = ANY($${params.length}::text[])`);
  }

  // Mirrors the Dashboard/WidgetDrilldown "Период" filter, which also cuts
  // by created_at rather than updated_at.
  const periodDays = Math.max(0, Math.trunc(Number(query.periodDays)) || 0);
  if (periodDays > 0) {
    params.push(periodDays);
    conditions.push(`created_at >= now() - ($${params.length}::int * INTERVAL '1 day')`);
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

    const [statuses, teams, types, priorities, projects] = await Promise.all([
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
      pool.query(
        `SELECT DISTINCT COALESCE(project, 'Без проекта') AS v FROM issues WHERE is_deleted = false ORDER BY v`
      ),
    ]);

    res.json({
      statuses: statuses.rows.map((r) => r.v),
      teams: teams.rows.map((r) => r.v),
      types: types.rows.map((r) => r.v),
      priorities: priorities.rows.map((r) => r.v),
      projects: projects.rows.map((r) => r.v),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
