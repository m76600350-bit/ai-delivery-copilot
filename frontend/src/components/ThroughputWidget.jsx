import React, { useEffect, useState } from 'react';
import { getDashboardThroughput } from '../api.js';
import WidgetMenu from './WidgetMenu.jsx';
import WidgetFilterPopover from './WidgetFilterPopover.jsx';
import MultiSelectFilter from './MultiSelectFilter.jsx';

// dashboardFilters supplies Проект/Команда/Тип/Статус/Приоритет — the
// widget's own 7-week window is intentionally independent of the shared
// Период filter (see backend/routes/dashboard.js's /throughput comment for
// why). localTeam/localType let this widget additionally narrow itself
// beyond the shared filters via its own funnel, same override pattern as
// TeamsSummaryWidget's local period.
export default function ThroughputWidget({ dashboardFilters, filterOptions, localTeam, localType, onLocalTeamChange, onLocalTypeChange, onRemove, onExpand, fullScreen }) {
  const [data, setData] = useState({ weeks: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getDashboardThroughput({
      project: dashboardFilters.project.length ? dashboardFilters.project : undefined,
      team: localTeam.length ? localTeam : dashboardFilters.team.length ? dashboardFilters.team : undefined,
      type: localType.length ? localType : dashboardFilters.type.length ? dashboardFilters.type : undefined,
      status: dashboardFilters.status.length ? dashboardFilters.status : undefined,
      priority: dashboardFilters.priority.length ? dashboardFilters.priority : undefined,
    })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Не удалось загрузить throughput');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dashboardFilters, localTeam, localType]);

  const weeks = data.weeks || [];
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const localFilterActive = localTeam.length > 0 || localType.length > 0;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 relative">
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-medium text-gray-700">Throughput по неделям</p>
        <div className="flex items-center gap-2">
          <WidgetFilterPopover active={localFilterActive}>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Команда (только для этого виджета)</label>
              <MultiSelectFilter label="Все команды" options={filterOptions.teams} selected={localTeam} onChange={onLocalTeamChange} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Тип задачи (только для этого виджета)</label>
              <MultiSelectFilter label="Все типы" options={filterOptions.types} selected={localType} onChange={onLocalTypeChange} />
            </div>
          </WidgetFilterPopover>
          {!fullScreen && (
            <button onClick={onExpand} title="Развернуть на весь экран" className="text-gray-400 hover:text-gray-700 text-sm leading-none">
              ⛶
            </button>
          )}
          {!fullScreen && <WidgetMenu onRemove={onRemove} />}
        </div>
      </div>
      <p className="text-xs text-gray-400 mb-3">график · закрытые задачи</p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {isLoading ? (
        <p className="text-sm text-gray-400 py-8 text-center">Загрузка...</p>
      ) : (
        <>
          <div className={`flex items-end gap-2 ${fullScreen ? 'h-64' : 'h-40'}`}>
            {weeks.map((w) => (
              <div key={w.label} className="flex-1 flex flex-col items-center gap-1 h-full justify-end min-w-[24px]">
                <div
                  className={`w-full rounded-t ${w.isCurrent ? 'bg-gray-300' : 'bg-blue-300'}`}
                  style={{ height: `${Math.max(2, (w.count / max) * 100)}%` }}
                  title={`${w.label}: ${w.count} задач`}
                />
                <span className="text-[10px] text-gray-500 whitespace-nowrap">{w.label}{w.isCurrent ? '*' : ''}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-2">* неделя не завершена</p>
        </>
      )}
    </div>
  );
}
