const express = require('express');
const { ensureSchema, getPool } = require('../db');
const { getStoredToken } = require('../lib/jiraAuth');
const { computeProblemIssues, buildProblemRows } = require('../lib/problemIssues');
const { computeTeamsReport } = require('./teams');

const router = express.Router();

// The full catalog of widget types the library modal can offer — also used
// to validate POST /widgets/:type so an unknown type can't be persisted.
const WIDGET_TYPES = ['stats_cards', 'by_status', 'by_team', 'by_type', 'attention', 'teams_summary', 'throughput_weekly', 'sprint_burndown'];

const PREVIEW_LIMIT = 10;

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function avg(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Shared by /teams-summary and /throughput — builds the same
// project/team/type/status/priority WHERE clause the rest of the app's
// filterable endpoints use (buildTaskFilters in routes/jira.js, the Команды
// filters in routes/teams.js), just without the search/period/problem bits
// those don't need here.
function buildIssueFilterConditions(query) {
  const conditions = ['is_deleted = false'];
  const params = [];
  const add = (col, values, fallback) => {
    if (!values.length) return;
    params.push(values);
    conditions.push(`COALESCE(${col}, '${fallback}') = ANY($${params.length}::text[])`);
  };
  add('project', toArray(query.project), 'Без проекта');
  add('team', toArray(query.team), 'Без команды');
  add('issue_type', toArray(query.type), 'Без типа');
  add('status', toArray(query.status), 'Без статуса');
  add('priority', toArray(query.priority), 'Без приоритета');
  return { where: conditions.join(' AND '), params };
}

// GET /api/dashboard/widgets — every known widget type, each with whatever
// enabled/position it currently has in dashboard_widgets (or "not added
// yet" for a type with no row at all, e.g. a widget introduced after the
// user's dashboard was first seeded).
router.get('/widgets', async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await getPool().query('SELECT widget_type, position, enabled FROM dashboard_widgets');
    const byType = new Map(rows.map((r) => [r.widget_type, r]));

    const widgets = WIDGET_TYPES.map((type) => {
      const row = byType.get(type);
      return { widgetType: type, enabled: row?.enabled ?? false, position: row?.enabled ? row.position : null };
    });

    res.json({ widgets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/widgets/:type — body: { enabled: boolean }. Adding a
// widget for the first time puts it after whatever's currently enabled;
// re-adding a previously-removed one restores its old position instead
// (no drag&drop to fix up the order otherwise). Removing just flips
// enabled off rather than deleting the row.
router.post('/widgets/:type', async (req, res) => {
  try {
    await ensureSchema();
    const { type } = req.params;
    if (!WIDGET_TYPES.includes(type)) {
      return res.status(400).json({ error: `Unknown widget type: ${type}` });
    }

    const enabled = Boolean(req.body?.enabled);
    const pool = getPool();

    if (enabled) {
      const { rows } = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM dashboard_widgets');
      await pool.query(
        `INSERT INTO dashboard_widgets (widget_type, position, enabled) VALUES ($1, $2, true)
         ON CONFLICT (widget_type) DO UPDATE SET enabled = true`,
        [type, rows[0].next]
      );
    } else {
      await pool.query('UPDATE dashboard_widgets SET enabled = false WHERE widget_type = $1', [type]);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/attention — the "Требует внимания" widget's data:
// блокеры + зависшие задачи (see lib/problemIssues), scoped to the
// Dashboard's own current filter selection (Проект/Команда/Тип/Статус/
// Приоритет/Период — the same shared filter state Dashboard/Tasks use).
router.get('/attention', async (req, res) => {
  try {
    const projectFilter = toArray(req.query.project);
    const teamFilter = toArray(req.query.team);
    const typeFilter = toArray(req.query.type);
    const statusFilter = toArray(req.query.status);
    const priorityFilter = toArray(req.query.priority);
    const periodDays = Math.max(0, Math.trunc(Number(req.query.periodDays)) || 0);

    const problemData = await computeProblemIssues();
    const cutoffMs = periodDays > 0 ? Date.now() - periodDays * 86400000 : null;

    const candidateIds = [...new Set([...problemData.blockedIssueIds, ...problemData.agingByIssueId.keys()])].filter((id) => {
      const issue = problemData.issuesById.get(id);
      if (!issue) return false;
      if (projectFilter.length && !projectFilter.includes(issue.project)) return false;
      if (teamFilter.length && !teamFilter.includes(issue.team)) return false;
      if (typeFilter.length && !typeFilter.includes(issue.issue_type)) return false;
      if (statusFilter.length && !statusFilter.includes(issue.status)) return false;
      if (priorityFilter.length && !priorityFilter.includes(issue.priority)) return false;
      if (cutoffMs != null) {
        const created = issue.created_at ? new Date(issue.created_at).getTime() : null;
        if (!created || created < cutoffMs) return false;
      }
      return true;
    });

    const rows = buildProblemRows(problemData, candidateIds);
    const token = await getStoredToken();
    // fullScreen mode (the widget's "раскрыть на весь экран" view) asks for
    // every matching row instead of just the dashboard card's 10-row preview.
    const limit = req.query.full === '1' ? rows.length : PREVIEW_LIMIT;

    res.json({
      items: rows.slice(0, limit).map((r) => ({
        id: r.issue.id,
        issueKey: r.issue.issue_key,
        summary: r.issue.summary,
        project: r.issue.project,
        issueType: r.issue.issue_type,
        status: r.issue.status,
        statusCategory: r.issue.status_category,
        priority: r.issue.priority,
        assignee: r.issue.assignee,
        team: r.issue.team,
        createdAt: r.issue.created_at,
        updatedAt: r.issue.updated_at,
        startedAt: r.issue.started_at,
        resolvedAt: r.issue.resolved_at,
        cycleTime: r.issue.cycle_time,
        leadTimeDays: r.issue.lead_time_days,
        reopenCount: r.issue.reopen_count,
        sprint: r.issue.sprint,
        storyPoints: r.issue.story_points,
        labels: r.issue.labels,
        statusTimeBreakdown: r.issue.status_time_breakdown,
        lastSyncedAt: r.issue.last_synced_at,
        problem: r.problem,
        days: r.days,
        baselineDays: r.baselineDays,
      })),
      total: rows.length,
      siteUrl: token?.site_url || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- "Задачи по командам" (Часть 1) --------------------------------------

const MIN_COMPLETED_FOR_TREND = 3; // spec 1.2's "меньше 3 завершённых задач"
const DEFAULT_CURRENT_WINDOW_DAYS = 30; // matches the "Отставание cycle time" window in routes/teams.js when no Период filter is set
const CYCLE_GOOD_RATIO = 0.9; // >10% лучше
const CYCLE_RISK_RATIO = 1.1; // 10-30% хуже
const CYCLE_OVERLOAD_RATIO = 1.3; // хуже >30% — treated as overload, not just risk
const SP_OVERLOAD_RATIO = 1.1; // >10% выше среднего за 3 спринта

// Signal 3 from spec 1.2 ("перегруз" — SP взятых в текущем спринте выше
// среднего за последние 3 спринта) needs each team's own sprint history,
// which is already computed by the Команды screen's aggregation — reused
// here rather than re-deriving it, so the two screens can't disagree about
// what a team's "текущий спринт" or its taken-SP history are.
function spOverloadForTeam(teamRow) {
  if (!teamRow?.sprintHealth) return false;
  const chart = teamRow.sprintChart || []; // ascending by start_date, last 5
  const priorClosed = chart.filter((s) => s.state === 'closed' && s.sprintId !== teamRow.sprintHealth.sprintId).slice(-3);
  if (!priorClosed.length) return false;
  const baselineAvg = avg(priorClosed.map((s) => s.takenSp));
  return baselineAvg > 0 && teamRow.sprintHealth.takenSp > baselineAvg * SP_OVERLOAD_RATIO;
}

// GET /api/dashboard/teams-summary — per-team Всего/В работе/Готово/Cycle +
// a "Тренд" badge comparing the CURRENT period's average cycle time against
// that team's ALL-TIME average (signals 1-2), with a separate SP-surge
// signal (3) escalating straight to "перегруз" regardless of the cycle-time
// comparison. periodDays defaults to 30 (same convention as the "Отставание
// cycle time" health signal) when the dashboard's own Период filter is
// "Всё время" — a bare "current vs. all-time" comparison needs SOME current
// window, and 30 days is the app's existing precedent for one.
router.get('/teams-summary', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();
    const { where, params } = buildIssueFilterConditions(req.query);
    const periodDays = Math.max(0, Math.trunc(Number(req.query.periodDays)) || 0) || DEFAULT_CURRENT_WINDOW_DAYS;

    const [{ rows: issues }, teamsReport] = await Promise.all([
      pool.query(
        `SELECT id, COALESCE(team, 'Без команды') AS team, status_category, cycle_time, resolved_at
         FROM issues WHERE ${where}`,
        params
      ),
      computeTeamsReport(req.query),
    ]);
    const sprintDataByTeam = new Map(teamsReport.teams.map((t) => [t.team, t]));

    const byTeam = new Map();
    for (const issue of issues) {
      if (!byTeam.has(issue.team)) byTeam.set(issue.team, { total: 0, inProgress: 0, done: 0, doneWithCycle: [] });
      const g = byTeam.get(issue.team);
      g.total += 1;
      if (issue.status_category === 'indeterminate') g.inProgress += 1;
      if (issue.status_category === 'done') {
        g.done += 1;
        if (issue.cycle_time != null) g.doneWithCycle.push(issue);
      }
    }

    const periodCutoffMs = Date.now() - periodDays * 86400000;

    const teams = [...byTeam.entries()]
      .map(([team, g]) => {
        const historicalValues = g.doneWithCycle.map((r) => Number(r.cycle_time));
        const historicalAvg = historicalValues.length ? avg(historicalValues) : null;
        const currentValues = g.doneWithCycle
          .filter((r) => r.resolved_at && new Date(r.resolved_at).getTime() >= periodCutoffMs)
          .map((r) => Number(r.cycle_time));

        let trend = null;
        if (currentValues.length >= MIN_COMPLETED_FOR_TREND && historicalAvg) {
          const currentAvg = avg(currentValues);
          const ratio = currentAvg / historicalAvg;
          if (spOverloadForTeam(sprintDataByTeam.get(team)) || ratio > CYCLE_OVERLOAD_RATIO) trend = 'overload';
          else if (ratio > CYCLE_RISK_RATIO) trend = 'risk';
          else if (ratio < CYCLE_GOOD_RATIO) trend = 'good';
        }

        return { team, total: g.total, inProgress: g.inProgress, done: g.done, cycleTimeAvg: historicalAvg, trend };
      })
      .sort((a, b) => a.team.localeCompare(b.team));

    res.json({ teams });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- "Throughput по неделям" (Часть 2) ------------------------------------

const THROUGHPUT_WEEKS = 7;

function mondayOf(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

function fmtDDMM(d) {
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Last N calendar weeks (Mon-Sun) ending with the current one. Labels only
// show the Mon-Fri span ("рабочие дни") per spec 2.1, even though a task
// completed on a Saturday/Sunday still counts toward that week's bucket.
function buildWeekBuckets(n) {
  const thisMonday = mondayOf(new Date());
  const weeks = [];
  for (let i = n - 1; i >= 0; i--) {
    const mondayStart = new Date(thisMonday.getTime() - i * 7 * 86400000);
    const nextMonday = new Date(mondayStart.getTime() + 7 * 86400000);
    const friday = new Date(mondayStart.getTime() + 4 * 86400000);
    weeks.push({ mondayStart, nextMonday, label: `${fmtDDMM(mondayStart)}-${fmtDDMM(friday)}`, isCurrent: i === 0, count: 0 });
  }
  return weeks;
}

// GET /api/dashboard/throughput — completed-issue counts per week, last 7
// weeks including the current (incomplete) one. "Completed in week X" is the
// LAST transition into a `done`-category status (issue_status_events, same
// source the Спринты burndown/CFD reconstruction uses), not resolved_at —
// an issue reopened and re-closed counts on its most recent close.
//
// Deliberately ignores the dashboard's Период filter (see README): a 7-week
// trend chart and a "last 7 days" period selection would be in direct
// conflict, and narrowing the trend to whatever Период happens to be set
// would defeat the widget's purpose of showing a multi-week trend at a
// glance. Проект/Команда/Тип/Статус/Приоритет still apply.
router.get('/throughput', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();
    const { where, params } = buildIssueFilterConditions(req.query);

    const { rows: issues } = await pool.query(`SELECT id FROM issues WHERE ${where}`, params);
    const weeks = buildWeekBuckets(THROUGHPUT_WEEKS);

    if (issues.length) {
      const ids = issues.map((i) => i.id);
      const { rows: doneEvents } = await pool.query(
        `SELECT DISTINCT ON (issue_id) issue_id, changed_at FROM issue_status_events
         WHERE status_category = 'done' AND issue_id = ANY($1::int[])
         ORDER BY issue_id, changed_at DESC`,
        [ids]
      );
      for (const row of doneEvents) {
        const doneAt = new Date(row.changed_at);
        const week = weeks.find((w) => doneAt >= w.mondayStart && doneAt < w.nextMonday);
        if (week) week.count += 1;
      }
    }

    res.json({ weeks: weeks.map(({ label, count, isCurrent }) => ({ label, count, isCurrent })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
