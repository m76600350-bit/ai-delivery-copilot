import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getTasks, getTaskFilters, exportTasksCsv } from '../api.js';
import StatusBadge from './StatusBadge.jsx';
import TaskDetailPanel from './TaskDetailPanel.jsx';
import FilterBar from './FilterBar.jsx';
import SectionHeader from './SectionHeader.jsx';
import ColumnsMenu from './ColumnsMenu.jsx';

function formatDays(value) {
  return value == null ? '—' : `${value} дн`;
}

// Ключ/Название are always on (rendered separately below, not in this
// list) — everything else is toggleable via the "Колонки" menu (1.2/1.3).
const OPTIONAL_COLUMNS = [
  { key: 'type', label: 'Тип' },
  { key: 'team', label: 'Команда' },
  { key: 'assignee', label: 'Исполнитель' },
  { key: 'status', label: 'Статус' },
  { key: 'priority', label: 'Приоритет' },
  { key: 'daysInStatus', label: 'Дней в статусе' },
  { key: 'cycleTime', label: 'Cycle time' },
  { key: 'leadTime', label: 'LT' },
  { key: 'storyPoints', label: 'Story Points' },
  { key: 'sprint', label: 'Спринт' },
];
const ALWAYS_ON_COLUMNS = [
  { key: 'issueKey', label: 'Ключ', alwaysOn: true },
  { key: 'summary', label: 'Название', alwaysOn: true },
];
const ALL_OPTIONAL_KEYS = OPTIONAL_COLUMNS.map((c) => c.key);
const COLUMNS_STORAGE_KEY = 'delivery-board:tasks-columns';

// Defaults to every column visible (1.5) — a missing/corrupt localStorage
// value falls back to the same, rather than an empty table.
function loadVisibleColumns() {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) return ALL_OPTIONAL_KEYS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ALL_OPTIONAL_KEYS;
    return parsed.filter((k) => ALL_OPTIONAL_KEYS.includes(k));
  } catch {
    return ALL_OPTIONAL_KEYS;
  }
}

function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

