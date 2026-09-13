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

// The full aggregated report backing the "Команды" screen: the main
// per-team table (2.2), plus everything a team's detail card needs (2.3/2.4)
// and the "Здоровье последнего спринта" table (2.5), computed server-side in
// JS from a handful of already-synced-data queries rather than one enormous
// SQL query. Extracted out of the route handler so the Отчёты screen's
// "План vs факт по командам" table (same last-sprint taken/done SP + health
// signals) can reuse it instead of re-deriving team health independently.
// query additionally accepts type/status/priority (not used by the Команды
// screen itself, which has no such filters, but needed so a report scoped by
// the shared Dashboard/Tasks filter set narrows the same issue population).
async function computeTeamsReport(query) {
  await ensureSchema();
  const pool = getPool();

  const teamFilter = toArray(query.team);
  const projectFilter = toArray(query.project);
  const typeFilter = toArray(query.type);
  const statusFilter = toArray(query.status);
  const priorityFilter = toArray(query.priority);
  // Sprint ids are our internal `sprints.id` (see /filters), not Jira's.
  const sprintFilter = toArray(query.sprint).map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n));

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
  if (typeFilter.length) {
    params.push(typeFilter);
    conditions.push(`COALESCE(issue_type, 'Без типа') = ANY($${params.length}::text[])`);
  }
  if (statusFilter.length) {
    params.push(statusFilter);
    conditions.push(`COALESCE(status, 'Без статуса') = ANY($${params.length}::text[])`);
  }
  if (priorityFilter.length) {
    params.push(priorityFilter);
    conditions.push(`COALESCE(priority, 'Без приоритета') = ANY($${params.length}::text[])`);
  }

    const [{ rows: issues }, { rows: sprints }, { rows: issueSprints }, { rows: links }, { rows: limitRows }, { rows: roleRows }, { rows: crossTeamLinkRows }] = await Promise.all([
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
      pool.query('SELECT team, status_name, role, limit_value FROM wip_limits WHERE limit_value IS NOT NULL'),
      pool.query('SELECT team, role, count(*)::int AS headcount FROM team_roles GROUP BY team, role'),
      // Cross-team dependencies (2.6) — the Команда filter is meant to
      // scope the main per-team table (which of its own issues a team's row
      // reflects), not to hide half of a cross-team pair: filtering by
      // team=Beta should still surface "Alpha ждёт Beta" even though none of
      // Beta's own issues are blocked. So this deliberately queries BOTH
      // sides of every link independent of teamFilter (only project is
      // applied, matching what the pair's issues actually belong to), and
      // the team filter is instead applied as an OR-match against the
      // resulting pairs below.
      pool.query(
        `SELECT il.issue_id, COALESCE(i1.team, 'Без команды') AS blocked_team, i1.project AS blocked_project,
                COALESCE(i2.team, 'Без команды') AS blocker_team, i2.project AS blocker_project,
                i2.status_category AS blocker_status_category, i2.created_at AS blocker_created_at
         FROM issue_links il
         JOIN issues i1 ON i1.id = il.issue_id
         JOIN issues i2 ON i2.id = il.linked_issue_id
         WHERE il.link_type ILIKE '%blocked by%' AND i1.is_deleted = false AND i2.is_deleted = false`
      ),
    ]);

    // A team's overall WIP limit = sum over its wip_limits rows of
    // limit_value * how many of its members currently have that role
    // (team_roles) — not a flat per-status number, and not global.
    const headcountByTeamRole = new Map(roleRows.map((r) => [`${r.team} ${r.role}`, r.headcount]));
    const limitsByTeam = new Map();
    for (const row of limitRows) {
      if (!limitsByTeam.has(row.team)) limitsByTeam.set(row.team, []);
      limitsByTeam.get(row.team).push(row);
    }
    const wipLimitSumForTeam = (team) => {
      const rows = limitsByTeam.get(team) || [];
      return rows.reduce((total, r) => total + (r.limit_value || 0) * (headcountByTeamRole.get(`${team} ${r.role}`) || 0), 0);
    };
    const hasAnyRoleAssignedForTeam = (team) => roleRows.some((r) => r.team === team && r.headcount > 0);

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

      const wipLimitSum = wipLimitSumForTeam(team);
      const wipLimitConfigured = limitsByTeam.has(team) && hasAnyRoleAssignedForTeam(team);

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
        // Signal 1: current WIP vs. this team's configured limit.
        if (wipLimitConfigured && wipLimitSum > 0) {
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
        wip: { count: wipCount, limit: wipLimitConfigured ? wipLimitSum : null },
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

  // --- Зависимости между командами (2.6) — "is blocked by" links where the
  // blocked issue and its blocker belong to different teams, grouped into
  // (кто ждёт → кого ждёт) pairs. A link is only counted while still active:
  // the blocking issue must not yet be done. "Макс. ожидание" is the oldest
  // still-open blocker in the pair, measured from ITS OWN created_at — the
  // spec's proxy for "how long has this dependency existed" (there's no
  // stored "blocked since" timestamp; issue_links is rebuilt fresh every
  // sync, same reasoning as the "блокер" risk elsewhere in the app).
  const crossTeamPairs = new Map();
  for (const row of crossTeamLinkRows) {
    if (row.blocker_status_category === 'done') continue; // no longer active
    if (row.blocked_team === row.blocker_team) continue; // same-team, not cross-team
    if (projectFilter.length && !projectFilter.includes(row.blocked_project) && !projectFilter.includes(row.blocker_project)) continue;
    if (teamFilter.length && !teamFilter.includes(row.blocked_team) && !teamFilter.includes(row.blocker_team)) continue;

    const key = `${row.blocked_team} :: ${row.blocker_team}`;
    if (!crossTeamPairs.has(key)) {
      crossTeamPairs.set(key, { waitingTeam: row.blocked_team, blockingTeam: row.blocker_team, count: 0, maxWaitDays: 0 });
    }
    const pair = crossTeamPairs.get(key);
    pair.count += 1;
    const waitDays = Math.max(0, Math.floor((Date.now() - new Date(row.blocker_created_at).getTime()) / 86400000));
    pair.maxWaitDays = Math.max(pair.maxWaitDays, waitDays);
  }
  const crossTeamDependencies = [...crossTeamPairs.values()].sort((a, b) => b.maxWaitDays - a.maxWaitDays);

  return { teams, crossTeamDependencies };
}

// GET /api/teams — see computeTeamsReport above for what this returns.
router.get('/', async (req, res) => {
  try {
    const data = await computeTeamsReport(req.query);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.computeTeamsReport = computeTeamsReport;
