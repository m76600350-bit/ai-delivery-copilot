import React from 'react';
import MultiSelectFilter from './MultiSelectFilter.jsx';

export const PERIOD_OPTIONS = [
  { value: 'all', label: 'Всё время' },
  { value: '7', label: 'Последние 7 дней' },
  { value: '30', label: 'Последние 30 дней' },
  { value: '90', label: 'Последние 90 дней' },
];

// Shared shape for the Проект/Команда/Тип задачи/Статус/Приоритет/Период
// filter set — used by both Dashboard and Tasks (via useSharedFilters), kept
// in one place so the two screens can't drift apart.
export const EMPTY_FILTERS = { project: [], team: [], type: [], status: [], priority: [], period: 'all' };

export function hasActiveFilters(filters) {
  return (
    filters.project.length > 0 ||
    filters.team.length > 0 ||
    filters.type.length > 0 ||
    filters.status.length > 0 ||
    filters.priority.length > 0 ||
    filters.period !== 'all'
  );
}

// Renders the Проект/Команда/Тип задачи/Статус/Приоритет/Период controls
// plus a "Сброс" button — identical on Dashboard and Tasks so filtering
// behaves the same way in both places. `options` supplies the choices for
// each dropdown (Dashboard derives them from already-loaded issues, Tasks
// fetches them from the backend), while `filters`/`onChange`/`onReset` are
// the shared, localStorage-persisted state from useSharedFilters.
export default function FilterBar({ options, filters, onChange, onReset }) {
  return (
    <div className="flex flex-wrap items-center gap-3 bg-white rounded-lg border border-gray-200 p-3">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Фильтры</span>
      <MultiSelectFilter label="Проект" options={options.projects} selected={filters.project} onChange={(v) => onChange('project', v)} />
      <MultiSelectFilter label="Команда" options={options.teams} selected={filters.team} onChange={(v) => onChange('team', v)} />
      <MultiSelectFilter label="Тип задачи" options={options.types} selected={filters.type} onChange={(v) => onChange('type', v)} />
      <MultiSelectFilter label="Статус" options={options.statuses} selected={filters.status} onChange={(v) => onChange('status', v)} />
      <MultiSelectFilter label="Приоритет" options={options.priorities} selected={filters.priority} onChange={(v) => onChange('priority', v)} />
      <select
        value={filters.period}
        onChange={(e) => onChange('period', e.target.value)}
        className={`border rounded px-3 py-1.5 text-sm ${filters.period !== 'all' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-700'}`}
      >
        {PERIOD_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {hasActiveFilters(filters) && (
        <button onClick={onReset} className="text-xs text-blue-600 hover:underline">
          Сброс
        </button>
      )}
    </div>
  );
}