// Search stays local to this screen (not part of the shared filter set) —
// it's a per-visit lookup, not a filter the user expects to carry over to
// the Dashboard.
export default function Tasks({ jiraConnected, filters, onFilterChange, onResetFilters, onSyncJira, lastSyncedAt }) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);

  const [filterOptions, setFilterOptions] = useState({ statuses: [], teams: [], types: [], priorities: [], projects: [] });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ items: [], total: 0, pageSize: 20, siteUrl: null });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState(loadVisibleColumns);

  const handleColumnsChange = (next) => {
    setVisibleColumns(next);
    try {
      localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Non-fatal — the choice just won't survive a reload this time.
    }
  };

  const queryParams = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      status: filters.status.length ? filters.status : undefined,
      team: filters.team.length ? filters.team : undefined,
      type: filters.type.length ? filters.type : undefined,
      priority: filters.priority.length ? filters.priority : undefined,
      project: filters.project.length ? filters.project : undefined,
      periodDays: filters.period !== 'all' ? filters.period : undefined,
      problem: filters.problem?.length ? filters.problem : undefined,
    }),
    [debouncedSearch, filters]
  );

  // Any filter/search change invalidates the current page.
  useEffect(() => {
    setPage(1);
  }, [queryParams]);

  useEffect(() => {
    if (!jiraConnected) return;
    getTaskFilters()
      .then(setFilterOptions)
      .catch(() => {});
  }, [jiraConnected]);

  useEffect(() => {
    if (!jiraConnected) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getTasks({ ...queryParams, page })
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Не удалось загрузить задачи');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // lastSyncedAt: refetch after a sync completes, so this list doesn't
    // keep showing pre-sync statuses/fields until an unrelated filter or
    // page change happens to trigger a refetch.
  }, [jiraConnected, queryParams, page, lastSyncedAt]);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const blob = await exportTasksCsv(queryParams);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tasks.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось экспортировать CSV');
    } finally {
      setIsExporting(false);
    }
  }, [queryParams]);

  if (!jiraConnected) {
    return (
      <div className="max-w-2xl mx-auto mt-16 text-center">
        <p className="text-gray-500">
          Раздел «Задачи» показывает данные из Jira. Подключите Jira в разделе «Настройки», чтобы увидеть список.
        </p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(result.total / (result.pageSize || 20)));

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <SectionHeader title="Задачи" lastSyncedAt={lastSyncedAt} onSync={onSyncJira} />

      <div className="flex items-center justify-end gap-3">
        <ColumnsMenu columns={[...ALWAYS_ON_COLUMNS, ...OPTIONAL_COLUMNS]} visible={visibleColumns} onChange={handleColumnsChange} />
        <button
          onClick={handleExport}
          disabled={isExporting || result.total === 0}
          className="text-sm border border-gray-300 rounded px-4 py-2 hover:bg-gray-50 disabled:opacity-50"
        >
          {isExporting ? 'Экспорт...' : 'Экспорт'}
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <input
          type="text"
          placeholder="Поиск по ключу и названию..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
        />
      </div>

      <FilterBar options={filterOptions} filters={filters} onChange={onFilterChange} onReset={onResetFilters} showProblem />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 px-4">Ключ</th>
                <th className="py-2 px-4">Название</th>
                {visibleColumns.includes('type') && <th className="py-2 px-4">Тип</th>}
                {visibleColumns.includes('team') && <th className="py-2 px-4">Команда</th>}
                {visibleColumns.includes('assignee') && <th className="py-2 px-4">Исполнитель</th>}
                {visibleColumns.includes('status') && <th className="py-2 px-4">Статус</th>}
                {visibleColumns.includes('priority') && <th className="py-2 px-4">Приоритет</th>}
                {visibleColumns.includes('daysInStatus') && <th className="py-2 px-4">Дней в статусе</th>}
                {visibleColumns.includes('cycleTime') && <th className="py-2 px-4">Cycle time</th>}
                {visibleColumns.includes('leadTime') && <th className="py-2 px-4">LT</th>}
                {visibleColumns.includes('storyPoints') && <th className="py-2 px-4">Story Points</th>}
                {visibleColumns.includes('sprint') && <th className="py-2 px-4">Спринт</th>}
              </tr>
            </thead>
            <tbody>
              {result.items.map((task) => (
                <tr
                  key={task.id}
                  onClick={() => setSelectedTask(task)}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                >
                  <td className="py-2 px-4 whitespace-nowrap font-medium text-gray-700">{task.issueKey}</td>
                  <td className="py-2 px-4 max-w-xs truncate">{task.summary}</td>
                  {visibleColumns.includes('type') && <td className="py-2 px-4 whitespace-nowrap">{task.issueType}</td>}
                  {visibleColumns.includes('team') && <td className="py-2 px-4 whitespace-nowrap">{task.team}</td>}
                  {visibleColumns.includes('assignee') && (
                    <td className="py-2 px-4 whitespace-nowrap">{task.assignee || 'не назначен'}</td>
                  )}
                  {visibleColumns.includes('status') && (
                    <td className="py-2 px-4 whitespace-nowrap">
                      <StatusBadge status={task.status} statusCategory={task.statusCategory} />
                    </td>
                  )}
                  {visibleColumns.includes('priority') && <td className="py-2 px-4 whitespace-nowrap">{task.priority}</td>}
                  {visibleColumns.includes('daysInStatus') && (
                    <td className="py-2 px-4 whitespace-nowrap">{task.daysInStatus == null ? '—' : `${task.daysInStatus} д`}</td>
                  )}
                  {visibleColumns.includes('cycleTime') && <td className="py-2 px-4 whitespace-nowrap">{formatDays(task.cycleTime)}</td>}
                  {visibleColumns.includes('leadTime') && <td className="py-2 px-4 whitespace-nowrap">{formatDays(task.leadTimeDays)}</td>}
                  {visibleColumns.includes('storyPoints') && <td className="py-2 px-4 whitespace-nowrap">{task.storyPoints ?? '—'}</td>}
                  {visibleColumns.includes('sprint') && <td className="py-2 px-4 whitespace-nowrap">{task.sprint || '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>

          {!isLoading && result.items.length === 0 && (
            <p className="text-center text-gray-400 text-sm py-8">Ничего не найдено</p>
          )}
          {isLoading && (
            <p className="text-center text-gray-400 text-sm py-8">Загрузка...</p>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-sm text-gray-500">
          <span>
            {result.total === 0 ? '0 задач' : `${(page - 1) * result.pageSize + 1}–${Math.min(page * result.pageSize, result.total)} из ${result.total}`}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-2 py-1 border border-gray-300 rounded disabled:opacity-40"
            >
              ←
            </button>
            <span>
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-2 py-1 border border-gray-300 rounded disabled:opacity-40"
            >
              →
            </button>
          </div>
        </div>
      </div>

      <TaskDetailPanel task={selectedTask} siteUrl={result.siteUrl} onClose={() => setSelectedTask(null)} />
    </div>
  );
}
