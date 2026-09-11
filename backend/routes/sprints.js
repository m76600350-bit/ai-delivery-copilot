const express = require('express');
const { ensureSchema, getPool } = require('../db');

const router = express.Router();

// Temporary fixed threshold for "висит на ревью" — spec allows either this
// or 1.5x a team's average time-in-status; the latter needs per-team status
// baselines we don't compute anywhere yet, so this is the simpler of the
// two options offered, called out here as a placeholder.
const REVIEW_STALE_DAYS = 3;
// "текущий + все сохранённые закрытые, до 5 штук" — the active sprint plus
// up to this many of its most recent closed siblings.
const MAX_HISTORY_SPRINTS = 5;

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function avg(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sumSp(rows) {
  return rows.reduce((total, r) => total + (Number(r.story_points) || 0), 0);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function endOfDayMs(date) {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d.getTime();
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

// Inclusive day-by-day range, capped defensively — a sprint is always a few
// weeks, this just guards against a corrupt/absurd date range looping forever.
function buildDayRange(start, end) {
  const days = [];
  let cur = startOfDay(start);
  const last = startOfDay(end);
  let guard = 0;
  while (cur.getTime() <= last.getTime() && guard < 120) {
    days.push(cur);
    cur = new Date(cur.getTime() + 86400000);
    guard += 1;
  }
  return days;
}

// events: [{atMs, category}] sorted ascending by atMs (issue_status_events
// is inserted in that order and selected with ORDER BY changed_at). Returns
// the category as of the given boundary, or null if the issue's genesis
// event is itself after the boundary (didn't exist yet on that day).
function categoryAsOf(events, boundaryMs) {
  let result = null;
  for (const ev of events) {
    if (ev.atMs <= boundaryMs) result = ev.category;
    else break;
  }
  return result;
}

function resolveActiveOrLatestClosed(sprints) {
  const active = sprints.find((s) => s.state === 'active');
  if (active) return active;
  const closedDesc = sprints
    .filter((s) => s.state === 'closed')
    .sort((a, b) => new Date(b.complete_date || b.end_date || 0).getTime() - new Date(a.complete_date || a.end_date || 0).getTime());
  return closedDesc[0] || null;
}

// GET /api/sprints/filters — options for the page's own Спринт (single,
// defaults to active)/Команда/Тип задачи filter bar — a separate state from
// every other screen's filters, per spec.
router.get('/filters', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();
    const [{ rows: sprintRows }, { rows: teamRows }, { rows: typeRows }] = await Promise.all([
      pool.query(
        `SELECT id, name, state, start_date, end_date, complete_date FROM sprints ORDER BY COALESCE(start_date, '1970-01-01') DESC`
      ),
      pool.query(`SELECT DISTINCT COALESCE(team, 'Без команды') AS v FROM issues WHERE is_deleted = false ORDER BY v`),
      pool.query(`SELECT DISTINCT COALESCE(issue_type, 'Без типа') AS v FROM issues WHERE is_deleted = false ORDER BY v`),
    ]);

    const activeSprint = resolveActiveOrLatestClosed(sprintRows);

    res.json({
      sprints: sprintRows.map((s) => ({
        value: String(s.id),
        label: s.name ? `${s.name}${s.state === 'active' ? ' (текущий)' : ''}` : `Спринт ${s.id}`,
        state: s.state,
      })),
      defaultSprint: activeSprint ? String(activeSprint.id) : null,
      teams: teamRows.map((r) => r.v),
      types: typeRows.map((r) => r.v),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared shape for one sprint's aggregate numbers — used both for the
// selected sprint's KPI cards and for each row of "История спринтов".
function computeSprintAggregate(rows) {
  const takenSp = round2(sumSp(rows));
  const takenCount = rows.length;
  const doneRows = rows.filter((r) => r.status_category === 'done');
  const doneSp = round2(sumSp(doneRows));
  const doneSpPct = takenSp > 0 ? (doneSp / takenSp) * 100 : null;
  const addedRows = rows.filter((r) => r.added_after_sprint_start === true);
  const addedAfterStartSp = round2(sumSp(addedRows));
  const scopeCreepPct = takenCount > 0 ? (addedRows.length / takenCount) * 100 : null;
  const carriedOverCount = rows.filter((r) => r.status_category !== 'done').length;
  const cycleTimes = doneRows.filter((r) => r.cycle_time != null).map((r) => Number(r.cycle_time));
  const avgCycleTime = cycleTimes.length ? avg(cycleTimes) : null;
  return { takenSp, takenCount, doneSp, doneSpPct, addedAfterStartSp, scopeCreepPct, carriedOverCount, avgCycleTime };
}

// Burndown (SP remaining per day vs. an ideal straight line from the
// sprint's current total SP to 0 at end_date) and the cumulative-flow
// diagram (issue counts per category per day), both reconstructed from
// issue_status_events rather than re-fetching changelog.
function computeBurndownAndCfd(sprint, rows, eventsByIssueId) {
  if (!sprint.start_date || !sprint.end_date) return { burndown: [], cfd: [] };

  const start = new Date(sprint.start_date);
  const end = new Date(sprint.end_date);
  const today = new Date();
  // The burndown's timeline always spans the whole sprint (start_date to
  // end_date) so a just-started sprint doesn't render as a near-empty
  // one/two-point chart — only the days up to today get a real "факт" point
  // (actualSp stays null beyond today, which the frontend simply doesn't
  // plot); the idealSp reference line is defined for every day regardless.
  const fullDays = buildDayRange(start, end);
  if (!fullDays.length) return { burndown: [], cfd: [] };

  // The cumulative-flow diagram, unlike burndown, has no "ideal" line to
  // extrapolate against — a future day's status mix is simply unknown, so
  // it only ever covers days that have actually happened.
  const cfdLastDay = sprint.state === 'active' && today < end ? today : end;
  const cfdDayCount = buildDayRange(start, cfdLastDay).length;

  const totalSp = round2(sumSp(rows));
  const totalDays = Math.max(1, Math.round((startOfDay(end).getTime() - startOfDay(start).getTime()) / 86400000));

  const burndown = [];
  const cfd = [];
  fullDays.forEach((day, idx) => {
    const idealSp = Math.max(0, round2(totalSp - (totalSp * idx) / totalDays));
    const isFuture = idx >= cfdDayCount;

    if (isFuture) {
      burndown.push({ day: dayKey(day), dayIndex: idx + 1, actualSp: null, idealSp });
      return;
    }

    const boundaryMs = endOfDayMs(day);
    let remainingSp = 0;
    let doneCount = 0;
    let inProgressCount = 0;
    let todoCount = 0;

    for (const row of rows) {
      const events = eventsByIssueId.get(row.issue_id);
      const category = events ? categoryAsOf(events, boundaryMs) : null;
      // Not yet created as of this day (or no history at all) — simplified
      // to "not counted yet" rather than tracking the exact date an issue
      // was added to the sprint, which we don't have changelog data for.
      if (category == null) continue;
      if (category === 'done') doneCount += 1;
      else {
        remainingSp += Number(row.story_points) || 0;
        if (category === 'indeterminate') inProgressCount += 1;
        else todoCount += 1;
      }
    }

    burndown.push({ day: dayKey(day), dayIndex: idx + 1, actualSp: round2(remainingSp), idealSp });
    cfd.push({ day: dayKey(day), dayIndex: idx + 1, done: doneCount, inProgress: inProgressCount, todo: todoCount });
  });

  return { burndown, cfd };
}

function computeRisks(rows, blockedIssueIds) {
  const risks = [];
  for (const row of rows) {
    const daysInStatus = Math.max(0, Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 86400000));
    let problem = null;
    let action = null;

    // Priority when an issue matches more than one category, so it appears
    // once rather than as duplicate rows — matches the requested sort order
    // (blockers first).
    if (blockedIssueIds.has(row.issue_id)) {
      problem = 'блокер';
      action = 'эскалация';
    } else if (/ревью|review/i.test(row.status || '') && daysInStatus > REVIEW_STALE_DAYS) {
      problem = 'висит на ревью';
      action = 'найти ревьюера';
    } else if (!row.assignee && row.status_category === 'indeterminate') {
      problem = 'без исполнителя';
      action = 'назначить';
    }

    if (!problem) continue;
    risks.push({
      issueKey: row.issue_key,
      summary: row.summary,
      team: row.team,
      problem,
      days: daysInStatus,
      sp: row.story_points,
      action,
    });
  }

  risks.sort((a, b) => {
    if (a.problem === 'блокер' && b.problem !== 'блокер') return -1;
    if (b.problem === 'блокер' && a.problem !== 'блокер') return 1;
    return b.days - a.days;
  });

  return risks;
}

function sprintOutcome(sprint, agg) {
  if (sprint.state !== 'active') return 'closed';
  if (!sprint.start_date || !sprint.end_date) return 'on_track';

  const start = startOfDay(new Date(sprint.start_date));
  const end = startOfDay(new Date(sprint.end_date));
  const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
  const daysSoFar = Math.min(totalDays, Math.max(0, Math.round((startOfDay(new Date()).getTime() - start.getTime()) / 86400000)));
  const expectedPct = Math.min(100, (daysSoFar / totalDays) * 100);
  const actualPct = agg.doneSpPct ?? 0;
  return actualPct >= expectedPct ? 'on_track' : 'at_risk';
}

// GET /api/sprints/report?sprint=<id>&team=...&type=... — everything the
// Спринты screen needs in one call: KPIs/burndown/CFD/risks for the
// selected sprint, plus the independent "История спринтов" table (always
// the active sprint + up to MAX_HISTORY_SPRINTS-1 most recent closed ones,
// regardless of which sprint is selected).
router.get('/report', async (req, res) => {
  try {
    await ensureSchema();
    const pool = getPool();

    const teamFilter = toArray(req.query.team);
    const typeFilter = toArray(req.query.type);

    const { rows: allSprints } = await pool.query(
      `SELECT id, name, state, start_date, end_date, complete_date FROM sprints`
    );

    if (!allSprints.length) {
      return res.json({ sprint: null, kpis: null, burndown: [], cfd: [], risks: [], history: [] });
    }

    const activeSprint = allSprints.find((s) => s.state === 'active') || null;

    let selectedSprintId = parseInt(req.query.sprint, 10);
    if (!Number.isFinite(selectedSprintId) || !allSprints.some((s) => s.id === selectedSprintId)) {
      const fallback = resolveActiveOrLatestClosed(allSprints);
      selectedSprintId = fallback ? fallback.id : null;
    }
    const selectedSprint = allSprints.find((s) => s.id === selectedSprintId) || null;

    const closedDesc = allSprints
      .filter((s) => s.state === 'closed')
      .sort((a, b) => new Date(b.complete_date || b.end_date || 0).getTime() - new Date(a.complete_date || a.end_date || 0).getTime());
    const historySprints = [activeSprint, ...closedDesc].filter(Boolean).slice(0, MAX_HISTORY_SPRINTS);

    const relevantSprintIds = new Set(historySprints.map((s) => s.id));
    if (selectedSprint) relevantSprintIds.add(selectedSprint.id);

    const params = [];
    const conditions = ['i.is_deleted = false'];
    if (teamFilter.length) {
      params.push(teamFilter);
      conditions.push(`COALESCE(i.team, 'Без команды') = ANY($${params.length}::text[])`);
    }
    if (typeFilter.length) {
      params.push(typeFilter);
      conditions.push(`COALESCE(i.issue_type, 'Без типа') = ANY($${params.length}::text[])`);
    }
    params.push([...relevantSprintIds]);
    const sprintIdsParamIdx = params.length;

    const { rows: issueSprintRows } = await pool.query(
      `SELECT isp.issue_id, isp.sprint_id, isp.added_after_sprint_start,
              i.issue_key, i.summary, i.team, i.issue_type, i.status, i.status_category,
              i.story_points, i.assignee, i.updated_at, i.created_at, i.cycle_time, i.resolved_at
       FROM issue_sprints isp
       JOIN issues i ON i.id = isp.issue_id
       WHERE isp.sprint_id = ANY($${sprintIdsParamIdx}::int[]) AND ${conditions.join(' AND ')}`,
      params
    );

    const issueIds = [...new Set(issueSprintRows.map((r) => r.issue_id))];
    const { rows: eventRows } = issueIds.length
      ? await pool.query(
          `SELECT issue_id, changed_at, status_category FROM issue_status_events
           WHERE issue_id = ANY($1::int[]) ORDER BY issue_id, changed_at`,
          [issueIds]
        )
      : { rows: [] };

    const eventsByIssueId = new Map();
    for (const row of eventRows) {
      if (!eventsByIssueId.has(row.issue_id)) eventsByIssueId.set(row.issue_id, []);
      eventsByIssueId.get(row.issue_id).push({ atMs: new Date(row.changed_at).getTime(), category: row.status_category });
    }

    const { rows: linkRows } = await pool.query(
      `SELECT issue_id, linked_issue_status_category FROM issue_links WHERE link_type ILIKE '%blocked by%'`
    );
    const blockedIssueIds = new Set(
      linkRows.filter((l) => l.linked_issue_status_category && l.linked_issue_status_category !== 'done').map((l) => l.issue_id)
    );

    const bySprintId = new Map();
    for (const row of issueSprintRows) {
      if (!bySprintId.has(row.sprint_id)) bySprintId.set(row.sprint_id, []);
      bySprintId.get(row.sprint_id).push(row);
    }

    const selectedRows = selectedSprint ? bySprintId.get(selectedSprint.id) || [] : [];
    const agg = selectedSprint ? computeSprintAggregate(selectedRows) : null;

    // "Риски спринта" is scoped to the active sprint specifically (per its
    // own description) — showing it for a closed sprint the user happens to
    // have selected wouldn't mean anything (nothing left to escalate).
    const risks = selectedSprint && selectedSprint.state === 'active' ? computeRisks(selectedRows, blockedIssueIds) : [];

    const { burndown, cfd } = selectedSprint ? computeBurndownAndCfd(selectedSprint, selectedRows, eventsByIssueId) : { burndown: [], cfd: [] };

    let forecastPct = null;
    if (selectedSprint?.state === 'active' && selectedSprint.start_date && selectedSprint.end_date && agg?.takenSp > 0) {
      const start = startOfDay(new Date(selectedSprint.start_date));
      const end = startOfDay(new Date(selectedSprint.end_date));
      const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
      const daysSoFar = Math.max(1, Math.min(totalDays, Math.round((startOfDay(new Date()).getTime() - start.getTime()) / 86400000)));
      const ratePerDay = agg.doneSp / daysSoFar;
      const projected = ratePerDay * totalDays;
      forecastPct = Math.max(0, Math.min(100, round2((projected / agg.takenSp) * 100)));
    }

    // Positive = behind schedule (more remaining than the ideal line expects
    // by now), which is the only direction "отставание" describes. Uses the
    // last day with a real (non-null) actualSp — burndown now always spans
    // the full sprint, so its last entry can be a future day with no fact
    // point yet.
    const lastActualPoint = [...burndown].reverse().find((d) => d.actualSp != null);
    const lagSp =
      selectedSprint?.state === 'active' && lastActualPoint
        ? round2(lastActualPoint.actualSp - lastActualPoint.idealSp)
        : null;

    const daysRemaining =
      selectedSprint?.state === 'active' && selectedSprint.end_date
        ? Math.max(0, Math.ceil((new Date(selectedSprint.end_date).getTime() - Date.now()) / 86400000))
        : null;

    const history = historySprints
      .slice()
      .sort((a, b) => new Date(b.start_date || 0).getTime() - new Date(a.start_date || 0).getTime())
      .map((sprint) => {
        const rows = bySprintId.get(sprint.id) || [];
        const sAgg = computeSprintAggregate(rows);
        return {
          sprintId: sprint.id,
          name: sprint.name,
          state: sprint.state,
          startDate: sprint.start_date,
          endDate: sprint.end_date,
          takenSp: sAgg.takenSp,
          doneSp: sAgg.doneSp,
          completionPct: sAgg.doneSpPct,
          carriedOverCount: sAgg.carriedOverCount,
          scopeCreepPct: sAgg.scopeCreepPct,
          avgCycleTime: sAgg.avgCycleTime,
          outcome: sprintOutcome(sprint, sAgg),
        };
      });

    res.json({
      sprint: selectedSprint
        ? {
            id: selectedSprint.id,
            name: selectedSprint.name,
            state: selectedSprint.state,
            startDate: selectedSprint.start_date,
            endDate: selectedSprint.end_date,
            daysRemaining,
          }
        : null,
      kpis: agg
        ? {
            takenSp: agg.takenSp,
            takenCount: agg.takenCount,
            doneSp: agg.doneSp,
            doneSpPct: agg.doneSpPct,
            forecastPct,
            addedAfterStartSp: agg.addedAfterStartSp,
            scopeCreepPct: agg.scopeCreepPct,
            risksCount: risks.length,
            risksCategories: [...new Set(risks.map((r) => r.problem))],
            lagSp,
          }
        : null,
      burndown,
      cfd,
      risks,
      history,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
