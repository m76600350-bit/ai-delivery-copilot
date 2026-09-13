import React, { useEffect, useMemo, useState } from 'react';
import { getSprintsFilters, getSprintsReport } from '../api.js';
import WidgetMenu from './WidgetMenu.jsx';
import WidgetFilterPopover from './WidgetFilterPopover.jsx';
import MultiSelectFilter from './MultiSelectFilter.jsx';
import BurndownChart from './BurndownChart.jsx';

// Sprints aren't scoped by the dashboard's own Проект/Команда/Тип/Статус/
// Приоритет/Период filters (a sprint spans whichever issues are in it,
// regardless of what the rest of the dashboard is currently sliced to) — so
// this widget's only filters are its own sprint selector (3.1) plus a local
// Команда/Тип narrowing via the funnel, both passed straight through to the
// same GET /api/sprints/report the Спринты screen itself uses (3.2), so the
// two can never compute a sprint's burndown differently.
export default function SprintBurndownWidget({ onRemove, onExpand, fullScreen }) {
  const [filterOptions, setFilterOptions] = useState({ sprints: [], teams: [], types: [], defaultSprint: null });
  const [sprintId, setSprintId] = useState(null);
  const [localTeam, setLocalTeam] = useState([]);
  const [localType, setLocalType] = useState([]);
  const [report, setReport] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getSprintsFilters()
      .then((data) => {
        setFilterOptions(data);
        setSprintId((prev) => prev ?? data.defaultSprint);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!sprintId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getSprintsReport({ sprint: sprintId, team: localTeam.length ? localTeam : undefined, type: localType.length ? localType : undefined })
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Не удалось загрузить спринт');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sprintId, localTeam, localType]);

  const localFilterActive = localTeam.length > 0 || localType.length > 0;
  const sprint = report?.sprint;
  const lagSp = report?.kpis?.lagSp;

  const subtitle = useMemo(() => {
    if (!sprint) return null;
    if (sprint.state === 'active') return `осталось ${sprint.daysRemaining} ${sprint.daysRemaining === 1 ? 'день' : 'дней'}`;
    return 'завершён';
  }, [sprint]);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 relative">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-gray-700">Burndown спринта{sprint ? ` ${sprint.name || sprint.id}` : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <WidgetFilterPopover active={localFilterActive}>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Команда (только для этого виджета)</label>
              <MultiSelectFilter label="Все команды" options={filterOptions.teams} selected={localTeam} onChange={setLocalTeam} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Тип задачи (только для этого виджета)</label>
              <MultiSelectFilter label="Все типы" options={filterOptions.types} selected={localType} onChange={setLocalType} />
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

      <div className="mb-3">
        <select
          value={sprintId ?? ''}
          onChange={(e) => setSprintId(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-xs"
        >
          {filterOptions.sprints.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        {subtitle && <span className="text-xs text-gray-400 ml-2">график · {subtitle}</span>}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {isLoading ? (
        <p className="text-sm text-gray-400 py-8 text-center">Загрузка...</p>
      ) : !sprint ? (
        <p className="text-sm text-gray-400 py-8 text-center">Нет спринтов для отображения</p>
      ) : (
        <BurndownChart data={report.burndown} lagSp={lagSp} />
      )}
    </div>
  );
}
