import React, { useEffect, useState } from 'react';
import FilterBar from './FilterBar.jsx';
import { getQualityReport, exportQualityCsv, getTaskFilters } from '../api.js';

function BugRateChart({ data }) {
  const max = Math.max(1, ...data.map((w) => w.bugRatePct || 0));
  return (
    <div className="flex items-end gap-2 h-40 px-1">
      {data.map((w) => (
        <div key={w.weekLabel} className="flex-1 min-w-0 flex flex-col items-center gap-1">
          <span className="text-xs text-gray-500">{w.bugRatePct == null ? '—' : `${w.bugRatePct}%`}</span>
          <div
            className="w-full rounded-t bg-red-200"
            style={{ height: `${Math.max(4, ((w.bugRatePct || 0) / max) * 100)}%` }}
          />
          <span className="text-[9px] text-gray-400 text-center leading-tight">{w.weekLabel}</span>
        </div>
      ))}
    </div>
  );
}

// Проект/Команда filters из общего состояния (4.3) — Тип не применяется
// (отчёт по определению про баги vs остальные типы).
export default function QualityReport({ jiraConnected, filters, onFilterChange, onResetFilters }) {
  const [report, setReport] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [filterOptions, setFilterOptions] = useState({ statuses: [], teams: [], types: [], priorities: [], projects: [] });

  useEffect(() => {
    if (!jiraConnected) return;
    getTaskFilters().then(setFilterOptions).catch(() => {});
  }, [jiraConnected]);

  useEffect(() => {
    if (!jiraConnected) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getQualityReport({
      project: filters.project.length ? filters.project : undefined,
      team: filters.team.length ? filters.team : undefined,
      period: filters.period !== 'all' ? filters.period : undefined,
    })
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Не удалось собрать отчёт');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [jiraConnected, filters]);

  if (!jiraConnected) {
    return (
      <div className="max-w-2xl mx-auto mt-16 text-center">
        <p className="text-gray-500">Раздел «Отчёты» использует данные из Jira. Подключите Jira в разделе «Настройки».</p>
      </div>
    );
  }

  const handleExport = async () => {
    if (!report) return;
    setIsExporting(true);
    try {
      const blob = await exportQualityCsv(report);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'quality-report.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось экспортировать отчёт');
    } finally {
      setIsExporting(false);
    }
  };

  if (isLoading && !report) {
    return <p className="text-center text-gray-400 text-sm mt-16">Загрузка отчёта...</p>;
  }

  return (
    <div className="space-y-6">
      <FilterBar options={filterOptions} filters={filters} onChange={onFilterChange} onReset={onResetFilters} />

      {error && <p className="text-sm text-red-600">{error}</p>}

      {report && (
        <>
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">Качество и баги</h2>
              <p className="text-xs text-gray-400 mt-0.5">{report.dateRangeLabel} · собран автоматически</p>
            </div>
            <button
              onClick={handleExport}
              disabled={isExporting}
              className="text-sm border border-gray-300 rounded px-4 py-1.5 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
            >
              {isExporting ? 'Экспорт...' : 'CSV / XLSX'}
            </button>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
            <p className="text-sm font-medium text-gray-700 mb-3">% багов от общего объёма по неделям</p>
            <BugRateChart data={report.weeklyBugRate} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
              <p className="text-sm font-medium text-gray-700 mb-3">% багов по командам</p>
              <table className="min-w-full text-sm">
                <tbody>
                  {report.bugRateByTeam.map((t) => (
                    <tr key={t.team} className="border-b border-gray-100">
                      <td className="py-1.5 pr-3 font-medium text-gray-700">{t.team}</td>
                      <td className="py-1.5 text-gray-500 text-right">{t.bugRatePct == null ? '—' : `${t.bugRatePct}%`}</td>
                    </tr>
                  ))}
                  {report.bugRateByTeam.length === 0 && (
                    <tr><td className="py-4 text-center text-gray-400">Нет данных</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
              <p className="text-sm font-medium text-gray-700 mb-3">Reopen rate по командам</p>
              <table className="min-w-full text-sm">
                <tbody>
                  {report.reopenRateByTeam.map((t) => (
                    <tr key={t.team} className="border-b border-gray-100">
                      <td className="py-1.5 pr-3 font-medium text-gray-700">{t.team}</td>
                      <td className="py-1.5 text-gray-500 text-right">{t.reopenRatePct == null ? '—' : `${t.reopenRatePct}%`}</td>
                    </tr>
                  ))}
                  {report.reopenRateByTeam.length === 0 && (
                    <tr><td className="py-4 text-center text-gray-400">Нет данных</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
              <p className="text-sm font-medium text-gray-700 mb-3">Средний Cycle Time: баги vs остальные</p>
              <div className="flex gap-8">
                <div>
                  <p className="text-xs text-gray-500">Баги ({report.cycleTimeByType.bugCount})</p>
                  <p className="text-xl font-semibold text-gray-800">{report.cycleTimeByType.bugAvg != null ? `${report.cycleTimeByType.bugAvg.toFixed(1)} д` : '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Остальные ({report.cycleTimeByType.otherCount})</p>
                  <p className="text-xl font-semibold text-gray-800">{report.cycleTimeByType.otherAvg != null ? `${report.cycleTimeByType.otherAvg.toFixed(1)} д` : '—'}</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
              <p className="text-sm font-medium text-gray-700 mb-1">Топ задач по количеству багов</p>
              <p className="text-xs text-gray-400 mb-3">связь через issue_links любого типа между багом и не-багом</p>
              {report.topBuggyTasks.length === 0 ? (
                <p className="text-xs text-gray-400">Связанных багов не найдено</p>
              ) : (
                <table className="min-w-full text-sm">
                  <tbody>
                    {report.topBuggyTasks.map((t) => (
                      <tr key={t.issueKey} className="border-b border-gray-100">
                        <td className="py-1.5 pr-3 font-medium text-gray-700 whitespace-nowrap">{t.issueKey}</td>
                        <td className="py-1.5 pr-3 text-gray-500">{t.summary}</td>
                        <td className="py-1.5 pr-3 text-gray-500 whitespace-nowrap">{t.team}</td>
                        <td className="py-1.5 text-gray-500 text-right">{t.bugCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
