import React, { useState } from 'react';
import StatusDeliveryReport from './StatusDeliveryReport.jsx';
import SprintSummaryReport from './SprintSummaryReport.jsx';
import QualityReport from './QualityReport.jsx';
import TeamsHealthReport from './TeamsHealthReport.jsx';

// Four fixed templates — no library of saved/custom reports (0.3), no
// history: each is recomputed from scratch the moment it's selected, and
// switching away and back just re-fetches. "Квартальный обзор" is the
// mockup's name for what the rest of the app calls "Здоровье команд" —
// same report, renamed only here to match the sidebar in the design.
const TEMPLATES = [
  { key: 'status', label: 'Статус доставки (weekly)' },
  { key: 'sprint', label: 'Итоги спринта' },
  { key: 'quality', label: 'Качество и баги' },
  { key: 'teams_health', label: 'Квартальный обзор' },
];

export default function Reports({ jiraConnected, filters, onFilterChange, onResetFilters }) {
  const [activeTemplate, setActiveTemplate] = useState('status');

  return (
    <div className="max-w-7xl mx-auto flex gap-6">
      <aside className="w-56 shrink-0 space-y-1">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide px-2 mb-2">Шаблоны</p>
        {TEMPLATES.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTemplate(t.key)}
            className={`w-full text-left text-sm px-3 py-2 rounded ${
              activeTemplate === t.key ? 'bg-gray-100 text-gray-900 font-medium' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </aside>

      <div className="flex-1 min-w-0">
        {activeTemplate === 'status' && (
          <StatusDeliveryReport jiraConnected={jiraConnected} filters={filters} onFilterChange={onFilterChange} onResetFilters={onResetFilters} />
        )}
        {activeTemplate === 'sprint' && <SprintSummaryReport jiraConnected={jiraConnected} filters={filters} />}
        {activeTemplate === 'quality' && (
          <QualityReport jiraConnected={jiraConnected} filters={filters} onFilterChange={onFilterChange} onResetFilters={onResetFilters} />
        )}
        {activeTemplate === 'teams_health' && <TeamsHealthReport jiraConnected={jiraConnected} filters={filters} />}
      </div>
    </div>
  );
}
