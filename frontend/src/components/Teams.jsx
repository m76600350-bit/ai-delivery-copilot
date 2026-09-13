import React, { useEffect, useMemo, useState } from 'react';
import { getTeamsFilters, getTeamsReport } from '../api.js';
import MultiSelectFilter from './MultiSelectFilter.jsx';

const HEALTH_LABEL = { normal: 'норма', risk: 'риск', overload: 'перегруз', insufficient_data: 'недостаточно данных' };
const HEALTH_CLASS = {
  normal: 'bg-green-100 text-green-700',
  risk: 'bg-yellow-100 text-yellow-700',
  overload: 'bg-red-100 text-red-700',
  insufficient_data: 'bg-gray-100 text-gray-500',
};

const PEOPLE_STATUS_LABEL = { normal: 'норма', at_limit: 'на пределе', overload: 'перегруз' };
const PEOPLE_STATUS_CLASS = {
  normal: 'bg-green-100 text-green-700',
  at_limit: 'bg-yellow-100 text-yellow-700',
  overload: 'bg-red-100 text-red-700',
};

function fmtNum(value, digits = 1) {
  return value == null ? '—' : Number(value).toFixed(digits);
}

function fmtPct(value) {
  return value == null ? '—' : `${Math.round(value)}%`;
}

function WipCell({ wip }) {
  if (wip.limit == null) {
    return <span>{wip.count}</span>;
  }
  const ratio = wip.limit > 0 ? wip.count / wip.limit : 0;
  const barColor = ratio > 1 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-yellow-500' : 'bg-blue-500';
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="w-16 bg-gray-100 rounded h-1.5 shrink-0">
        <div className={`h-1.5 rounded ${barColor}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      <span className="whitespace-nowrap">{wip.count} / {wip.limit}</span>
    </div>
  );
}

function HealthBadge({ health }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${HEALTH_CLASS[health] || HEALTH_CLASS.insufficient_data}`}>
      {HEALTH_LABEL[health] || health}
    </span>
  );
}

