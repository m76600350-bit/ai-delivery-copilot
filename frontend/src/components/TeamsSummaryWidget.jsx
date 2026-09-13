import React, { useEffect, useState } from 'react';
import { getDashboardTeamsSummary } from '../api.js';
import WidgetMenu from './WidgetMenu.jsx';
import WidgetFilterPopover from './WidgetFilterPopover.jsx';

const PERIOD_OPTIONS = [
  { value: 'inherit', label: 'Как на дашборде' },
  { value: 'all', label: 'Всё время' },
  { value: '7', label: 'Последние 7 дней' },
  { value: '30', label: 'Последние 30 дней' },
  { value: '90', label: 'Последние 90 дней' },
];

const TREND_LABEL = { good: 'хорошо', risk: 'риск', overload: 'перегруз' };
const TREND_CLASS = {
  good: 'bg-green-100 text-green-700',
  risk: 'bg-yellow-100 text-yellow-700',
  overload: 'bg-red-100 text-red-700',
};

function TrendBadge({ trend }) {
  if (!trend) return <span className="text-gray-300">—</span>;
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${TREND_CLASS[trend]}`}>
      {trend === 'good' && '↑ '}
      {TREND_LABEL[trend]}
    </span>
  );
}

const PREVIEW_COUNT = 4;

// dashboardFilters is the shared Проект/Команда/Тип/Статус/Приоритет/Период
// state; localPeriod ('inherit' by default) lets this one widget override
// just Период via its own funnel filter without touching the shared state —
// same "своё локальное переопределение" pattern the mockup's "период 30 дн"
// chip shows. fullScreen (set only inside the expand modal) shows every
// team instead of the top 4.
export default function TeamsSummaryWidget({ dashboardFilters, localPeriod, onLocalPeriodChange, onNavigateToTasks, onRemove, onExpand, fullScreen }) {
  const [data, setData] = useState({ teams: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const effectivePeriod = localPeriod && localPeriod !== 'inherit' ? localPeriod : dashboardFilters.period;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getDashboardTeamsSummary({
      project: dashboardFilters.project.length ? dashboardFilters.project : undefined,
      team: dashboardFilters.team.length ? dashboardFilters.team : undefined,
      type: dashboardFilters.type.length ? dashboardFilters.type : undefined,
      status: dashboardFilters.status.length ? dashboardFilters.status : undefined,
      priority: dashboardFilters.priority.length ? dashboardFilters.priority : undefined,
      periodDays: effectivePeriod !== 'all' ? effectivePeriod : undefined,
    })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Не удалось загрузить данные по командам');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardFilters, effectivePeriod]);

  const teams = data.teams || [];
  const visibleTeams = fullScreen ? teams : teams.slice(0, PREVIEW_COUNT);
  const localFilterActive = Boolean(localPeriod && localPeriod !== 'inherit');

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 relative">
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-medium text-gray-700">Задачи по командам</p>
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
          {!fullScreen && (
            <button onClick={onExpand} title="Развернуть на весь экран" className="text-gray-400 hover:text-gray-700 text-sm leading-none">
              ⛶
            </button>
          )}
          {!fullScreen && <WidgetMenu onRemove={onRemove} />}
        </div>
      </div>
      <p className="text-xs text-gray-400 mb-3">таблица · {localFilterActive ? `свой фильтр: период ${PERIOD_OPTIONS.find((o) => o.value === localPeriod)?.label.toLowerCase()}` : 'период дашборда'}</p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {isLoading ? (
        <p className="text-sm text-gray-400 py-4">Загрузка...</p>
      ) : teams.length === 0 ? (
        <p className="text-sm text-gray-400 py-4">Нет данных — синхронизируйте Jira или измените фильтры</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-4">Команда</th>
                <th className="py-2 pr-4">Всего</th>
                <th className="py-2 pr-4">В работе</th>
                <th className="py-2 pr-4">Готово</th>
                <th className="py-2 pr-4">Cycle</th>
                <th className="py-2 pr-4">Тренд</th>
              </tr>
            </thead>
            <tbody>
              {visibleTeams.map((t) => (
                <tr
                  key={t.team}
                  onClick={() => onNavigateToTasks?.({ team: [t.team] })}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                >
                  <td className="py-2 pr-4 font-medium text-gray-700">{t.team}</td>
                  <td className="py-2 pr-4">{t.total}</td>
                  <td className="py-2 pr-4">{t.inProgress}</td>
                  <td className="py-2 pr-4">{t.done}</td>
                  <td className="py-2 pr-4">{t.cycleTimeAvg != null ? `${t.cycleTimeAvg.toFixed(1)} д` : '—'}</td>
                  <td className="py-2 pr-4"><TrendBadge trend={t.trend} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!fullScreen && !isLoading && teams.length > PREVIEW_COUNT && (
        <p className="text-xs text-gray-400 mt-3">
          {PREVIEW_COUNT} из {teams.length} команд ·{' '}
          <button onClick={onExpand} className="text-blue-600 hover:underline">
            Показать все →
          </button>
        </p>
      )}
    </div>
  );
}
