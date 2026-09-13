const express = require('express');
const { ensureSchema, getPool } = require('../db');
const { getStoredToken } = require('../lib/jiraAuth');
const { computeProblemIssues } = require('../lib/problemIssues');
const { computeTeamsReport } = require('./teams');
const { computeSprintReport } = require('./sprints');

const router = express.Router();

const DEFAULT_PERIOD_DAYS = 7;
const CHART_WEEKS = 8;
const HIGH_BUG_RATE_PCT = 30;
const QUALITY_DEFAULT_PERIOD_DAYS = 56; // 8 weeks, per spec 2.1
const QUALITY_CHART_WEEKS = 8;
const VELOCITY_TREND_RATIO_GROWING = 1.1;
const VELOCITY_TREND_RATIO_FALLING = 0.9;

function avg(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

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

// --- Отчёт "Итоги спринта" (Часть 1) --------------------------------------

// 1.1's default differs from the Спринты screen's own default (active-first,
// see resolveActiveOrLatestClosed in sprints.js): a weekly/retro-style report
// wants the sprint that JUST finished, falling back to the in-progress one
// only when nothing has closed yet.
function resolveDefaultSprintForReport(sprints) {
  const closedDesc = sprints
    .filter((s) => s.state === 'closed')
    .sort((a, b) => new Date(b.complete_date || b.end_date || 0).getTime() - new Date(a.complete_date || a.end_date || 0).getTime());
  if (closedDesc[0]) return closedDesc[0];
  return sprints.find((s) => s.state === 'active') || null;
}

// "Тренд" vs the average of the last few sprints — same ±10% band the rest
// of the app uses for this kind of comparison (CYCLE_GOOD/RISK_RATIO in
// routes/dashboard.js, SP_OVERLOAD_RATIO there too).
function trendVsAverage(current, baselineValues) {
  const baselineAvg = baselineValues.length ? avg(baselineValues) : null;
  if (current == null || !baselineAvg) return null;
  const ratio = current / baselineAvg;
  const pct = Math.round((ratio - 1) * 100);
  if (ratio > 1.1) return { direction: 'up', pct };
  if (ratio < 0.9) return { direction: 'down', pct };
  return { direction: 'flat', pct };
}

// GET /api/reports/sprint-summary?sprint=<id>&team=&type= — 1.1-1.6.
router.get('/sprint-summary', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();
    const { rows: allSprints } = await pool.query(
      `SELECT id, name, state, start_date, end_date, complete_date FROM sprints`
    );

    if (!allSprints.length) {
      return res.json({ sprint: null });
    }

    let sprintId = parseInt(req.query.sprint, 10);
    if (!Number.isFinite(sprintId) || !allSprints.some((s) => s.id === sprintId)) {
      const fallback = resolveDefaultSprintForReport(allSprints);
      sprintId = fallback ? fallback.id : null;
    }

    const closedSorted = allSprints
      .filter((s) => s.state === 'closed')
      .sort((a, b) => new Date(b.complete_date || b.end_date || 0).getTime() - new Date(a.complete_date || a.end_date || 0).getTime());

    const report = await computeSprintReport({ sprint: String(sprintId), team: req.query.team, type: req.query.type });
    if (!report.sprint) {
      return res.json({ sprint: null });
    }

    // 1.2 — KPIs vs. the previous 2-3 sprints (same team/type scope), each
    // fetched through the same computeSprintReport so "Взято/Сделано" can't
    // be computed differently here than on the Спринты screen.
    const priorSprints = closedSorted.filter((s) => s.id !== sprintId).slice(0, 3);
    const priorReports = await Promise.all(
      priorSprints.map((s) => computeSprintReport({ sprint: String(s.id), team: req.query.team, type: req.query.type }))
    );
    const priorTakenSp = priorReports.map((r) => r.kpis?.takenSp).filter((v) => v != null);
    const priorDoneSp = priorReports.map((r) => r.kpis?.doneSp).filter((v) => v != null);
    const priorDoneSpPct = priorReports.map((r) => r.kpis?.doneSpPct).filter((v) => v != null);

    const kpiTrends = {
      takenSp: trendVsAverage(report.kpis?.takenSp, priorTakenSp),
      doneSp: trendVsAverage(report.kpis?.doneSp, priorDoneSp),
      doneSpPct: trendVsAverage(report.kpis?.doneSpPct, priorDoneSpPct),
    };

    // 1.3 — Scope creep list. scopeCreepPct itself is the same % already
    // shown on the Спринты screen's KPI card (share of ISSUE COUNT added
    // after start, not SP) — reused as-is rather than defining a second,
    // SP-based percentage the two screens could disagree about.
    const scopeCreepItems = report.selectedIssues
      .filter((i) => i.addedAfterSprintStart === true)
      .map((i) => ({ issueKey: i.issueKey, summary: i.summary, storyPoints: i.storyPoints }));

    // 1.4 — Carried-over / at-risk-of-carrying-over list: issues not in a
    // `done` status as of now. For a closed sprint these ARE the carried-
    // over tasks; for an active sprint they're the current candidates the
    // existing forecastPct/lagSp already summarize in aggregate — the list
    // itself is the same query either way, just labeled differently by the
    // frontend based on sprint.state.
    const carriedOverItems = report.selectedIssues
      .filter((i) => i.statusCategory !== 'done')
      .map((i) => ({ issueKey: i.issueKey, summary: i.summary, status: i.status, storyPoints: i.storyPoints }));

    // 1.5 — Reopen rate over every issue taken into the sprint.
    const totalCount = report.selectedIssues.length;
    const reopenedCount = report.selectedIssues.filter((i) => (i.reopenCount || 0) > 0).length;
    const reopenRatePct = totalCount ? Math.round((reopenedCount / totalCount) * 100) : null;

    // 1.6 — Top-3 longest: cycle_time for done issues, current
    // time-in-progress (today - started_at) for everything else with a
    // started_at; issues with neither have no basis for a duration and are
    // excluded rather than treated as 0.
    const now = Date.now();
    const topLongest = report.selectedIssues
      .map((i) => {
        let days = null;
        if (i.statusCategory === 'done' && i.cycleTime != null) days = Number(i.cycleTime);
        else if (i.startedAt) days = (now - new Date(i.startedAt).getTime()) / 86400000;
        return days == null ? null : { issueKey: i.issueKey, summary: i.summary, status: i.status, days: Math.round(days * 10) / 10 };
      })
      .filter(Boolean)
      .sort((a, b) => b.days - a.days)
      .slice(0, 3);

    res.json({
      sprint: report.sprint,
      kpis: report.kpis,
      kpiTrends,
      scopeCreepItems,
      scopeCreepPct: report.kpis?.scopeCreepPct ?? null,
      carriedOverItems,
      reopenRatePct,
      topLongest,
      sprintOptions: allSprints
        .slice()
        .sort((a, b) => new Date(b.start_date || 0).getTime() - new Date(a.start_date || 0).getTime())
        .map((s) => ({ value: String(s.id), label: s.name ? `${s.name}${s.state === 'active' ? ' (текущий)' : ''}` : `Спринт ${s.id}` })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/export-sprint', async (req, res) => {
  try {
    const { sprint, kpis, kpiTrends, scopeCreepItems, carriedOverItems, reopenRatePct, topLongest } = req.body || {};
    const lines = [];
    const fmtTrend = (t) => (t ? ` (${t.direction === 'up' ? '+' : t.direction === 'down' ? '' : '±'}${t.pct}% к среднему)` : '');

    lines.push(csvRow([`Итоги спринта — ${sprint?.name || ''}`]));
    lines.push('');
    lines.push(csvRow(['Взято SP', kpis?.takenSp ?? '']) + fmtTrend(kpiTrends?.takenSp));
    lines.push(csvRow(['Сделано SP', kpis?.doneSp ?? '']) + fmtTrend(kpiTrends?.doneSp));
    lines.push(csvRow(['% выполнения', kpis?.doneSpPct != null ? `${Math.round(kpis.doneSpPct)}%` : '']) + fmtTrend(kpiTrends?.doneSpPct));
    lines.push(csvRow(['Reopen rate', reopenRatePct != null ? `${reopenRatePct}%` : '']));
    lines.push('');
    lines.push(csvRow(['Scope creep']));
    lines.push(csvRow(['Ключ', 'Название', 'SP']));
    for (const item of scopeCreepItems || []) lines.push(csvRow([item.issueKey, item.summary, item.storyPoints ?? '']));
    lines.push('');
    lines.push(csvRow(['Перенесённые задачи']));
    lines.push(csvRow(['Ключ', 'Название', 'Статус', 'SP']));
    for (const item of carriedOverItems || []) lines.push(csvRow([item.issueKey, item.summary, item.status, item.storyPoints ?? '']));
    lines.push('');
    lines.push(csvRow(['Топ-3 самых долгих задачи']));
    lines.push(csvRow(['Ключ', 'Название', 'Статус', 'Дней']));
    for (const item of topLongest || []) lines.push(csvRow([item.issueKey, item.summary, item.status, item.days]));

    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sprint-report.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Отчёт "Качество и стабильность" (Часть 2) ----------------------------

function mondayOf(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

// GET /api/reports/quality — 2.2-2.6. periodDays defaults to 8 weeks (2.1)
// when the shared Период filter is "Всё время", same convention as
// /status's own DEFAULT_PERIOD_DAYS.
router.get('/quality', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();

    const projectFilter = toArray(req.query.project);
    const teamFilter = toArray(req.query.team);
    const period = req.query.period && req.query.period !== 'all' ? req.query.period : null;
    const periodDays = period ? Math.max(1, parseInt(period, 10) || QUALITY_DEFAULT_PERIOD_DAYS) : QUALITY_DEFAULT_PERIOD_DAYS;
    const cutoff = new Date(Date.now() - periodDays * 86400000);

    const conditions = ['is_deleted = false', 'created_at >= $1'];
    const params = [cutoff.toISOString()];
    if (projectFilter.length) {
      params.push(projectFilter);
      conditions.push(`COALESCE(project, 'Без проекта') = ANY($${params.length}::text[])`);
    }
    if (teamFilter.length) {
      params.push(teamFilter);
      conditions.push(`COALESCE(team, 'Без команды') = ANY($${params.length}::text[])`);
    }

    const { rows: issues } = await pool.query(
      `SELECT id, COALESCE(team, 'Без команды') AS team, issue_type, status_category, cycle_time,
              reopen_count, created_at, resolved_at
       FROM issues WHERE ${conditions.join(' AND ')}`,
      params
    );

    // 2.2 — weekly bug ratio, bucketed by created_at (same convention as the
    // "Динамика доставки"/Throughput charts elsewhere in the app, which also
    // bucket by an event date rather than "issues open as of").
    const thisMonday = mondayOf(new Date());
    const weeks = [];
    for (let i = QUALITY_CHART_WEEKS - 1; i >= 0; i--) {
      const mondayStart = new Date(thisMonday.getTime() - i * 7 * 86400000);
      const nextMonday = new Date(mondayStart.getTime() + 7 * 86400000);
      weeks.push({ mondayStart, nextMonday, total: 0, bugs: 0 });
    }
    for (const issue of issues) {
      const createdAt = new Date(issue.created_at);
      const week = weeks.find((w) => createdAt >= w.mondayStart && createdAt < w.nextMonday);
      if (!week) continue;
      week.total += 1;
      if (issue.issue_type === 'Bug') week.bugs += 1;
    }
    const weeklyBugRate = weeks.map((w) => ({
      weekLabel: `${w.mondayStart.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`,
      bugRatePct: w.total ? Math.round((w.bugs / w.total) * 1000) / 10 : null,
    }));

    // 2.3/2.4/2.5 — per-team breakdowns over the same period-filtered set.
    const byTeam = new Map();
    for (const issue of issues) {
      if (!byTeam.has(issue.team)) byTeam.set(issue.team, { total: 0, bugs: 0, done: 0, doneReopened: 0 });
      const g = byTeam.get(issue.team);
      g.total += 1;
      if (issue.issue_type === 'Bug') g.bugs += 1;
      if (issue.status_category === 'done') {
        g.done += 1;
        if ((issue.reopen_count || 0) > 0) g.doneReopened += 1;
      }
    }
    const bugRateByTeam = [...byTeam.entries()]
      .map(([team, g]) => ({ team, bugRatePct: g.total ? Math.round((g.bugs / g.total) * 1000) / 10 : null }))
      .sort((a, b) => (b.bugRatePct ?? -1) - (a.bugRatePct ?? -1));
    const reopenRateByTeam = [...byTeam.entries()]
      .map(([team, g]) => ({ team, reopenRatePct: g.done ? Math.round((g.doneReopened / g.done) * 1000) / 10 : null }))
      .sort((a, b) => (b.reopenRatePct ?? -1) - (a.reopenRatePct ?? -1));

    const doneWithCycle = issues.filter((i) => i.status_category === 'done' && i.cycle_time != null);
    const bugCycle = doneWithCycle.filter((i) => i.issue_type === 'Bug').map((i) => Number(i.cycle_time));
    const otherCycle = doneWithCycle.filter((i) => i.issue_type !== 'Bug').map((i) => Number(i.cycle_time));
    const cycleTimeByType = {
      bugAvg: bugCycle.length ? avg(bugCycle) : null,
      otherAvg: otherCycle.length ? avg(otherCycle) : null,
      bugCount: bugCycle.length,
      otherCount: otherCycle.length,
    };

    // 2.6 — "Топ задач по количеству багов": issue_links of ANY type between
    // a Bug and a non-Bug issue (confirmed with the user that issue_links
    // isn't restricted to "blocked by" — it stores every link type from
    // every synced issue's issuelinks field, see extractIssueLinks in
    // routes/jira.js). A link is recorded from both issues' own
    // perspectives by Jira, so the same bug<->task pair can appear as two
    // rows here — deduped via a Set before counting.
    const { rows: linkRows } = await pool.query(
      `SELECT il.issue_id AS a_id, il.linked_issue_id AS b_id,
              ia.issue_type AS a_type, ib.issue_type AS b_type,
              ia.issue_key AS a_key, ia.summary AS a_summary, COALESCE(ia.team, 'Без команды') AS a_team,
              ib.issue_key AS b_key, ib.summary AS b_summary, COALESCE(ib.team, 'Без команды') AS b_team
       FROM issue_links il
       JOIN issues ia ON ia.id = il.issue_id
       JOIN issues ib ON ib.id = il.linked_issue_id
       WHERE il.linked_issue_id IS NOT NULL AND ia.is_deleted = false AND ib.is_deleted = false`
    );

    const seenPairs = new Set();
    const bugsByParent = new Map();
    for (const row of linkRows) {
      let bug, parent;
      if (row.a_type === 'Bug' && row.b_type !== 'Bug') {
        bug = { id: row.a_id };
        parent = { id: row.b_id, key: row.b_key, summary: row.b_summary, team: row.b_team };
      } else if (row.b_type === 'Bug' && row.a_type !== 'Bug') {
        bug = { id: row.b_id };
        parent = { id: row.a_id, key: row.a_key, summary: row.a_summary, team: row.a_team };
      } else {
        continue; // both Bug, both non-Bug, or missing type — not this report's shape
      }
      if (projectFilter.length || teamFilter.length) {
        // Applied to the PARENT (non-bug) issue, which is the table's row subject.
        if (teamFilter.length && !teamFilter.includes(parent.team)) continue;
      }
      const pairKey = [bug.id, parent.id].sort().join(':');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      if (!bugsByParent.has(parent.id)) bugsByParent.set(parent.id, { ...parent, bugCount: 0 });
      bugsByParent.get(parent.id).bugCount += 1;
    }
    const topBuggyTasks = [...bugsByParent.values()]
      .sort((a, b) => b.bugCount - a.bugCount)
      .slice(0, 10)
      .map((p) => ({ issueKey: p.key, summary: p.summary, team: p.team, bugCount: p.bugCount }));

    res.json({
      periodDays,
      dateRangeLabel: `${cutoff.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} — ${new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`,
      weeklyBugRate,
      bugRateByTeam,
      reopenRateByTeam,
      cycleTimeByType,
      topBuggyTasks,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/export-quality', async (req, res) => {
  try {
    const { dateRangeLabel, weeklyBugRate, bugRateByTeam, reopenRateByTeam, cycleTimeByType, topBuggyTasks } = req.body || {};
    const lines = [];

    lines.push(csvRow(['Качество и стабильность', dateRangeLabel || '']));
    lines.push('');
    lines.push(csvRow(['% багов от общего объёма по неделям']));
    lines.push(csvRow(['Неделя', '% багов']));
    for (const w of weeklyBugRate || []) lines.push(csvRow([w.weekLabel, w.bugRatePct == null ? '' : `${w.bugRatePct}%`]));
    lines.push('');
    lines.push(csvRow(['% багов по командам']));
    lines.push(csvRow(['Команда', '% багов']));
    for (const t of bugRateByTeam || []) lines.push(csvRow([t.team, t.bugRatePct == null ? '' : `${t.bugRatePct}%`]));
    lines.push('');
    lines.push(csvRow(['Reopen rate по командам']));
    lines.push(csvRow(['Команда', 'Reopen rate']));
    for (const t of reopenRateByTeam || []) lines.push(csvRow([t.team, t.reopenRatePct == null ? '' : `${t.reopenRatePct}%`]));
    lines.push('');
    lines.push(csvRow(['Средний Cycle Time', 'Баги', 'Остальные']));
    lines.push(csvRow(['', cycleTimeByType?.bugAvg != null ? cycleTimeByType.bugAvg.toFixed(1) : '', cycleTimeByType?.otherAvg != null ? cycleTimeByType.otherAvg.toFixed(1) : '']));
    lines.push('');
    lines.push(csvRow(['Топ задач по количеству багов']));
    lines.push(csvRow(['Ключ', 'Название', 'Команда', 'Багов']));
    for (const t of topBuggyTasks || []) lines.push(csvRow([t.issueKey, t.summary, t.team, t.bugCount]));

    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="quality-report.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Отчёт "Здоровье команд" (Часть 3) ------------------------------------

function velocityTrend(sprintChart) {
  const closed = sprintChart.filter((s) => s.state === 'closed');
  if (closed.length < 3) return null; // need at least "last 2" + "other 3" to compare something
  const lastTwo = closed.slice(-2).map((s) => s.doneSp);
  const others = closed.slice(0, -2).slice(-3).map((s) => s.doneSp);
  if (!others.length) return null;
  const ratio = avg(lastTwo) / (avg(others) || 1);
  if (ratio > VELOCITY_TREND_RATIO_GROWING) return 'growing';
  if (ratio < VELOCITY_TREND_RATIO_FALLING) return 'falling';
  return 'stable';
}

const SIGNAL_LABEL = { wip: 'WIP', cycle_time: 'Cycle Time', velocity: 'Velocity' };

// GET /api/reports/teams-health — 3.2-3.4. Reuses computeTeamsReport
// wholesale (same health/signals/sprintChart/peopleLoad computation the
// Команды screen itself uses) rather than re-deriving any of it.
//
// 3.5 ("Изменения с прошлого периода") is NOT implemented — see README for
// why: the WIP signal is a live snapshot with no historical record, so
// reconstructing "health as of a past period" would mean building a second,
// parameterized copy of the whole 3-signal engine (WIP via
// issue_status_events, sprints via complete_date cutoffs, cycle time via a
// shifted window) that could silently drift from the live one. Flagged to
// the user rather than approximated.
router.get('/teams-health', async (req, res) => {
  try {
    const teamsData = await computeTeamsReport(req.query);

    const teams = teamsData.teams.map((t) => ({
      team: t.team,
      health: t.health,
      reasons: t.healthSignals.filter((s) => s.triggered).map((s) => SIGNAL_LABEL[s.name] || s.name),
      velocityHistory: t.sprintChart.filter((s) => s.state === 'closed').map((s) => ({ sprintName: s.name, doneSp: s.doneSp })),
      velocityTrend: velocityTrend(t.sprintChart),
    }));

    const peopleLoad = teamsData.teams.flatMap((t) => t.peopleLoad.map((p) => ({ ...p, team: t.team })));

    res.json({ teams, peopleLoad });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/export-teams-health', async (req, res) => {
  try {
    const { teams, peopleLoad } = req.body || {};
    const lines = [];

    lines.push(csvRow(['Здоровье команд']));
    lines.push('');
    lines.push(csvRow(['Команда', 'Статус', 'Причина']));
    for (const t of teams || []) lines.push(csvRow([t.team, t.health, (t.reasons || []).join(', ')]));
    lines.push('');
    lines.push(csvRow(['Тренд Velocity']));
    lines.push(csvRow(['Команда', 'Тренд', 'Последние спринты (Done SP)']));
    for (const t of teams || []) {
      lines.push(csvRow([t.team, t.velocityTrend || '—', (t.velocityHistory || []).map((s) => s.doneSp).join(' / ')]));
    }
    lines.push('');
    lines.push(csvRow(['Загрузка людей']));
    lines.push(csvRow(['Команда', 'Исполнитель', 'В работе', 'SP', 'Статус']));
    for (const p of peopleLoad || []) lines.push(csvRow([p.team, p.assignee || 'не назначен', p.inProgress, p.sp, p.status]));

    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="teams-health-report.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
