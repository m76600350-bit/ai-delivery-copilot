const express = require('express');
const { ensureSchema, getPool } = require('../db');

const router = express.Router();

// "Отставание cycle time" recency window (Signal 2) — matches the Период
// convention used elsewhere in the app (Dashboard/Tasks).
const RECENT_CYCLE_TIME_WINDOW_DAYS = 30;
// How many of a team's most recent CLOSED sprints the velocity trend signal
// looks at (Signal 3) — the evaluated sprint plus up to this many prior ones
// to average against.
const VELOCITY_HISTORY_SPRINTS = 5;
const MIN_COMPLETED_ISSUES_FOR_HEALTH = 3;

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function avg(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sumSp(issues) {
  return issues.reduce((total, i) => total + (Number(i.story_points) || 0), 0);
}

// GET /api/teams/filters — options for the page's own Спринт/Команда/Проект
// filter bar (deliberately separate state from the Dashboard/Tasks filters).
router.get('/filters', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();
    const [{ rows: sprintRows }, { rows: teamRows }, { rows: projectRows }] = await Promise.all([
      pool.query(
        `SELECT id, name, state FROM sprints ORDER BY COALESCE(start_date, '1970-01-01') DESC`
      ),
      pool.query(
        `SELECT DISTINCT COALESCE(team, 'Без команды') AS v FROM issues WHERE is_deleted = false ORDER BY v`
      ),
      pool.query(
        `SELECT DISTINCT COALESCE(project, 'Без проекта') AS v FROM issues WHERE is_deleted = false ORDER BY v`
      ),
    ]);

    res.json({
      sprints: sprintRows.map((s) => ({ value: String(s.id), label: s.name ? `${s.name}${s.state === 'active' ? ' (активный)' : ''}` : `Спринт ${s.id}` })),
      teams: teamRows.map((r) => r.v),
      projects: projectRows.map((r) => r.v),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolves each team's "last sprint" — the active one if there is one,
// otherwise the most recently completed. Reused by both the Velocity metric
// (2.2, when no Спринт filter is applied) and the "Здоровье последнего
// спринта" block (2.5), which always uses this regardless of the page filter.
function resolveLastSprint(teamSprints) {
  const active = teamSprints.find((s) => s.state === 'active');
  if (active) return active;
  const closed = teamSprints
    .filter((s) => s.state === 'closed')
    .sort((a, b) => new Date(b.complete_date || b.end_date || 0).getTime() - new Date(a.complete_date || a.end_date || 0).getTime());
  return closed[0] || null;
}

// GET /api/teams — the full aggregated report backing the "Команды" screen:
// the main per-team table (2.2), plus everything a team's detail card needs
// (2.3/2.4) and the "Здоровье последнего спринта" table (2.5), computed
// server-side in JS from a handful of already-synced-data queries rather
// than one enormous SQL query.
router.get('/', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();

    const teamFilter = toArray(req.query.team);
    const projectFilter = toArray(req.query.project);
    // Sprint ids are our internal `sprints.id` (see /filters), not Jira's.
    const sprintFilter = toArray(req.query.sprint).map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n));

    const conditions = ['is_deleted = false'];
    const params = [];
    if (projectFilter.length) {
      params.push(projectFilter);
      conditions.push(`COALESCE(project, 'Без проекта') = ANY($${params.length}::text[])`);
    }
    if (teamFilter.length) {
      params.push(teamFilter);
      conditions.push(`COALESCE(team, 'Без команды') = ANY($${params.length}::text[])`);
    }

    const [{ rows: issues }, { rows: sprints }, { rows: issueSprints }, { rows: links }, { rows: limitRows }] = await Promise.all([
      pool.query(
        `SELECT id, issue_key, COALESCE(team, 'Без команды') AS team, project, issue_type, status,
                status_category, cycle_time, resolved_at, story_points, assignee, updated_at, created_at
         FROM issues WHERE ${conditions.join(' AND ')}`,
        params
      ),
      pool.query('SELECT id, name, state, start_date, end_date, complete_date FROM sprints'),
      pool.query('SELECT issue_id, sprint_id, added_after_sprint_start FROM issue_sprints'),
      pool.query(
        `SELECT issue_id, link_type, linked_issue_status_category FROM issue_links
         WHERE link_type ILIKE '%blocked by%'`
      ),
      pool.query('SELECT status_name, limit_value FROM wip_limits WHERE limit_value IS NOT NULL'),
    ]);

    const wipLimitSum = limitRows.reduce((total, r) => total + (r.limit_value || 0), 0);
    const wipLimitsConfigured = limitRows.length > 0;

    const sprintsById = new Map(sprints.map((s) => [s.id, s]));
    const issuesById = new Map(issues.map((i) => [i.id, i]));

    // issue_id -> [{sprintId, addedAfterStart}], restricted to issues in the
    // current filter scope (issuesById) so a team's "sprints" list only
    // reflects sprints that actually have issues in scope.
    const sprintsByIssueId = new Map();
    for (const row of issueSprints) {
      if (!issuesById.has(row.issue_id)) continue;
      if (!sprintsByIssueId.has(row.issue_id)) sprintsByIssueId.set(row.issue_id, []);
      sprintsByIssueId.get(row.issue_id).push({ sprintId: row.sprint_id, addedAfterStart: row.added_after_sprint_start });
    }

    // sprintId -> [{issue, addedAfterStart}] — the inverse, for per-sprint sums.
    const issuesBySprintId = new Map();
    for (const [issueId, issueSprintEntries] of sprintsByIssueId.entries()) {
      const issue = issuesById.get(issueId);
      for (const { sprintId, addedAfterStart } of issueSprintEntries) {
        if (!issuesBySprintId.has(sprintId)) issuesBySprintId.set(sprintId, []);
        issuesBySprintId.get(sprintId).push({ issue, addedAfterStart });
      }
    }

    // issue_id -> true if it has an active blocking link (unresolved "is
    // blocked by" pointing at a not-done issue).
    const blockedIssueIds = new Set(
      links
        .filter((l) => issuesById.has(l.issue_id) && l.linked_issue_status_category && l.linked_issue_status_category !== 'done')
        .map((l) => l.issue_id)
    );

    const teamNames = [...new Set(issues.map((i) => i.team))].sort();

    const sumSpForSprint = (sprintId, { onlyDone = false } = {}) => {
      const entries = issuesBySprintId.get(sprintId) || [];
      const filtered = onlyDone ? entries.filter((e) => e.issue.status_category === 'done') : entries;
      return sumSp(filtered.map((e) => e.issue));
    };

    const teams = teamNames.map((team) => {
      const teamIssues = issues.filter((i) => i.team === team);
      const teamIssueIds = new Set(teamIssues.map((i) => i.id));

      const peopleCount = new Set(teamIssues.filter((i) => i.assignee).map((i) => i.assignee)).size;

      const wipIssues = teamIssues.filter((i) => i.status_category === 'indeterminate');
      const wipCount = wipIssues.length;

      const bugCount = teamIssues.filter((i) => i.issue_type === 'Bug').length;
      const bugRatePct = teamIssues.length ? (bugCount / teamIssues.length) * 100 : null;

      const completedAllTime = teamIssues.filter((i) => i.status_category === 'done');
      const completedWithCycleTime = completedAllTime.filter((i) => i.cycle_time != null);
      const cycleTimeAvg = completedWithCycleTime.length ? avg(completedWithCycleTime.map((i) => Number(i.cycle_time))) : null;

      const blockersCount = teamIssues.filter((i) => blockedIssueIds.has(i.id)).length;

      // This team's sprints, restricted to those with at least one in-scope
      // issue belonging to the team.
      const teamSprintIds = new Set();
      for (const issue of teamIssues) {
        for (const { sprintId } of sprintsByIssueId.get(issue.id) || []) teamSprintIds.add(sprintId);
      }
      const teamSprints = [...teamSprintIds].map((id) => sprintsById.get(id)).filter(Boolean);
      const closedSprintsDesc = teamSprints
        .filter((s) => s.state === 'closed')
        .sort((a, b) => new Date(b.complete_date || b.end_date || 0).getTime() - new Date(a.complete_date || a.end_date || 0).getTime());
      const lastSprint = resolveLastSprint(teamSprints);

      // Velocity SP — the selected sprint(s) if the page's Спринт filter is
      // active, otherwise the team's own last sprint (2.2's explicit rule).
      const velocityTargetSprintIds = sprintFilter.length ? sprintFilter.filter((id) => teamSprintIds.has(id)) : lastSprint ? [lastSprint.id] : [];
      const velocitySpSeen = new Set();
      let velocitySp = 0;
      for (const sprintId of velocityTargetSprintIds) {
        for (const { issue } of issuesBySprintId.get(sprintId) || []) {
          if (issue.team !== team || velocitySpSeen.has(issue.id)) continue;
          velocitySpSeen.add(issue.id);
          velocitySp += Number(issue.story_points) || 0;
        }
      }
      const velocitySpValue = velocityTargetSprintIds.length ? velocitySp : null;

      // --- Здоровье (3-signal model, each against the team's OWN history) ---
      const hasEnoughCompleted = completedAllTime.length >= MIN_COMPLETED_ISSUES_FOR_HEALTH;
      const hasSprintHistory = closedSprintsDesc.length >= 1;

      let health = 'insufficient_data';
      const signals = [];

      if (hasEnoughCompleted && hasSprintHistory) {
        // Signal 1: current WIP vs. the (global) configured limit.
        if (wipLimitSum > 0) {
          const ratio = wipCount / wipLimitSum;
          signals.push({ name: 'wip', ratio, triggered: ratio > 1.0 });
        }

        // Signal 2: recent cycle time vs. this team's all-time average.
        const recentCutoff = Date.now() - RECENT_CYCLE_TIME_WINDOW_DAYS * 86400000;
        const recentCompleted = completedWithCycleTime.filter(
          (i) => i.resolved_at && new Date(i.resolved_at).getTime() >= recentCutoff
        );
        if (recentCompleted.length && cycleTimeAvg) {
          const recentAvg = avg(recentCompleted.map((i) => Number(i.cycle_time)));
          const ratio = recentAvg / cycleTimeAvg;
          signals.push({ name: 'cycle_time', ratio, triggered: ratio > 1.3 });
        }

        // Signal 3: the most recently closed sprint's completed SP vs. the
        // average of the closed sprints just before it.
        const evalSprint = closedSprintsDesc[0];
        const baselineSprints = closedSprintsDesc.slice(1, VELOCITY_HISTORY_SPRINTS);
        if (evalSprint && baselineSprints.length) {
          const evalSp = sumSpForSprint(evalSprint.id, { onlyDone: true });
          const baselineAvg = avg(baselineSprints.map((s) => sumSpForSprint(s.id, { onlyDone: true })));
          if (baselineAvg > 0) {
            const ratio = evalSp / baselineAvg;
            signals.push({ name: 'velocity', ratio, triggered: ratio < 0.7 });
          }
        }

        const triggeredCount = signals.filter((s) => s.triggered).length;
        health = triggeredCount === 0 ? 'normal' : triggeredCount === 1 ? 'risk' : 'overload';
      }

      // --- Карточка команды: график SP по спринтам (2.3) ---
      const chartSprints = [...teamSprints]
        .sort((a, b) => new Date(a.start_date || 0).getTime() - new Date(b.start_date || 0).getTime())
        .slice(-5);
      const sprintChart = chartSprints.map((s) => ({
        sprintId: s.id,
        name: s.name,
        state: s.state,
        takenSp: sumSpForSprint(s.id),
        doneSp: sumSpForSprint(s.id, { onlyDone: true }),
      }));

      // --- Структура работы за период (2.3) — scoped to the selected
      // sprint(s) if the page filter is active, else all-time for the team.
      const workTypeScopeIssues = sprintFilter.length
        ? teamIssues.filter((i) => (sprintsByIssueId.get(i.id) || []).some((l) => sprintFilter.includes(l.sprintId)))
        : teamIssues;
      const workTypeCounts = {};
      for (const i of workTypeScopeIssues) {
        const t = i.issue_type || 'Без типа';
        workTypeCounts[t] = (workTypeCounts[t] || 0) + 1;
      }
      const workTypeTotal = workTypeScopeIssues.length;
      const workTypeBreakdown = Object.entries(workTypeCounts)
        .map(([type, count]) => ({ type, count, pct: workTypeTotal ? (count / workTypeTotal) * 100 : 0 }))
        .sort((a, b) => b.count - a.count);

      // --- Загрузка людей (2.4) — current WIP, per assignee. ---
      const peopleMap = new Map();
      for (const issue of wipIssues) {
        const key = issue.assignee || null;
        if (!peopleMap.has(key)) peopleMap.set(key, { assignee: key, inProgress: 0, sp: 0, maxDaysInStatus: 0 });
        const entry = peopleMap.get(key);
        entry.inProgress += 1;
        entry.sp += Number(issue.story_points) || 0;
        const daysInStatus = Math.max(0, Math.floor((Date.now() - new Date(issue.updated_at).getTime()) / 86400000));
        entry.maxDaysInStatus = Math.max(entry.maxDaysInStatus, daysInStatus);
      }
      const peopleLoad = [...peopleMap.values()]
        .map((p) => ({
          ...p,
          status: p.inProgress <= 3 ? 'normal' : p.inProgress <= 6 ? 'at_limit' : 'overload',
        }))
        .sort((a, b) => b.inProgress - a.inProgress);

      // --- Здоровье последнего спринта (2.5) — always the team's own last
      // sprint, independent of the page's Спринт filter.
      let sprintHealth = null;
      if (lastSprint) {
        const entries = issuesBySprintId.get(lastSprint.id) || [];
        const teamEntries = entries.filter((e) => e.issue.team === team);
        const takenSp = sumSp(teamEntries.filter((e) => e.addedAfterStart !== true).map((e) => e.issue));
        const doneSp = sumSp(teamEntries.filter((e) => e.issue.status_category === 'done').map((e) => e.issue));
        const carriedOverCount = teamEntries.filter((e) => e.issue.status_category !== 'done').length;
        const scopeCreepPct = teamEntries.length
          ? (teamEntries.filter((e) => e.addedAfterStart === true).length / teamEntries.length) * 100
          : null;
        sprintHealth = {
          sprintId: lastSprint.id,
          sprintName: lastSprint.name,
          takenSp,
          doneSp,
          carriedOverCount,
          scopeCreepPct,
        };
      }

      return {
        team,
        peopleCount,
        wip: { count: wipCount, limit: wipLimitsConfigured ? wipLimitSum : null },
        velocitySp: velocitySpValue,
        cycleTimeAvg,
        bugRatePct,
        blockersCount,
        health,
        healthSignals: signals,
        sprintChart,
        workTypeBreakdown,
        peopleLoad,
        sprintHealth,
      };
    });

    res.json({ teams, wipLimitsConfigured });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
