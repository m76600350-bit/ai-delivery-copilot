import React, { useState } from 'react';
import { getSprintsReport } from '../api.js';

const MAX_COMPARE = 3;
const MIN_COMPARE = 2;

function fmtPct(value) {
  return value == null ? '—' : `${Math.round(value)}%`;
}

function fmtSp(value) {
  return value == null ? '—' : value;
}

// Rows to compare, in display order — each pulls its value from one
// selected sprint's own GET /api/sprints/report response (same endpoint and
// same team filter the Спринты screen itself uses), so any sprint in the
// full list can be compared — not just whichever happen to currently be in
// "История спринтов" (that table caps at MAX_HISTORY_SPRINTS).
const METRIC_ROWS = [
  { key: 'takenSp', label: 'Взято SP', format: (r) => fmtSp(r.kpis?.takenSp) },
  { key: 'doneSp', label: 'Сделано SP', format: (r) => fmtSp(r.kpis?.doneSp) },
  { key: 'doneSpPct', label: 'Выполнение %', format: (r) => fmtPct(r.kpis?.doneSpPct) },
  { key: 'carriedOver', label: 'Перенесено', format: (r) => r.kpis?.carriedOverCount ?? '—' },
  { key: 'scopeCreepPct', label: 'Scope creep %', format: (r) => fmtPct(r.kpis?.scopeCreepPct) },
  {
    key: 'avgCycleTime',
    label: 'Ср. cycle time',
    format: (r) => (r.kpis?.avgCycleTime == null ? '—' : `${r.kpis.avgCycleTime.toFixed(2)} д`),
  },
];

// 2.2-2.4 — pick 2-3 sprints, fetch each one's report, lay metrics out as
// rows with a column per sprint for a side-by-side read. No export here
// (2.5) — "Закрыть" is the only way out, back to the normal Спринты view.
export default function SprintCompareModal({ sprintOptions, teamFilter, onClose }) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [reports, setReports] = useState(null); // null until "Сравнить" is clicked
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const toggle = (value) => {
    setSelectedIds((prev) => {
      if (prev.includes(value)) return prev.filter((v) => v !== value);
      if (prev.length >= MAX_COMPARE) return prev;
      return [...prev, value];
    });
  };

  const handleCompare = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        selectedIds.map((id) => getSprintsReport({ sprint: id, team: teamFilter?.length ? teamFilter : undefined }))
      );
      setReports(results);
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось загрузить данные для сравнения');
    } finally {
      setIsLoading(false);
    }
  };

  const canCompare = selectedIds.length >= MIN_COMPARE && selectedIds.length <= MAX_COMPARE;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] overflow-y-auto p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800">Сравнить спринты</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
        </div>

        {!reports ? (
          <>
            <p className="text-xs text-gray-500">Выберите 2–3 спринта для сравнения.</p>
            <div className="border border-gray-200 rounded max-h-64 overflow-y-auto">
              {sprintOptions.map((s) => {
                const checked = selectedIds.includes(s.value);
                const disabled = !checked && selectedIds.length >= MAX_COMPARE;
                return (
                  <label
                    key={s.value}
                    className={`flex items-center gap-2 px-3 py-2 text-sm border-b border-gray-100 last:border-b-0 ${
                      disabled ? 'text-gray-300' : 'hover:bg-gray-50 cursor-pointer'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(s.value)}
                      className="rounded border-gray-300"
                    />
                    <span>{s.label}</span>
                  </label>
                );
              })}
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
              <button onClick={onClose} className="text-sm border border-gray-300 rounded px-4 py-2 hover:bg-gray-50">
                Закрыть
              </button>
              <button
                onClick={handleCompare}
                disabled={!canCompare || isLoading}
                className="text-sm bg-blue-600 text-white rounded px-4 py-2 hover:bg-blue-700 disabled:opacity-50"
              >
                {isLoading ? 'Загрузка...' : `Сравнить (${selectedIds.length})`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-4">Метрика</th>
                    {reports.map((r) => (
                      <th key={r.sprint?.id} className="py-2 px-4 whitespace-nowrap">
                        {r.sprint?.name || `Спринт ${r.sprint?.id}`}
                        {r.sprint?.state === 'active' && <span className="text-xs text-blue-600 font-normal"> (текущий)</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {METRIC_ROWS.map((row) => (
                    <tr key={row.key} className="border-b border-gray-100">
                      <td className="py-2 pr-4 text-gray-500">{row.label}</td>
                      {reports.map((r) => (
                        <td key={r.sprint?.id} className="py-2 px-4 font-medium text-gray-700">
                          {row.format(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
              <button onClick={() => setReports(null)} className="text-sm border border-gray-300 rounded px-4 py-2 hover:bg-gray-50">
                Изменить выбор
              </button>
              <button onClick={onClose} className="text-sm bg-blue-600 text-white rounded px-4 py-2 hover:bg-blue-700">
                Закрыть
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
