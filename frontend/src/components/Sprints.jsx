import React, { useEffect, useMemo, useState } from 'react';
import { getSprintsFilters, getSprintsReport } from '../api.js';
import MultiSelectFilter from './MultiSelectFilter.jsx';

function fmtShortDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function fmtPct(value) {
  return value == null ? '—' : `${Math.round(value)}%`;
}

function fmtSp(value) {
  return value == null ? '—' : value;
}

const RISK_LABEL = { 'блокер': 'блокеры', 'висит на ревью': 'ревью', 'без исполнителя': 'без owner' };
const RISK_BADGE_CLASS = {
  'блокер': 'bg-red-100 text-red-700',
  'висит на ревью': 'bg-yellow-100 text-yellow-700',
  'без исполнителя': 'bg-gray-100 text-gray-600',
};
const OUTCOME_LABEL = { closed: 'закрыт', on_track: 'на треке', at_risk: 'в риске' };
const OUTCOME_CLASS = {
  closed: 'bg-gray-100 text-gray-600',
  on_track: 'bg-green-100 text-green-700',
  at_risk: 'bg-yellow-100 text-yellow-700',
};

function KpiCard({ title, value, subtitle, progressPct }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{title}</p>
      <p className="text-2xl font-semibold text-gray-800 mt-1">{value}</p>
      {progressPct != null && (
        <div className="w-full bg-gray-100 rounded h-1.5 mt-2">
          <div className="bg-blue-500 h-1.5 rounded" style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }} />
        </div>
      )}
      {subtitle && <p className="text-xs text-gray-400 mt-1">{subtitle}</p>}
    </div>
  );
}

function BurndownChart({ data, lagSp }) {
  if (!data.length) {
    return <p className="text-xs text-gray-400 py-8 text-center">Нет данных по спринту</p>;
  }
  const width = 560;
  const height = 200;
  const padding = 32;
  const maxY = Math.max(1, ...data.map((d) => Math.max(d.idealSp, d.actualSp)));
  const n = data.length;
  const x = (i) => padding + (n > 1 ? (i / (n - 1)) * (width - padding * 2) : 0);
  const y = (v) => height - padding - (v / maxY) * (height - padding * 2);
  const actualPoints = data.map((d, i) => `${x(i)},${y(d.actualSp)}`).join(' ');
  const idealPoints = data.map((d, i) => `${x(i)},${y(d.idealSp)}`).join(' ');

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#e5e7eb" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#e5e7eb" />
        <text x={padding - 6} y={padding + 4} textAnchor="end" fontSize="10" className="fill-gray-400">{Math.round(maxY)}</text>
        <text x={padding - 6} y={height - padding} textAnchor="end" fontSize="10" className="fill-gray-400">0</text>
        <text x={padding} y={height - padding + 16} fontSize="10" className="fill-gray-400">д{data[0].dayIndex}</text>
        <text x={width - padding} y={height - padding + 16} textAnchor="end" fontSize="10" className="fill-gray-400">д{data[n - 1].dayIndex}</text>
        <polyline points={idealPoints} fill="none" stroke="#9ca3af" strokeDasharray="4 3" strokeWidth="1.5" />
        <polyline points={actualPoints} fill="none" stroke="#2563eb" strokeWidth="2" />
      </svg>
      <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-blue-600" /> факт</span>
        <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-gray-400" style={{ borderTop: '1px dashed' }} /> идеал</span>
        {lagSp != null && lagSp > 0 && <span className="text-red-600 font-medium">отставание {lagSp} SP</span>}
      </div>
    </div>
  );
}

