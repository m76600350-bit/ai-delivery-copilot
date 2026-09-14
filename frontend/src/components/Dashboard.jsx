import React, { useEffect, useMemo, useState } from 'react';
import WidgetDrilldown from './WidgetDrilldown.jsx';
import FilterBar, { hasActiveFilters } from './FilterBar.jsx';
import SectionHeader from './SectionHeader.jsx';
import WidgetMenu from './WidgetMenu.jsx';
import WidgetFilterPopover from './WidgetFilterPopover.jsx';
import WidgetLibraryModal from './WidgetLibraryModal.jsx';
import AttentionWidget from './AttentionWidget.jsx';
import TeamsSummaryWidget from './TeamsSummaryWidget.jsx';
import ThroughputWidget from './ThroughputWidget.jsx';
import SprintBurndownWidget from './SprintBurndownWidget.jsx';
import { getDashboardWidgets, setDashboardWidgetEnabled } from '../api.js';
import { widgetHeightClass } from '../dashboardWidgetLayout.js';

const PERIOD_OPTIONS = [
  { value: 'inherit', label: 'Как на дашборде' },
  { value: 'all', label: 'Всё время' },
  { value: '7', label: 'Последние 7 дней' },
  { value: '30', label: 'Последние 30 дней' },
  { value: '90', label: 'Последние 90 дней' },
];

function issueTeams(issue) {
  const source = issue.team || issue.labels || '';
  const teams = String(source).split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  return teams.length ? teams : ['Без команды'];
}

// Recomputes every dashboard aggregate (totals, byStatus/byTeam/byType) from
// a filtered issue list, since the backend's own aggregates in `stats` cover
// the whole DB and can't reflect client-side filter selections.
function computeStats(issues) {
  const byStatus = {};
  const byTeam = {};
  const byType = {};
  for (const issue of issues) {
    const status = issue.status || 'Без статуса';
    const type = issue.type || 'Без типа';
    byStatus[status] = (byStatus[status] || 0) + 1;
    byType[type] = (byType[type] || 0) + 1;
    for (const team of issueTeams(issue)) {
      byTeam[team] = (byTeam[team] || 0) + 1;
    }
  }
  return { total: issues.length, byStatus, byTeam, byType };
}

// Resolves the shared Период filter (or a widget-local preset override, see
// below) to a [startMs, endMs] bound, supporting both the day-count presets
// and an arbitrary custom range — mirrors backend/lib/period.js so the
// client-side stats Dashboard computes from `allIssues` can't disagree with
// what the server would compute for the same filters.
function resolvePeriodBoundsMs(period, periodStart, periodEnd) {
  if (period === 'custom') {
    const start = periodStart ? new Date(`${periodStart}T00:00:00.000`).getTime() : null;
    const end = periodEnd ? new Date(`${periodEnd}T23:59:59.999`).getTime() : null;
    return { start, end };
  }
  const days = { '7': 7, '30': 30, '90': 90 }[period];
  if (!days) return { start: null, end: null };
  return { start: Date.now() - days * 86400000, end: null };
}

// Same shape as Dashboard's own filtering, but with an optional period
// OVERRIDE — a widget's local funnel filter (4.3) narrows just that widget
// without touching the shared dashboard filter state. The override is
// always a plain preset (never "custom" — the local funnel doesn't offer a
// date-range picker), so it never needs periodStart/periodEnd of its own.
function filterIssuesForPeriod(issues, filters, periodOverride) {
  const { start, end } =
    periodOverride && periodOverride !== 'inherit'
      ? resolvePeriodBoundsMs(periodOverride, null, null)
      : resolvePeriodBoundsMs(filters.period, filters.periodStart, filters.periodEnd);

  return issues.filter((issue) => {
    if (filters.project.length && !filters.project.includes(issue.project)) return false;
    if (filters.team.length && !issueTeams(issue).some((t) => filters.team.includes(t))) return false;
    if (filters.type.length && !filters.type.includes(issue.type || 'Без типа')) return false;
    if (filters.status.length && !filters.status.includes(issue.status || 'Без статуса')) return false;
    if (filters.priority.length && !filters.priority.includes(issue.priority || 'Без приоритета')) return false;
    const created = issue.createdAt ? new Date(issue.createdAt).getTime() : null;
    if (start != null && (!created || Number.isNaN(created) || created < start)) return false;
    if (end != null && (!created || Number.isNaN(created) || created > end)) return false;
    return true;
  });
}

