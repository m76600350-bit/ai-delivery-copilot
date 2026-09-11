import React, { useEffect, useState } from 'react';
import { getDashboardAttention } from '../api.js';
import TaskDetailPanel from './TaskDetailPanel.jsx';
import WidgetMenu from './WidgetMenu.jsx';

const PROBLEM_BADGE_CLASS = {
  'блокер': 'bg-red-100 text-red-700',
  'зависла': 'bg-yellow-100 text-yellow-700',
};

function formatMetric(item) {
  if (item.problem === 'блокер') return `${item.days} д`;
  return `${item.days} д (эталон ~${item.baselineDays} д, ×${(item.days / item.baselineDays).toFixed(1)})`;
}

// dashboardFilters mirrors the shape FilterBar/useSharedFilters produces —
// this widget respects the same Проект/Команда/Тип/Статус/Приоритет/Период
// selection as the rest of the Dashboard (4.1), refetching whenever it changes.
export default function AttentionWidget({ dashboardFilters, siteUrl: fallbackSiteUrl, onNavigateToTasks, onRemove }) {
  const [data, setData] = useState({ items: [], total: 0, siteUrl: null });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getDashboardAttention({
      project: dashboardFilters.project.length ? dashboardFilters.project : undefined,
      team: dashboardFilters.team.length ? dashboardFilters.team : undefined,
      type: dashboardFilters.type.length ? dashboardFilters.type : undefined,
      status: dashboardFilters.status.length ? dashboardFilters.status : undefined,
      priority: dashboardFilters.priority.length ? dashboardFilters.priority : undefined,
      periodDays: dashboardFilters.period !== 'all' ? dashboardFilters.period : undefined,
    })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Не удалось загрузить проблемные задачи');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dashboardFilters]);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 relative">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-gray-700">Требует внимания</p>
        <WidgetMenu onRemove={() => onRemove?.()} />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {isLoading ? (
        <p className="text-sm text-gray-400 py-4">Загрузка...</p>
      ) : data.items.length === 0 ? (
        <p className="text-sm text-gray-400 py-4">Проблемных задач не обнаружено</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-4">Задача</th>
                <th className="py-2 pr-4">Команда</th>
                <th className="py-2 pr-4">Исполнитель</th>
                <th className="py-2 pr-4">Причина</th>
                <th className="py-2 pr-4">Показатель</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => setSelectedTask(item)}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                >
                  <td className="py-2 pr-4">
                    <span className="font-medium text-gray-700">{item.issueKey}</span>{' '}
                    <span className="text-gray-500">{item.summary}</span>
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">{item.team}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{item.assignee || 'не назначен'}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${PROBLEM_BADGE_CLASS[item.problem]}`}>
                      {item.problem}
                    </span>
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap text-gray-500">{formatMetric(item)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && data.total > 10 && (
        <p className="text-xs text-gray-400 mt-3">
          {data.total} задач всего ·{' '}
          <button
            onClick={() => onNavigateToTasks?.({ problem: ['Блокер', 'Зависла'] })}
            className="text-blue-600 hover:underline"
          >
            Открыть в разделе «Задачи»
          </button>
        </p>
      )}

      <TaskDetailPanel task={selectedTask} siteUrl={data.siteUrl || fallbackSiteUrl} onClose={() => setSelectedTask(null)} />
    </div>
  );
}
