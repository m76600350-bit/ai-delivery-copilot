import React from 'react';
import MultiSelectFilter from './MultiSelectFilter.jsx';
import PeriodFilter from './PeriodFilter.jsx';

// Fixed enum, not derived from the DB — matches the "блокер"/"зависла"
// categories lib/problemIssues classifies on the backend.
export const PROBLEM_OPTIONS = ['Блокер', 'Зависла'];

// Shared shape for the Проект/Команда/Тип задачи/Статус/Приоритет/Период
// filter set — used by Дашборд/Задачи/Команды/Отчёты (via useSharedFilters),
// kept in one place so those screens can't drift apart. `problem` rides
// along in the same shared/persisted object (so it resets with the rest via
// "Сброс"), but only Задачи actually renders a control for it — see
// `showProblem` below.
//
// NOTE: the spec for this filter set also calls for an "Эпик" filter —
// deliberately NOT included here. The issues table has no epic name/id
// captured anywhere (checked routes/jira.js's sync — no epic link field is
// even fetched, let alone stored), so there's nothing to show the user
// besides a raw Jira key, and the spec explicitly says to ask rather than
// guess at that display. Flagged to the user; add `epic` here (plus its
// MultiSelectFilter row below) once that's resolved.
export const EMPTY_FILTERS = {
  project: [],
  team: [],
  type: [],
  status: [],
  priority: [],
  period: 'all',
  periodStart: null,
  periodEnd: null,
  problem: [],
};

export function hasActiveFilters(filters) {
  return (
    filters.project.length > 0 ||
    filters.team.length > 0 ||
    filters.type.length > 0 ||
    filters.status.length > 0 ||
    filters.priority.length > 0 ||
    filters.period !== 'all' ||
    (filters.problem?.length ?? 0) > 0
  );
}

// Renders the Проект/Команда/Тип задачи/Статус/Приоритет/Период controls
// plus a "Сброс" button — identical on Дашборд/Задачи/Команды/Отчёты so
// filtering behaves the same way everywhere. `options` supplies the choices
// for each dropdown, while `filters`/`onChange`/`onReset` are the shared,
// localStorage-persisted state from useSharedFilters. `showProblem`
// additionally renders the Задачи-only "Проблемы" filter.
export default function FilterBar({ options, filters, onChange, onReset, showProblem }) {
  return (
    <div className="flex flex-wrap items-center gap-3 bg-white rounded-lg border border-gray-200 p-3">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Фильтры</span>
      <MultiSelectFilter label="Проект" options={options.projects} selected={filters.project} onChange={(v) => onChange('project', v)} />
      <MultiSelectFilter label="Команда" options={options.teams} selected={filters.team} onChange={(v) => onChange('team', v)} />
      <MultiSelectFilter label="Тип задачи" options={options.types} selected={filters.type} onChange={(v) => onChange('type', v)} />
      <MultiSelectFilter label="Статус" options={options.statuses} selected={filters.status} onChange={(v) => onChange('status', v)} />
      <MultiSelectFilter label="Приоритет" options={options.priorities} selected={filters.priority} onChange={(v) => onChange('priority', v)} />
      {showProblem && (
        <MultiSelectFilter label="Проблемы" options={PROBLEM_OPTIONS} selected={filters.problem} onChange={(v) => onChange('problem', v)} />
      )}
      <PeriodFilter
        period={filters.period}
        periodStart={filters.periodStart}
        periodEnd={filters.periodEnd}
        onChange={({ period, periodStart, periodEnd }) => {
          onChange('period', period);
          onChange('periodStart', periodStart);
          onChange('periodEnd', periodEnd);
        }}
      />
      {hasActiveFilters(filters) && (
        <button onClick={onReset} className="text-xs text-blue-600 hover:underline">
          Сброс
        </button>
      )}
    </div>
  );
}