function BreakdownCard({ title, data, onExpand, onRemove, localPeriod, onLocalPeriodChange, fullScreen }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 1;
  const localFilterActive = Boolean(localPeriod && localPeriod !== 'inherit');

  return (
    <div className={`bg-white rounded-lg shadow-sm border border-gray-200 p-5 relative flex flex-col ${widgetHeightClass(fullScreen)}`}>
      <div className="flex items-center justify-between mb-3 shrink-0">
        <p className="text-sm font-medium text-gray-700">{title}</p>
        <div className="flex items-center gap-2">
          <WidgetFilterPopover active={localFilterActive}>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Период (только для этого виджета)</label>
              <select
                value={localPeriod || 'inherit'}
                onChange={(e) => onLocalPeriodChange(e.target.value)}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              >
                {PERIOD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </WidgetFilterPopover>
          {!fullScreen && onExpand && (
            <button
              onClick={onExpand}
              title="Развернуть на весь экран"
              className="text-gray-400 hover:text-gray-700 text-sm leading-none"
            >
              ⛶
            </button>
          )}
          {!fullScreen && <WidgetMenu onRemove={onRemove} />}
        </div>
      </div>
      <div className="space-y-2 flex-1 min-h-0 overflow-y-auto">
        {entries.map(([key, count]) => (
          <div key={key}>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span className="truncate max-w-[70%]">{key}</span>
              <span>{count}</span>
            </div>
            <div className="w-full bg-gray-100 rounded h-2">
              <div
                className="bg-blue-500 h-2 rounded"
                style={{ width: `${(count / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
        {entries.length === 0 && (
          <p className="text-xs text-gray-400">Нет данных</p>
        )}
      </div>
    </div>
  );
}

const WIDGET_TITLES = {
  status: 'По статусу',
  team: 'По команде',
  type: 'По типу',
};

export default function Dashboard({ stats, jiraConnected, onSyncJira, onNavigateToTasks, filters, onFilterChange, onResetFilters, siteUrl, lastSyncedAt }) {
  const [expandedWidget, setExpandedWidget] = useState(null); // status/team/type dimension -> WidgetDrilldown
  const [expandedGeneric, setExpandedGeneric] = useState(null); // widgetType -> generic full-screen modal
  const [widgets, setWidgets] = useState([]);
  const [widgetsLoading, setWidgetsLoading] = useState(true);
  const [showLibrary, setShowLibrary] = useState(false);
  // Per-widget-instance LOCAL filter overrides (4.3's funnel icon) — keyed by
  // widgetType, kept in Dashboard rather than each widget since a couple of
  // widgets (by_status/by_team/by_type) share the exact same override shape
  // and computation.
  const [localPeriod, setLocalPeriod] = useState({});
  const [throughputLocalTeam, setThroughputLocalTeam] = useState([]);
  const [throughputLocalType, setThroughputLocalType] = useState([]);

  const loadWidgets = () => {
    getDashboardWidgets()
      .then((data) => setWidgets(data.widgets))
      .catch(() => {})
      .finally(() => setWidgetsLoading(false));
  };

  useEffect(() => {
    loadWidgets();
  }, []);

  const setWidgetEnabled = async (widgetType, enabled) => {
    // Optimistic — the library modal and the widget grid both read from the
    // same `widgets` state, so this has to update immediately for either to
    // feel responsive (removing a widget shouldn't wait on a round trip).
    setWidgets((prev) => prev.map((w) => (w.widgetType === widgetType ? { ...w, enabled } : w)));
    try {
      await setDashboardWidgetEnabled(widgetType, enabled);
    } catch {
      loadWidgets(); // roll back to the server's actual state on failure
    }
  };

  const allIssues = stats.issues || [];

  const filterOptions = useMemo(() => {
    const projects = new Set();
    const teams = new Set();
    const types = new Set();
    const statuses = new Set();
    const priorities = new Set();
    for (const issue of allIssues) {
      if (issue.project) projects.add(issue.project);
      for (const t of issueTeams(issue)) teams.add(t);
      types.add(issue.type || 'Без типа');
      statuses.add(issue.status || 'Без статуса');
      priorities.add(issue.priority || 'Без приоритета');
    }
    return {
      projects: [...projects].sort(),
      teams: [...teams].sort(),
      types: [...types].sort(),
      statuses: [...statuses].sort(),
      priorities: [...priorities].sort(),
    };
  }, [allIssues]);

  const filteredIssues = useMemo(() => filterIssuesForPeriod(allIssues, filters, null), [allIssues, filters]);

  const filtersActive = hasActiveFilters(filters);

  // by_status/by_team/by_type each optionally override just Период via their
  // own funnel filter (localPeriod[widgetType]) — falls back to the shared
  // dashboard aggregate when neither the shared filters nor this widget's
  // own override are active.
  const statsForBreakdown = (widgetType) => {
    const override = localPeriod[widgetType];
    if (!filtersActive && (!override || override === 'inherit')) return stats;
    return computeStats(filterIssuesForPeriod(allIssues, filters, override));
  };

  // Every hook above must run on every render regardless of this branch —
  // an early return before them would violate the Rules of Hooks and throw
  // "Rendered fewer hooks than expected" the moment a widget is expanded.
  if (expandedWidget) {
    return (
      <WidgetDrilldown
        dimension={expandedWidget}
        title={WIDGET_TITLES[expandedWidget]}
        issues={filteredIssues}
        onBack={() => setExpandedWidget(null)}
        onNavigateToTasks={(taskFilters) => {
          setExpandedWidget(null);
          onNavigateToTasks?.(taskFilters);
        }}
      />
    );
  }

  const enabledWidgets = widgets.filter((w) => w.enabled).sort((a, b) => a.position - b.position);

  const renderWidget = (widgetType, { fullScreen = false } = {}) => {
    switch (widgetType) {
      case 'by_status':
        return (
          <BreakdownCard
            key={widgetType}
            title="По статусу"
            data={statsForBreakdown(widgetType).byStatus}
            onExpand={fullScreen ? undefined : () => setExpandedWidget('status')}
            onRemove={() => setWidgetEnabled(widgetType, false)}
            localPeriod={localPeriod[widgetType]}
            onLocalPeriodChange={(v) => setLocalPeriod((prev) => ({ ...prev, [widgetType]: v }))}
            fullScreen={fullScreen}
          />
        );
      case 'by_team':
        return (
          <BreakdownCard
            key={widgetType}
            title="По команде"
            data={statsForBreakdown(widgetType).byTeam}
            onExpand={fullScreen ? undefined : () => setExpandedWidget('team')}
            onRemove={() => setWidgetEnabled(widgetType, false)}
            localPeriod={localPeriod[widgetType]}
            onLocalPeriodChange={(v) => setLocalPeriod((prev) => ({ ...prev, [widgetType]: v }))}
            fullScreen={fullScreen}
          />
        );
      case 'by_type':
        return (
          <BreakdownCard
            key={widgetType}
            title="По типу"
            data={statsForBreakdown(widgetType).byType}
            onExpand={fullScreen ? undefined : () => setExpandedWidget('type')}
            onRemove={() => setWidgetEnabled(widgetType, false)}
            localPeriod={localPeriod[widgetType]}
            onLocalPeriodChange={(v) => setLocalPeriod((prev) => ({ ...prev, [widgetType]: v }))}
            fullScreen={fullScreen}
          />
        );
      case 'attention':
        return (
          <AttentionWidget
            key={widgetType}
            dashboardFilters={filters}
            siteUrl={siteUrl}
            onNavigateToTasks={onNavigateToTasks}
            onRemove={() => setWidgetEnabled(widgetType, false)}
            localPeriod={localPeriod[widgetType]}
            onLocalPeriodChange={(v) => setLocalPeriod((prev) => ({ ...prev, [widgetType]: v }))}
            onExpand={fullScreen ? undefined : () => setExpandedGeneric(widgetType)}
            fullScreen={fullScreen}
          />
        );
      case 'teams_summary':
        return (
          <TeamsSummaryWidget
            key={widgetType}
            dashboardFilters={filters}
            onNavigateToTasks={onNavigateToTasks}
            onRemove={() => setWidgetEnabled(widgetType, false)}
            localPeriod={localPeriod[widgetType]}
            onLocalPeriodChange={(v) => setLocalPeriod((prev) => ({ ...prev, [widgetType]: v }))}
            onExpand={fullScreen ? undefined : () => setExpandedGeneric(widgetType)}
            fullScreen={fullScreen}
          />
        );
      case 'throughput_weekly':
        return (
          <ThroughputWidget
            key={widgetType}
            dashboardFilters={filters}
            filterOptions={filterOptions}
            localTeam={throughputLocalTeam}
            localType={throughputLocalType}
            onLocalTeamChange={setThroughputLocalTeam}
            onLocalTypeChange={setThroughputLocalType}
            onRemove={() => setWidgetEnabled(widgetType, false)}
            onExpand={fullScreen ? undefined : () => setExpandedGeneric(widgetType)}
            fullScreen={fullScreen}
          />
        );
      case 'sprint_burndown':
        return (
          <SprintBurndownWidget
            key={widgetType}
            onRemove={() => setWidgetEnabled(widgetType, false)}
            onExpand={fullScreen ? undefined : () => setExpandedGeneric(widgetType)}
            fullScreen={fullScreen}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <SectionHeader title="Дашборд" lastSyncedAt={lastSyncedAt} onSync={onSyncJira} />

      <FilterBar options={filterOptions} filters={filters} onChange={onFilterChange} onReset={onResetFilters} />

      {!widgetsLoading && enabledWidgets.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-8">
          На дашборде пока нет виджетов — добавьте их из библиотеки ниже.
        </p>
      )}

      {/* Every widget card uses the SAME fixed height (DASHBOARD_WIDGET_HEIGHT_CLASS
          in dashboardWidgetLayout.js) regardless of which row it's in — not
          grid row-stretch, which only equalizes heights WITHIN a row and
          leaves different rows at different heights. `items-start` keeps the
          grid from stretching cells to a shared row height on top of that.
          Content that doesn't fit scrolls internally (each widget's own
          overflow-y-auto body) rather than growing the card. */}
      {enabledWidgets.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          {enabledWidgets.map((w) => renderWidget(w.widgetType))}
        </div>
      )}

      <div className="flex justify-center pt-2">
        <button
          onClick={() => setShowLibrary(true)}
          className="text-sm border border-dashed border-gray-300 rounded-lg px-6 py-3 text-gray-500 hover:text-gray-700 hover:border-gray-400"
        >
          + Добавить виджет
        </button>
      </div>

      {showLibrary && (
        <WidgetLibraryModal
          widgets={widgets}
          onAdd={(type) => setWidgetEnabled(type, true)}
          onClose={() => setShowLibrary(false)}
        />
      )}

      {/* Generic full-screen view for widgets that don't fit WidgetDrilldown's
          issue-groupby shape (by_status/by_team/by_type keep using that one
          instead, via expandedWidget above) — a modal takeover re-rendering
          the same widget with fullScreen=true (no 10/4-row cap, no funnel/
          menu chrome of its own). */}
      {expandedGeneric && (
        <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/20 p-6 overflow-y-auto">
          <div className="bg-transparent w-full max-w-4xl mt-6">
            <div className="flex justify-end mb-2">
              <button
                onClick={() => setExpandedGeneric(null)}
                className="text-sm bg-white border border-gray-300 rounded px-3 py-1.5 hover:bg-gray-50"
              >
                Свернуть ×
              </button>
            </div>
            {renderWidget(expandedGeneric, { fullScreen: true })}
          </div>
        </div>
      )}
    </div>
  );
}