function SprintChart({ data }) {
  if (!data.length) {
    return <p className="text-xs text-gray-400">Нет данных по спринтам этой команды</p>;
  }
  const max = Math.max(1, ...data.flatMap((d) => [d.takenSp, d.doneSp]));
  return (
    <div>
      <div className="flex items-end gap-4 h-28">
        {data.map((d) => (
          <div key={d.sprintId} className="flex flex-col items-center gap-1 flex-1 min-w-[40px]">
            <div className="flex items-end gap-1 h-20">
              <div
                className="w-3 bg-blue-200 rounded-t"
                style={{ height: `${(d.takenSp / max) * 100}%` }}
                title={`Взято: ${d.takenSp} SP`}
              />
              <div
                className="w-3 bg-blue-600 rounded-t"
                style={{ height: `${(d.doneSp / max) * 100}%` }}
                title={`Сделано: ${d.doneSp} SP`}
              />
            </div>
            <span className="text-[10px] text-gray-500 truncate max-w-[70px]" title={d.name}>
              {d.name}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-200" /> Взято, SP
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-600" /> Сделано, SP
        </span>
      </div>
    </div>
  );
}

function WorkTypeBreakdown({ data }) {
  if (!data.length) {
    return <p className="text-xs text-gray-400">Нет данных</p>;
  }
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.type}>
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{d.type}</span>
            <span>{fmtPct(d.pct)} ({d.count})</span>
          </div>
          <div className="w-full bg-gray-100 rounded h-2">
            <div className="bg-blue-500 h-2 rounded" style={{ width: `${d.pct}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PeopleLoadTable({ people }) {
  if (!people.length) {
    return <p className="text-xs text-gray-400">Сейчас нет задач в работе у этой команды</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-200">
            <th className="py-2 pr-4">Исполнитель</th>
            <th className="py-2 pr-4">В работе</th>
            <th className="py-2 pr-4">SP</th>
            <th className="py-2 pr-4">Макс. время задачи в одном статусе</th>
            <th className="py-2 pr-4">Статус</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.assignee || 'unassigned'} className="border-b border-gray-100">
              <td className="py-2 pr-4">{p.assignee || 'не назначен'}</td>
              <td className="py-2 pr-4">{p.inProgress}</td>
              <td className="py-2 pr-4">{p.sp ?? '—'}</td>
              <td className="py-2 pr-4">{p.maxDaysInStatus} д</td>
              <td className="py-2 pr-4">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${PEOPLE_STATUS_CLASS[p.status]}`}>
                  {PEOPLE_STATUS_LABEL[p.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeamDetailCard({ team }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-6">
      <h4 className="text-sm font-semibold text-gray-800">
        {team.team} <span className="text-xs font-normal text-gray-400">· карточка команды · {team.peopleCount} чел.</span>
      </h4>

      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">SP по спринтам</p>
        <SprintChart data={team.sprintChart} />
      </div>

      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Структура работы за период</p>
        <WorkTypeBreakdown data={team.workTypeBreakdown} />
      </div>
    </div>
  );
}

function PeopleLoadCard({ team }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <h4 className="text-sm font-medium text-gray-700 mb-1">Загрузка людей</h4>
      <p className="text-xs text-gray-400 mb-3">задачи в работе на исполнителя · {team.team}</p>
      <PeopleLoadTable people={team.peopleLoad} />
    </div>
  );
}

function SprintHealthTable({ teams }) {
  const rows = teams.filter((t) => t.sprintHealth);
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <h3 className="text-sm font-medium text-gray-700 mb-3">Здоровье последнего спринта</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-400">Нет данных о спринтах</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-4">Команда</th>
                <th className="py-2 pr-4">Спринт</th>
                <th className="py-2 pr-4">Взято, SP</th>
                <th className="py-2 pr-4">Сделано, SP</th>
                <th className="py-2 pr-4">Перенесено</th>
                <th className="py-2 pr-4">Scope creep %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.team} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium text-gray-700">{t.team}</td>
                  <td className="py-2 pr-4 text-gray-500">{t.sprintHealth.sprintName || '—'}</td>
                  <td className="py-2 pr-4">{t.sprintHealth.takenSp ?? '—'}</td>
                  <td className="py-2 pr-4">{t.sprintHealth.doneSp ?? '—'}</td>
                  <td className="py-2 pr-4">{t.sprintHealth.carriedOverCount}</td>
                  <td className="py-2 pr-4">{fmtPct(t.sprintHealth.scopeCreepPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// 2.6 — межкомандные "is blocked by" зависимости, уже сгруппированные и
// отсортированные по убыванию "Макс. ожидание" на бэкенде (computeTeamsReport).
function CrossTeamDependenciesTable({ dependencies, onNavigateToTasks }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <h3 className="text-sm font-medium text-gray-700 mb-1">Зависимости между командами</h3>
      <p className="text-xs text-gray-400 mb-3">активные межкомандные блокеры · клик по строке → задачи ожидающей команды</p>
      {dependencies.length === 0 ? (
        <p className="text-xs text-gray-400">Межкомандных зависимостей не обнаружено</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-4">Кто ждёт</th>
                <th className="py-2 pr-4">Кого ждёт</th>
                <th className="py-2 pr-4">Задач</th>
                <th className="py-2 pr-4">Макс. ожидание</th>
              </tr>
            </thead>
            <tbody>
              {dependencies.map((d) => (
                <tr
                  key={`${d.waitingTeam} :: ${d.blockingTeam}`}
                  onClick={() => onNavigateToTasks?.({ team: [d.waitingTeam], problem: ['Блокер'] })}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                >
                  <td className="py-2 pr-4 font-medium text-gray-700 whitespace-nowrap">{d.waitingTeam}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{d.blockingTeam}</td>
                  <td className="py-2 pr-4">{d.count}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{d.maxWaitDays} д</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Teams({ jiraConnected, onNavigateToTasks }) {
  const [filters, setFilters] = useState({ sprint: [], team: [], project: [] });
  const [filterOptions, setFilterOptions] = useState({ sprints: [], teams: [], projects: [] });
  const [report, setReport] = useState({ teams: [], crossTeamDependencies: [] });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedTeam, setExpandedTeam] = useState(null);

  useEffect(() => {
    if (!jiraConnected) return;
    getTeamsFilters()
      .then(setFilterOptions)
      .catch(() => {});
  }, [jiraConnected]);

  useEffect(() => {
    if (!jiraConnected) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getTeamsReport({
      sprint: filters.sprint.length ? filters.sprint : undefined,
      team: filters.team.length ? filters.team : undefined,
      project: filters.project.length ? filters.project : undefined,
    })
      .then((data) => {
        if (!cancelled) setReport(data);
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
  }, [jiraConnected, filters]);

  const updateFilter = (field, value) => setFilters((prev) => ({ ...prev, [field]: value }));
  const hasActiveFilters = filters.sprint.length || filters.team.length || filters.project.length;
  const expandedTeamData = useMemo(
    () => report.teams.find((t) => t.team === expandedTeam) || null,
    [report.teams, expandedTeam]
  );

  if (!jiraConnected) {
    return (
      <div className="max-w-2xl mx-auto mt-16 text-center">
        <p className="text-gray-500">
          Раздел «Команды» показывает данные из Jira. Подключите Jira в разделе «Настройки», чтобы увидеть его.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <h2 className="text-lg font-semibold text-gray-800">Команды</h2>

      <div className="flex flex-wrap items-center gap-3 bg-white rounded-lg border border-gray-200 p-3">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Фильтры</span>
        <MultiSelectFilter label="Спринт" options={filterOptions.sprints} selected={filters.sprint} onChange={(v) => updateFilter('sprint', v)} />
        <MultiSelectFilter label="Команда" options={filterOptions.teams} selected={filters.team} onChange={(v) => updateFilter('team', v)} />
        <MultiSelectFilter label="Проект" options={filterOptions.projects} selected={filters.project} onChange={(v) => updateFilter('project', v)} />
        {hasActiveFilters ? (
          <button onClick={() => setFilters({ sprint: [], team: [], project: [] })} className="text-xs text-blue-600 hover:underline">
            Сброс
          </button>
        ) : null}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {report.teams.length > 0 && report.teams.every((t) => t.wip.limit == null) && (
        <p className="text-xs text-gray-400 italic">
          WIP-лимиты не настроены ни для одной команды — колонка «Загрузка» показывает только текущее число задач, без дроби. Настроить можно в «Настройках» (роли участников + «Настройка WIP»).
        </p>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 px-4">Команда</th>
                <th className="py-2 px-4">Людей</th>
                <th className="py-2 px-4">Загрузка (WIP / лимит)</th>
                <th className="py-2 px-4">Velocity, SP</th>
                <th className="py-2 px-4">Cycle time</th>
                <th className="py-2 px-4">Баги %</th>
                <th className="py-2 px-4">Блокеры</th>
                <th className="py-2 px-4">Здоровье</th>
              </tr>
            </thead>
            <tbody>
              {report.teams.map((t) => (
                <tr
                  key={t.team}
                  onClick={() => setExpandedTeam((prev) => (prev === t.team ? null : t.team))}
                  className={`border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${expandedTeam === t.team ? 'bg-blue-50/50' : ''}`}
                >
                  <td className="py-2 px-4 font-medium text-gray-700">{t.team}</td>
                  <td className="py-2 px-4">{t.peopleCount}</td>
                  <td className="py-2 px-4">
                    <WipCell wip={t.wip} />
                  </td>
                  <td className="py-2 px-4">{t.velocitySp ?? '—'}</td>
                  <td className="py-2 px-4">{t.cycleTimeAvg != null ? `${fmtNum(t.cycleTimeAvg)} д` : '—'}</td>
                  <td className="py-2 px-4">{fmtPct(t.bugRatePct)}</td>
                  <td className="py-2 px-4">{t.blockersCount}</td>
                  <td className="py-2 px-4">
                    <HealthBadge health={t.health} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {!isLoading && report.teams.length === 0 && (
            <p className="text-center text-gray-400 text-sm py-8">Нет данных — синхронизируйте Jira или измените фильтры</p>
          )}
          {isLoading && <p className="text-center text-gray-400 text-sm py-8">Загрузка...</p>}
        </div>
        <p className="text-xs text-gray-400 px-4 py-2 border-t border-gray-100">клик по команде → карточка ниже</p>
      </div>

      {expandedTeamData && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TeamDetailCard team={expandedTeamData} />
          <PeopleLoadCard team={expandedTeamData} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CrossTeamDependenciesTable dependencies={report.crossTeamDependencies || []} onNavigateToTasks={onNavigateToTasks} />
        <SprintHealthTable teams={report.teams} />
      </div>
    </div>
  );
}
