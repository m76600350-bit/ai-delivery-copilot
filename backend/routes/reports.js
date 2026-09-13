const express = require('express');
const { ensureSchema, getPool } = require('../db');
const { getStoredToken } = require('../lib/jiraAuth');
const { computeProblemIssues } = require('../lib/problemIssues');
const { computeTeamsReport } = require('./teams');

const router = express.Router();

const DEFAULT_PERIOD_DAYS = 7;
const CHART_WEEKS = 8;
const HIGH_BUG_RATE_PCT = 30;

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function formatDate(d) {
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

// ISO-8601 week number — matches how a Jira/delivery team would say "неделя 36".
function isoWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

// A short human comment for the "План vs факт по командам" table, derived
// from the same 3-signal health model the "Команды" screen computes —
// reused via computeTeamsReport rather than re-deriving it here so the two
// screens can never disagree about a team's status.
function commentForTeam(team) {
  if (team.health === 'insufficient_data') return '—';
  if (team.health === 'normal') return 'без рисков';

  const reasons = [];
  if (team.bugRatePct != null && team.bugRatePct >= HIGH_BUG_RATE_PCT) reasons.push('много багов');
  if (team.healthSignals.some((s) => s.name === 'wip' && s.triggered)) reasons.push('превышен WIP');
  if (team.healthSignals.some((s) => s.name === 'velocity' && s.triggered)) reasons.push('просадка velocity');
  if (team.healthSignals.some((s) => s.name === 'cycle_time' && s.triggered)) reasons.push('рост cycle time');

  const label = team.health === 'overload' ? 'перегруз' : 'риск';
  return reasons.length ? `${label}, ${reasons.join(', ')}` : label;
}

// Same worst-first ordering used to pick "команда с худшим health-статусом"
// for the summary bullet: overload beats risk, then higher bug rate first.
function worseHealthFirst(a, b) {
  const rank = { overload: 2, risk: 1, normal: 0, insufficient_data: -1 };
  if (rank[b.health] !== rank[a.health]) return rank[b.health] - rank[a.health];
  return (b.bugRatePct ?? 0) - (a.bugRatePct ?? 0);
}

function buildAutoSummary({ teamsTable, worstTeam, mainBlocker }) {
  const bullets = [];

  const planTotal = teamsTable.reduce((t, r) => t + r.planSp, 0);
  const factTotal = teamsTable.reduce((t, r) => t + r.factSp, 0);
  const pct = planTotal > 0 ? Math.round((factTotal / planTotal) * 100) : null;
  bullets.push(
    pct != null
      ? `Закрыто ${factTotal} SP из ${planTotal} взятых, выполнение ${pct}%`
      : `Закрыто ${factTotal} SP — данных по взятым SP за последний спринт нет`
  );

  if (worstTeam && worstTeam.health !== 'normal' && worstTeam.health !== 'insufficient_data') {
    const reason = commentForTeam(worstTeam).replace(/^(перегруз|риск), /, '');
    const statusWord = worstTeam.health === 'overload' ? 'перегруз' : 'риск';
    bullets.push(
      reason === statusWord
        ? `Под риском команда ${worstTeam.team}: ${statusWord}`
        : `Под риском команда ${worstTeam.team}: ${statusWord} (${reason})`
    );
  }

  if (mainBlocker) {
    bullets.push(`Главный блокер — ${mainBlocker.issueKey} (${mainBlocker.summary}), висит ${mainBlocker.days} дн., нужна эскалация`);
  }

  return bullets;
}

// GET /api/reports/status — computes the whole "Статус доставки" report on
// the fly from current data; nothing about the report content itself is
// ever persisted (only a manual edit to the summary text — see /summary).
router.get('/status', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();

    const projectFilter = toArray(req.query.project);
    const teamFilter = toArray(req.query.team);
    const typeFilter = toArray(req.query.type);
    const statusFilter = toArray(req.query.status);
    const priorityFilter = toArray(req.query.priority);
    const period = req.query.period && req.query.period !== 'all' ? req.query.period : null;
    const periodDays = period ? Math.max(1, parseInt(period, 10) || DEFAULT_PERIOD_DAYS) : DEFAULT_PERIOD_DAYS;

    const now = new Date();
    const rangeStart = new Date(now.getTime() - periodDays * 86400000);

    const [teamsData, problemData, projectRows] = await Promise.all([
      computeTeamsReport(req.query),
      computeProblemIssues(),
      pool.query(
        `SELECT DISTINCT project FROM issues WHERE is_deleted = false AND project IS NOT NULL ORDER BY project`
      ),
    ]);

    // --- "План vs факт по командам" ---
    const teamsTable = teamsData.teams.map((t) => ({
      team: t.team,
      planSp: t.sprintHealth?.takenSp ?? 0,
      factSp: t.sprintHealth?.doneSp ?? 0,
      pct: t.sprintHealth?.takenSp ? Math.round((t.sprintHealth.doneSp / t.sprintHealth.takenSp) * 100) : null,
      comment: commentForTeam(t),
    }));
    const worstTeam = [...teamsData.teams].sort(worseHealthFirst)[0] || null;

    // --- Главный блокер: longest-standing active blocker in scope ---
    const scopedBlockers = [...problemData.blockedIssueIds]
      .map((id) => problemData.issuesById.get(id))
      .filter((issue) => {
        if (!issue) return false;
        if (projectFilter.length && !projectFilter.includes(issue.project)) return false;
        if (teamFilter.length && !teamFilter.includes(issue.team)) return false;
        if (typeFilter.length && !typeFilter.includes(issue.issue_type)) return false;
        if (statusFilter.length && !statusFilter.includes(issue.status)) return false;
        if (priorityFilter.length && !priorityFilter.includes(issue.priority)) return false;
        return true;
      })
      .map((issue) => ({
        issueKey: issue.issue_key,
        summary: issue.summary,
        days: Math.max(0, Math.floor((Date.now() - new Date(issue.updated_at).getTime()) / 86400000)),
      }))
      .sort((a, b) => b.days - a.days);
    const mainBlocker = scopedBlockers[0] || null;

    // --- "Динамика доставки" — SP of issues resolved per week, last CHART_WEEKS weeks ---
    const chartStart = new Date(now.getTime() - CHART_WEEKS * 7 * 86400000);
    const chartConditions = ['is_deleted = false', "status_category = 'done'", 'resolved_at >= $1'];
    const chartParams = [chartStart.toISOString()];
    if (projectFilter.length) {
      chartParams.push(projectFilter);
      chartConditions.push(`COALESCE(project, 'Без проекта') = ANY($${chartParams.length}::text[])`);
    }
    if (teamFilter.length) {
      chartParams.push(teamFilter);
      chartConditions.push(`COALESCE(team, 'Без команды') = ANY($${chartParams.length}::text[])`);
    }
    if (typeFilter.length) {
      chartParams.push(typeFilter);
      chartConditions.push(`COALESCE(issue_type, 'Без типа') = ANY($${chartParams.length}::text[])`);
    }
    if (statusFilter.length) {
      chartParams.push(statusFilter);
      chartConditions.push(`COALESCE(status, 'Без статуса') = ANY($${chartParams.length}::text[])`);
    }
    if (priorityFilter.length) {
      chartParams.push(priorityFilter);
      chartConditions.push(`COALESCE(priority, 'Без приоритета') = ANY($${chartParams.length}::text[])`);
    }
    const { rows: resolvedRows } = await pool.query(
      `SELECT resolved_at, story_points FROM issues WHERE ${chartConditions.join(' AND ')}`,
      chartParams
    );

    // Weeks bucketed backward from "now", each 7 days long, so the last
    // bucket is always the (possibly incomplete) current week.
    const weeklyChart = [];
    for (let i = CHART_WEEKS - 1; i >= 0; i--) {
      const weekEnd = new Date(now.getTime() - i * 7 * 86400000);
      const weekStart = new Date(weekEnd.getTime() - 7 * 86400000);
      const sp = resolvedRows
        .filter((r) => {
          const t = new Date(r.resolved_at).getTime();
          return t >= weekStart.getTime() && t < weekEnd.getTime();
        })
        .reduce((total, r) => total + (Number(r.story_points) || 0), 0);
      weeklyChart.push({
        weekLabel: `${formatDate(weekStart)}–${formatDate(weekEnd)}`,
        sp,
        incomplete: i === 0,
      });
    }

    // --- Draft summary lookup ---
    const periodKey = `${rangeStart.toISOString().slice(0, 10)}_${now.toISOString().slice(0, 10)}_${[...projectFilter].sort().join(',')}`;
    const { rows: draftRows } = await pool.query(
      'SELECT summary FROM report_summary_draft WHERE period_key = $1',
      [periodKey]
    );

    const token = await getStoredToken();

    res.json({
      periodKey,
      title: period ? `Статус доставки — последние ${periodDays} дн.` : `Статус доставки — неделя ${isoWeekNumber(now)}`,
      dateRangeLabel: `${formatDate(rangeStart)} — ${formatDate(now)}`,
      projects: projectFilter.length ? projectFilter : projectRows.rows.map((r) => r.project),
      summaryAuto: buildAutoSummary({ teamsTable, worstTeam, mainBlocker }),
      summaryDraft: draftRows[0]?.summary ?? null,
      teamsTable,
      weeklyChart,
      siteUrl: token?.site_url || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function csvRow(values) {
  return values.map(csvEscape).join(',');
}

// POST /api/reports/export — CSV containing the summary text plus both
// tables, built from the exact report payload the frontend already rendered
// (rather than recomputing it) so the file can never drift from the screen.
router.post('/export', async (req, res) => {
  try {
    const { summary, teamsTable, weeklyChart, title, dateRangeLabel } = req.body || {};
    const lines = [];

    lines.push(csvRow([title || '']));
    lines.push(csvRow([dateRangeLabel || '']));
    lines.push('');
    lines.push(csvRow(['Резюме для стейкхолдеров']));
    for (const line of String(summary || '').split('\n').filter(Boolean)) {
      lines.push(csvRow([line]));
    }
    lines.push('');
    lines.push(csvRow(['План vs факт по командам']));
    lines.push(csvRow(['Команда', 'План, SP', 'Факт, SP', '%', 'Комментарий']));
    for (const row of teamsTable || []) {
      lines.push(csvRow([row.team, row.planSp, row.factSp, row.pct == null ? '' : `${row.pct}%`, row.comment]));
    }
    lines.push('');
    lines.push(csvRow(['Динамика доставки']));
    lines.push(csvRow(['Неделя', 'SP']));
    for (const week of weeklyChart || []) {
      lines.push(csvRow([week.weekLabel + (week.incomplete ? ' (не завершена)' : ''), week.sp]));
    }

    // BOM so Excel opens the UTF-8 file (Cyrillic headers/values) without mangling it.
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reports/summary — save a manual edit to the auto-generated
// summary text for one report scope (see periodKey above).
router.post('/summary', async (req, res) => {
  try {
    await ensureSchema();
    const { periodKey, summary } = req.body || {};
    if (!periodKey || typeof summary !== 'string') {
      return res.status(400).json({ error: 'periodKey and summary are required' });
    }
    await getPool().query(
      `INSERT INTO report_summary_draft (period_key, summary, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (period_key) DO UPDATE SET summary = $2, updated_at = now()`,
      [periodKey, summary]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
