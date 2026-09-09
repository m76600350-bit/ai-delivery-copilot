import React, { useMemo, useState } from 'react';
import WidgetDrilldown from './WidgetDrilldown.jsx';
import MultiSelectFilter from './MultiSelectFilter.jsx';
import useSyncProgress from '../useSyncProgress.js';

function syncButtonLabel(isSyncing, progress) {
  if (!isSyncing) return 'Обновить данные из Jira';
  if (progress && progress.total > 0) {
    return `Синхронизация... получено ${progress.completed} из ${progress.total} задач`;
  }
  return 'Синхронизация...';
}

const PERIOD_OPTIONS = [
  { value: 'all', label: 'Всё время' },
  { value: '7', label: 'Последние 7 дней' },
  { value: '30', label: 'Последние 30 дней' },
  { value: '90', label: 'Последние 90 дней' },
];

const EMPTY_FILTERS = { project: [], team: [], type: [], status: [], priority: [], period: 'all' };

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

function StatCard({ title, value }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{title}</p>
      <p className="text-2xl font-semibold text-gray-800 mt-1">{value}</p>
    </div>
  );
}

function BreakdownCard({ title, data, onExpand }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 1;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 relative">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-gray-700">{title}</p>
        {onExpand && (
          <button
            onClick={onExpand}
            title="Развернуть на весь экран"
            className="text-gray-400 hover:text-gray-700 text-sm leading-none"
          >
            ⛶
          </button>
        )}
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

export default function Dashboard({ stats, jiraConnected, onSyncJira, onNavigateToTasks }) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [expandedWidget, setExpandedWidget] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const syncProgress = useSyncProgress(isSyncing);

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

  const filteredIssues = useMemo(() => {
    const cutoff = filters.period === 'all' ? null : Date.now() - Number(filters.period) * 86400000;
    return allIssues.filter((issue) => {
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
  }, [allIssues, filters]);

  const hasActiveFilters =
    filters.project.length || filters.team.length || filters.type.length ||
    filters.status.length || filters.priority.length || filters.period !== 'all';

  const filteredStats = useMemo(
    () => (hasActiveFilters ? computeStats(filteredIssues) : stats),
    [hasActiveFilters, filteredIssues, stats]
  );

  const updateFilter = (field, value) => setFilters((prev) => ({ ...prev, [field]: value }));

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

      <div className="flex flex-wrap items-center gap-3 bg-white rounded-lg border border-gray-200 p-3">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Фильтры</span>
        <MultiSelectFilter label="Проект" options={filterOptions.projects} selected={filters.project} onChange={(v) => updateFilter('project', v)} />
        <MultiSelectFilter label="Команда" options={filterOptions.teams} selected={filters.team} onChange={(v) => updateFilter('team', v)} />
        <MultiSelectFilter label="Тип задачи" options={filterOptions.types} selected={filters.type} onChange={(v) => updateFilter('type', v)} />
        <MultiSelectFilter label="Статус" options={filterOptions.statuses} selected={filters.status} onChange={(v) => updateFilter('status', v)} />
        <MultiSelectFilter label="Приоритет" options={filterOptions.priorities} selected={filters.priority} onChange={(v) => updateFilter('priority', v)} />
        <select
          value={filters.period}
          onChange={(e) => updateFilter('period', e.target.value)}
          className={`border rounded px-3 py-1.5 text-sm ${filters.period !== 'all' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-700'}`}
        >
          {PERIOD_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        {hasActiveFilters && (
          <button
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="text-xs text-blue-600 hover:underline"
          >
            Сбросить
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Всего задач" value={filteredStats.total} />
        <StatCard title="Статусов" value={Object.keys(filteredStats.byStatus || {}).length} />
        <StatCard title="Команд" value={Object.keys(filteredStats.byTeam || {}).length} />
        <StatCard title="Типов" value={Object.keys(filteredStats.byType || {}).length} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <BreakdownCard title="По статусу" data={filteredStats.byStatus} onExpand={() => setExpandedWidget('status')} />
        <BreakdownCard title="По команде" data={filteredStats.byTeam} onExpand={() => setExpandedWidget('team')} />
        <BreakdownCard title="По типу" data={filteredStats.byType} onExpand={() => setExpandedWidget('type')} />
      </div>
    </div>
  );
}
