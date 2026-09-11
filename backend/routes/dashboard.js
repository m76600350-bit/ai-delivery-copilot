const express = require('express');
const { ensureSchema, getPool } = require('../db');
const { getStoredToken } = require('../lib/jiraAuth');
const { computeProblemIssues, buildProblemRows } = require('../lib/problemIssues');

const router = express.Router();

// The full catalog of widget types the library modal can offer — also used
// to validate POST /widgets/:type so an unknown type can't be persisted.
const WIDGET_TYPES = ['stats_cards', 'by_status', 'by_team', 'by_type', 'attention'];

const PREVIEW_LIMIT = 10;

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
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

    res.json({
      items: rows.slice(0, PREVIEW_LIMIT).map((r) => ({
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

module.exports = router;
