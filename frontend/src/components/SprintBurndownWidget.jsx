import React, { useEffect, useMemo, useState } from 'react';
import { getSprintsFilters, getSprintsReport } from '../api.js';
import WidgetMenu from './WidgetMenu.jsx';
import WidgetFilterPopover from './WidgetFilterPopover.jsx';
import MultiSelectFilter from './MultiSelectFilter.jsx';
import BurndownChart from './BurndownChart.jsx';
import MultiSprintBurndownChart from './MultiSprintBurndownChart.jsx';
import { widgetHeightClass } from '../dashboardWidgetLayout.js';

// Cycled by selection order — distinct enough at a glance, and stays
// readable against the white card background. Only this Dashboard widget
// compares sprints; the Спринты screen's own burndown is untouched and
// still single-sprint only.
const SPRINT_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#d97706', '#0891b2', '#db2777', '#65a30d'];

// Sprints aren't scoped by the dashboard's own Проект/Команда/Тип/Статус/
// Приоритет/Период filters (a sprint spans whichever issues are in it,
// regardless of what the rest of the dashboard is currently sliced to) — so
// this widget's only filters are its own sprint selector (now a multi-
// select, for comparing sprints) plus a local Команда/Тип narrowing via the
// funnel, both passed straight through to the same GET /api/sprints/report
// the Спринты screen itself uses, so the two can never compute a sprint's
// burndown differently.
export default function SprintBurndownWidget({ onRemove, onExpand, fullScreen }) {
  const [filterOptions, setFilterOptions] = useState({ sprints: [], teams: [], types: [], defaultSprint: null });
  const [sprintIds, setSprintIds] = useState([]);
  const [localTeam, setLocalTeam] = useState([]);
  const [localType, setLocalType] = useState([]);
  const [reports, setReports] = useState([]); // one GET /api/sprints/report result per selected sprint, same order as sprintIds
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getSprintsFilters()
      .then((data) => {
        setFilterOptions(data);
        setSprintIds((prev) => (prev.length ? prev : data.defaultSprint ? [data.defaultSprint] : []));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!sprintIds.length) {
      setReports([]);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    Promise.all(
      sprintIds.map((id) =>
        getSprintsReport({ sprint: id, team: localTeam.length ? localTeam : undefined, type: localType.length ? localType : undefined })
      )
    )
      .then((results) => {
        if (!cancelled) setReports(results);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Не удалось загрузить спринт(ы)');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sprintIds, localTeam, localType]);

  const localFilterActive = localTeam.length > 0 || localType.length > 0;
  const isComparing = sprintIds.length > 1;

  // Single-sprint case — unchanged from before (4): same chart, same
  // "отставание N SP" subtitle, same everything.
  const singleReport = !isComparing ? reports[0] : null;
  const singleSprint = singleReport?.sprint;
  const singleLagSp = singleReport?.kpis?.lagSp;

  const subtitle = useMemo(() => {
    if (isComparing || !singleSprint) return null;
    if (singleSprint.state === 'active') return `осталось ${singleSprint.daysRemaining} ${singleSprint.daysRemaining === 1 ? 'день' : 'дней'}`;
    return 'завершён';
  }, [isComparing, singleSprint]);

  // Comparison case — each sprint's "факт" normalized to % of its own taken
  // SP remaining (see MultiSprintBurndownChart's own comment for why), keyed
  // by each sprint's own relative day index so differently-timed/-length
  // sprints still line up on the same x-axis.
  const compareSeries = useMemo(() => {
    if (!isComparing) return [];
    return reports
      .filter((r) => r.sprint)
      .map((r, idx) => {
        const takenSp = r.kpis?.takenSp;
        const points = (r.burndown || [])
          .filter((d) => d.actualSp != null)
          .map((d) => ({ dayIndex: d.dayIndex, pct: takenSp > 0 ? (d.actualSp / takenSp) * 100 : null }));
        return { sprintId: r.sprint.id, name: r.sprint.name || `Спринт ${r.sprint.id}`, color: SPRINT_COLORS[idx % SPRINT_COLORS.length], points };
      });
  }, [isComparing, reports]);

  const anySprintFound = reports.some((r) => r.sprint);

  return (
    <div className={`bg-white rounded-lg shadow-sm border border-gray-200 p-5 relative flex flex-col ${widgetHeightClass(fullScreen)}`}>
      <div className="flex items-center justify-between mb-1 shrink-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-gray-700">
            Burndown спринта{!isComparing && singleSprint ? ` ${singleSprint.name || singleSprint.id}` : isComparing ? ' — сравнение' : ''}
          </p>
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

      <div className="mb-3 shrink-0 flex items-center gap-2">
        <MultiSelectFilter label="Спринт" options={filterOptions.sprints} selected={sprintIds} onChange={setSprintIds} />
        {subtitle && <span className="text-xs text-gray-400">график · {subtitle}</span>}
        {isComparing && <span className="text-xs text-gray-400">график · сравнение {sprintIds.length} спринтов</span>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && <p className="text-sm text-red-600">{error}</p>}

        {isLoading ? (
          <p className="text-sm text-gray-400 py-8 text-center">Загрузка...</p>
        ) : !sprintIds.length || !anySprintFound ? (
          <p className="text-sm text-gray-400 py-8 text-center">Нет спринтов для отображения</p>
        ) : isComparing ? (
          <MultiSprintBurndownChart series={compareSeries} />
        ) : (
          <BurndownChart data={singleReport.burndown} lagSp={singleLagSp} />
        )}
      </div>
    </div>
  );
}