function CfdChart({ data }) {
  if (!data.length) {
    return <p className="text-xs text-gray-400 py-8 text-center">Нет данных по спринту</p>;
  }
  const max = Math.max(1, ...data.map((d) => d.done + d.inProgress + d.todo));
  return (
    <div>
      <div className="flex items-end gap-1 h-40">
        {data.map((d) => {
          const total = d.done + d.inProgress + d.todo;
          return (
            <div
              key={d.day}
              className="flex-1 flex flex-col justify-end h-full min-w-[4px]"
              title={`${d.day}: Done ${d.done}, В работе ${d.inProgress}, To Do ${d.todo}`}
            >
              <div className="w-full bg-gray-200" style={{ height: `${(d.todo / max) * 100}%` }} />
              <div className="w-full bg-blue-300" style={{ height: `${(d.inProgress / max) * 100}%` }} />
              <div className="w-full bg-blue-600 rounded-b-sm" style={{ height: total ? `${(d.done / max) * 100}%` : 0 }} />
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-600" /> Done</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-300" /> В работе</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-gray-200" /> To Do</span>
      </div>
    </div>
  );
}

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function exportHistoryCsv(history) {
  const header = ['Спринт', 'Период', 'Взято SP', 'Сделано SP', 'Выполнение %', 'Перенесено', 'Scope creep %', 'Ср. cycle time', 'Итог'];
  const rows = history.map((h) => [
    h.name || h.sprintId,
    `${fmtShortDate(h.startDate)} — ${fmtShortDate(h.endDate)}`,
    h.takenSp,
    h.doneSp,
    h.completionPct == null ? '' : Math.round(h.completionPct),
    h.carriedOverCount,
    h.scopeCreepPct == null ? '' : Math.round(h.scopeCreepPct),
    h.avgCycleTime == null ? '' : h.avgCycleTime.toFixed(2),
    OUTCOME_LABEL[h.outcome] || h.outcome,
  ]);
  // BOM so Excel opens the UTF-8 file (Cyrillic) without mangling it.
  const csv = '﻿' + [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sprints.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Sprints({ jiraConnected }) {
  const [filters, setFilters] = useState({ sprint: '', team: [], type: [] });
  const [filterOptions, setFilterOptions] = useState({ sprints: [], teams: [], types: [], defaultSprint: null });
  const [report, setReport] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!jiraConnected) return;
    getSprintsFilters()
      .then((data) => {
        setFilterOptions(data);
        setFilters((prev) => (prev.sprint ? prev : { ...prev, sprint: data.defaultSprint || '' }));
      })
      .catch(() => {});
  }, [jiraConnected]);

  useEffect(() => {
    if (!jiraConnected || !filters.sprint) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getSprintsReport({
      sprint: filters.sprint,
      team: filters.team.length ? filters.team : undefined,
      type: filters.type.length ? filters.type : undefined,
    })
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Не удалось загрузить данные по спринту');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [jiraConnected, filters]);

  const updateFilter = (field, value) => setFilters((prev) => ({ ...prev, [field]: value }));

  const risksSubtitle = useMemo(() => {
    if (!report?.kpis?.risksCategories?.length) return 'нет проблемных задач';
    return report.kpis.risksCategories.map((c) => RISK_LABEL[c] || c).join(' + ');
  }, [report]);

  if (!jiraConnected) {
    return (
      <div className="max-w-2xl mx-auto mt-16 text-center">
        <p className="text-gray-500">
          Раздел «Спринты» показывает данные из Jira. Подключите Jira в разделе «Настройки», чтобы увидеть его.
        </p>
      </div>
    );
  }

  if (!isLoading && filterOptions.sprints.length === 0) {
    return (
      <div className="max-w-2xl mx-auto mt-16 text-center">
        <p className="text-gray-500">
          Спринты пока не синхронизированы — выполните синхронизацию с Jira (доски со спринтами появятся после неё).
        </p>
      </div>
    );
  }

  const sprint = report?.sprint;
  const kpis = report?.kpis;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={filters.sprint}
            onChange={(e) => updateFilter('sprint', e.target.value)}
            className="border border-blue-300 bg-blue-50 text-blue-700 rounded px-3 py-1.5 text-sm font-medium"
          >
            {filterOptions.sprints.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <MultiSelectFilter label="Команда" options={filterOptions.teams} selected={filters.team} onChange={(v) => updateFilter('team', v)} />
          <MultiSelectFilter label="Тип задачи" options={filterOptions.types} selected={filters.type} onChange={(v) => updateFilter('type', v)} />
        </div>
        {sprint && (
          <p className="text-sm text-gray-500">
            {fmtShortDate(sprint.startDate)} — {fmtShortDate(sprint.endDate)}
            {sprint.state === 'active' && sprint.daysRemaining != null && ` · осталось ${sprint.daysRemaining} дн`}
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {isLoading && <p className="text-sm text-gray-400">Загрузка...</p>}

      {kpis && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <KpiCard title="Взято в спринт" value={`${fmtSp(kpis.takenSp)} SP`} subtitle={`${kpis.takenCount} задачи`} />
          <KpiCard title="Сделано" value={`${fmtSp(kpis.doneSp)} SP`} subtitle={fmtPct(kpis.doneSpPct)} progressPct={kpis.doneSpPct} />
          {sprint?.state === 'active' ? (
            <KpiCard title="Прогноз завершения" value={fmtPct(kpis.forecastPct)} subtitle="по текущему темпу" />
          ) : (
            <KpiCard title="Итог" value={fmtPct(kpis.doneSpPct)} subtitle="выполнено" />
          )}
          <KpiCard title="Добавлено после старта" value={`+${fmtSp(kpis.addedAfterStartSp)} SP`} subtitle={`scope creep ${fmtPct(kpis.scopeCreepPct)}`} />
          <KpiCard title="Риски" value={kpis.risksCount} subtitle={risksSubtitle} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-700">Burndown спринта{sprint?.name ? ` ${sprint.name}` : ''}</h3>
          <p className="text-xs text-gray-400 mb-2">SP, факт против идеальной линии</p>
          <BurndownChart data={report?.burndown || []} lagSp={kpis?.lagSp} />
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-700">Поток по статусам (cumulative flow)</h3>
          <p className="text-xs text-gray-400 mb-2">где копится работа</p>
          <CfdChart data={report?.cfd || []} />
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h3 className="text-sm font-medium text-gray-700">История спринтов</h3>
            <p className="text-xs text-gray-400">обязательства, факт и переносы</p>
          </div>
          <button
            onClick={() => exportHistoryCsv(report?.history || [])}
            disabled={!report?.history?.length}
            className="text-sm border border-gray-300 rounded px-4 py-2 hover:bg-gray-50 disabled:opacity-50"
          >
            Экспорт
          </button>
        </div>

        {!report?.history?.length ? (
          <p className="text-sm text-gray-400 py-4">Нет данных</p>
        ) : (
          <div className="overflow-x-auto mt-3">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-4">Спринт</th>
                  <th className="py-2 pr-4">Период</th>
                  <th className="py-2 pr-4">Взято, SP</th>
                  <th className="py-2 pr-4">Сделано, SP</th>
                  <th className="py-2 pr-4">Выполнение</th>
                  <th className="py-2 pr-4">Перенесено</th>
                  <th className="py-2 pr-4">Scope creep</th>
                  <th className="py-2 pr-4">Ср. cycle time</th>
                  <th className="py-2 pr-4">Итог</th>
                </tr>
              </thead>
              <tbody>
                {report.history.map((h) => (
                  <tr key={h.sprintId} className={`border-b border-gray-100 ${h.state === 'active' ? 'bg-blue-50/40' : ''}`}>
                    <td className="py-2 pr-4 font-medium text-gray-700">{h.name}{h.state === 'active' ? ' (текущий)' : ''}</td>
                    <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">{fmtShortDate(h.startDate)} — {fmtShortDate(h.endDate)}</td>
                    <td className="py-2 pr-4">{fmtSp(h.takenSp)}</td>
                    <td className="py-2 pr-4">{fmtSp(h.doneSp)}</td>
                    <td className="py-2 pr-4">{fmtPct(h.completionPct)}</td>
                    <td className="py-2 pr-4">{h.carriedOverCount}</td>
                    <td className="py-2 pr-4">{fmtPct(h.scopeCreepPct)}</td>
                    <td className="py-2 pr-4">{h.avgCycleTime == null ? '—' : `${h.avgCycleTime.toFixed(2)} д`}</td>
                    <td className="py-2 pr-4">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${OUTCOME_CLASS[h.outcome]}`}>
                        {OUTCOME_LABEL[h.outcome] || h.outcome}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
        <h3 className="text-sm font-medium text-gray-700">Риски спринта</h3>
        <p className="text-xs text-gray-400 mb-2">активный спринт</p>

        {sprint?.state !== 'active' ? (
          <p className="text-sm text-gray-400 py-4">Риски отслеживаются только для активного спринта.</p>
        ) : !report?.risks?.length ? (
          <p className="text-sm text-gray-400 py-4">Проблемных задач нет.</p>
        ) : (
          <div className="overflow-x-auto mt-3">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-4">Задача</th>
                  <th className="py-2 pr-4">Команда</th>
                  <th className="py-2 pr-4">Проблема</th>
                  <th className="py-2 pr-4">Дней</th>
                  <th className="py-2 pr-4">SP</th>
                  <th className="py-2 pr-4">Действие</th>
                </tr>
              </thead>
              <tbody>
                {report.risks.map((r) => (
                  <tr key={r.issueKey} className="border-b border-gray-100">
                    <td className="py-2 pr-4">
                      <span className="font-medium text-gray-700">{r.issueKey}</span>{' '}
                      <span className="text-gray-500">{r.summary}</span>
                    </td>
                    <td className="py-2 pr-4">{r.team}</td>
                    <td className="py-2 pr-4">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${RISK_BADGE_CLASS[r.problem]}`}>
                        {r.problem}
                      </span>
                    </td>
                    <td className="py-2 pr-4">{r.days}</td>
                    <td className="py-2 pr-4">{r.sp ?? '—'}</td>
                    <td className="py-2 pr-4 text-gray-500">{r.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
