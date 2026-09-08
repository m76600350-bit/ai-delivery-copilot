import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getTasks, getTaskFilters, exportTasksCsv } from '../api.js';
import StatusBadge from './StatusBadge.jsx';
import TaskDetailPanel from './TaskDetailPanel.jsx';
import MultiSelectFilter from './MultiSelectFilter.jsx';

function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export default function Tasks({ jiraConnected }) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);

  const [statusFilter, setStatusFilter] = useState([]);
  const [teamFilter, setTeamFilter] = useState([]);
  const [typeFilter, setTypeFilter] = useState([]);
  const [priorityFilter, setPriorityFilter] = useState([]);

  const [filterOptions, setFilterOptions] = useState({ statuses: [], teams: [], types: [], priorities: [] });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ items: [], total: 0, pageSize: 20, siteUrl: null });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [isExporting, setIsExporting] = useState(false);

  const queryParams = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      status: statusFilter.length ? statusFilter : undefined,
      team: teamFilter.length ? teamFilter : undefined,
      type: typeFilter.length ? typeFilter : undefined,
      priority: priorityFilter.length ? priorityFilter : undefined,
    }),
    [debouncedSearch, statusFilter, teamFilter, typeFilter, priorityFilter]
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
  }, [jiraConnected, queryParams, page]);

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
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-800">Задачи</h2>
        <button
          onClick={handleExport}
          disabled={isExporting || result.total === 0}
          className="text-sm border border-gray-300 rounded px-4 py-2 hover:bg-gray-50 disabled:opacity-50"
        >
          {isExporting ? 'Экспорт...' : 'Экспорт'}
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Поиск по ключу и названию..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 min-w-[220px]"
        />
        <MultiSelectFilter label="Статус" options={filterOptions.statuses} selected={statusFilter} onChange={setStatusFilter} />
        <MultiSelectFilter label="Команда" options={filterOptions.teams} selected={teamFilter} onChange={setTeamFilter} />
        <MultiSelectFilter label="Тип" options={filterOptions.types} selected={typeFilter} onChange={setTypeFilter} />
        <MultiSelectFilter label="Приоритет" options={filterOptions.priorities} selected={priorityFilter} onChange={setPriorityFilter} />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 px-4">Ключ</th>
                <th className="py-2 px-4">Название</th>
                <th className="py-2 px-4">Тип</th>
                <th className="py-2 px-4">Команда</th>
                <th className="py-2 px-4">Исполнитель</th>
                <th className="py-2 px-4">Статус</th>
                <th className="py-2 px-4">Приоритет</th>
                <th className="py-2 px-4">Дней в статусе</th>
                <th className="py-2 px-4">Story Points</th>
                <th className="py-2 px-4">Спринт</th>
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
                  <td className="py-2 px-4 whitespace-nowrap">{task.issueType}</td>
                  <td className="py-2 px-4 whitespace-nowrap">{task.team}</td>
                  <td className="py-2 px-4 whitespace-nowrap">{task.assignee || 'не назначен'}</td>
                  <td className="py-2 px-4 whitespace-nowrap">
                    <StatusBadge status={task.status} statusCategory={task.statusCategory} />
                  </td>
                  <td className="py-2 px-4 whitespace-nowrap">{task.priority}</td>
                  <td className="py-2 px-4 whitespace-nowrap">{task.daysInStatus == null ? '—' : `${task.daysInStatus} д`}</td>
                  <td className="py-2 px-4 whitespace-nowrap">{task.storyPoints ?? '—'}</td>
                  <td className="py-2 px-4 whitespace-nowrap">{task.sprint || '—'}</td>
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
