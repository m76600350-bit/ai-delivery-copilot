import React, { useEffect, useMemo, useState } from 'react';
import WidgetDrilldown from './WidgetDrilldown.jsx';
import FilterBar, { hasActiveFilters } from './FilterBar.jsx';
import WidgetMenu from './WidgetMenu.jsx';
import WidgetFilterPopover from './WidgetFilterPopover.jsx';
import WidgetLibraryModal from './WidgetLibraryModal.jsx';
import AttentionWidget from './AttentionWidget.jsx';
import TeamsSummaryWidget from './TeamsSummaryWidget.jsx';
import ThroughputWidget from './ThroughputWidget.jsx';
import SprintBurndownWidget from './SprintBurndownWidget.jsx';
import { getDashboardWidgets, setDashboardWidgetEnabled } from '../api.js';
import useSyncProgress from '../useSyncProgress.js';

const PERIOD_OPTIONS = [
  { value: 'inherit', label: 'Как на дашборде' },
  { value: 'all', label: 'Всё время' },
  { value: '7', label: 'Последние 7 дней' },
  { value: '30', label: 'Последние 30 дней' },
  { value: '90', label: 'Последние 90 дней' },
];

function syncButtonLabel(isSyncing, progress) {
  if (!isSyncing) return 'Обновить данные из Jira';
  if (progress && progress.total > 0) {
    return `Синхронизация... получено ${progress.completed} из ${progress.total} задач`;
  }
  return 'Синхронизация...';
}

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

// Same shape as Dashboard's own filtering, but with an optional period
// OVERRIDE — a widget's local funnel filter (4.3) narrows just that widget
// without touching the shared dashboard filter state.
function filterIssuesForPeriod(issues, filters, periodOverride) {
  const period = periodOverride && periodOverride !== 'inherit' ? periodOverride : filters.period;
  const cutoff = period === 'all' ? null : Date.now() - Number(period) * 86400000;
  return issues.filter((issue) => {
    if (filters.project.length && !filters.project.includes(issue.project)) return false;
    if (filters.team.length && !issueTeams(issue).some((t) => filters.team.includes(t))) return false;
    if (filters.type.length && !filters.type.includes(issue.type || 'Без типа')) return false;
    if (filters.status.length && !filters.status.includes(issue.status || 'Без статуса')) return false;
    if (filters.priority.length && !filters.priority.includes(issue.priority || 'Без приоритета')) return false;
    if (cutoff != null) {
      const created = issue.createdAt ? new Date(issue.createdAt).getTime() : null;
      if (!created || Number.isNaN(created) || created < cutoff) return false;
    }
    return true;
  });
}

function StatCard({ title, value }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{title}</p>
      <p className="text-2xl font-semibold text-gray-800 mt-1">{value}</p>
    </div>
  );
}

// The four StatCards are one widget ("stats_cards") — its own menu sits
// above the 4-up grid rather than on each card individually. Per spec 4.1
// these stay full-width/one-row and are the one widget type exempt from the
// funnel/expand controls the rest of the library gets (4.3).
function StatsCardsWidget({ stats, onRemove }) {
  return (
    <div className="relative">
      <div className="absolute right-0 -top-8">
        <WidgetMenu onRemove={onRemove} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Всего задач" value={stats.total} />
        <StatCard title="Статусов" value={Object.keys(stats.byStatus || {}).length} />
        <StatCard title="Команд" value={Object.keys(stats.byTeam || {}).length} />
        <StatCard title="Типов" value={Object.keys(stats.byType || {}).length} />
      </div>
    </div>
  );
}

function BreakdownCard({ title, data, onExpand, onRemove, localPeriod, onLocalPeriodChange, fullScreen }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 1;
  const localFilterActive = Boolean(localPeriod && localPeriod !== 'inherit');

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 relative">
      <div className="flex items-center justify-between mb-3">
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
      <div className="space-y-2">
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

export default function Dashboard({ stats, jiraConnected, onSyncJira, onNavigateToTasks, filters, onFilterChange, onResetFilters, siteUrl }) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
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
  const syncProgress = useSyncProgress(isSyncing);

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

  const filteredStats = useMemo(
    () => (filtersActive ? computeStats(filteredIssues) : stats),
    [filtersActive, filteredIssues, stats]
  );

  // by_status/by_team/by_type each optionally override just Период via their
  // own funnel filter (localPeriod[widgetType]) — falls back to the shared
  // dashboard aggregate when neither the shared filters nor this widget's
  // own override are active, same as filteredStats above.
  const statsForBreakdown = (widgetType) => {
    const override = localPeriod[widgetType];
    if (!filtersActive && (!override || override === 'inherit')) return stats;
    return computeStats(filterIssuesForPeriod(allIssues, filters, override));
  };

  const handleSyncJira = async (force = false) => {
    setIsSyncing(true);
    setSyncError(null);
    try {
      await onSyncJira(force);
    } catch (err) {
      setSyncError(err.response?.data?.error || 'Не удалось синхронизировать данные из Jira');
    } finally {
      setIsSyncing(false);
    }
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
  const statsCardsWidget = enabledWidgets.find((w) => w.widgetType === 'stats_cards');
  const gridWidgets = enabledWidgets.filter((w) => w.widgetType !== 'stats_cards');

  const renderWidget = (widgetType, { fullScreen = false } = {}) => {
    switch (widgetType) {
      case 'stats_cards':
        return <StatsCardsWidget key={widgetType} stats={filteredStats} onRemove={() => setWidgetEnabled(widgetType, false)} />;
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Статистика</h2>
          {stats.lastSyncedAt && (
            <p className="text-xs text-gray-400 mt-0.5">
              Последняя синхронизация с Jira: {new Date(stats.lastSyncedAt).toLocaleString('ru-RU')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-4">
          {jiraConnected && (
            <>
              <button
                onClick={() => handleSyncJira(false)}
                disabled={isSyncing}
                className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {syncButtonLabel(isSyncing, syncProgress)}
              </button>
              <button
                onClick={() => handleSyncJira(true)}
                disabled={isSyncing}
                title="Пересчитывает время в статусах для всех задач заново, даже если они не менялись в Jira — используйте после обновления приложения, если цифры выглядят устаревшими"
                className="text-sm text-gray-500 hover:text-gray-700 hover:underline disabled:opacity-50"
              >
                Полная пересинхронизация
              </button>
            </>
          )}
        </div>
      </div>

      {syncError && (
        <p className="text-sm text-red-600 -mt-4">{syncError}</p>
      )}

      <FilterBar options={filterOptions} filters={filters} onChange={onFilterChange} onReset={onResetFilters} />

      {!widgetsLoading && enabledWidgets.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-8">
          На дашборде пока нет виджетов — добавьте их из библиотеки ниже.
        </p>
      )}

      {/* 4.1 — верхние карточки статистики остаются в одну строку, отдельно
          от остальных виджетов. 4.2 — всё остальное идёт в 2 колонки. */}
      {statsCardsWidget && renderWidget('stats_cards')}

      {gridWidgets.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          {gridWidgets.map((w) => renderWidget(w.widgetType))}
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
