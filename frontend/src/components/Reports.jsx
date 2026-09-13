import React, { useEffect, useState } from 'react';
import FilterBar from './FilterBar.jsx';
import { getReportStatus, getTaskFilters, saveReportSummary, exportReportCsv } from '../api.js';

// Bar chart of SP delivered per week — the last bar (current, possibly
// incomplete week) renders in gray rather than blue so it reads as
// "not final yet", same convention the mockup uses.
function WeeklyChart({ data }) {
  const max = Math.max(1, ...data.map((w) => w.sp));
  return (
    <div className="flex items-end gap-2 h-40 px-1">
      {data.map((w) => (
        <div key={w.weekLabel} className="flex-1 min-w-0 flex flex-col items-center gap-1">
          <span className="text-xs text-gray-500">{w.sp}</span>
          <div
            className={`w-full rounded-t ${w.incomplete ? 'bg-gray-300' : 'bg-blue-200'}`}
            style={{ height: `${Math.max(4, (w.sp / max) * 100)}%` }}
          />
          <span className="text-[9px] text-gray-400 text-center leading-tight">{w.weekLabel}</span>
        </div>
      ))}
    </div>
  );
}

// dashboardFilters mirrors the shape FilterBar/useSharedFilters produces —
// the report respects the same shared Проект/Команда/Тип/Статус/Приоритет/
// Период selection as Dashboard/Tasks (recomputed whenever it changes).
export default function Reports({ jiraConnected, filters, onFilterChange, onResetFilters }) {
  const [report, setReport] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [summaryText, setSummaryText] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [filterOptions, setFilterOptions] = useState({ statuses: [], teams: [], types: [], priorities: [], projects: [] });

  useEffect(() => {
    if (!jiraConnected) return;
    getTaskFilters()
      .then(setFilterOptions)
      .catch(() => {});
  }, [jiraConnected]);

  useEffect(() => {
    if (!jiraConnected) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getReportStatus({
      project: filters.project.length ? filters.project : undefined,
      team: filters.team.length ? filters.team : undefined,
      type: filters.type.length ? filters.type : undefined,
      status: filters.status.length ? filters.status : undefined,
      priority: filters.priority.length ? filters.priority : undefined,
      period: filters.period !== 'all' ? filters.period : undefined,
    })
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        setSummaryText(data.summaryDraft ?? data.summaryAuto.join('\n'));
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
        <p className="text-gray-500">
          Раздел «Отчёты» использует данные из Jira. Подключите Jira в разделе «Настройки», чтобы увидеть отчёт.
        </p>
      </div>
    );
  }

  const handleSummaryBlur = () => {
    if (!report) return;
    saveReportSummary(report.periodKey, summaryText).catch(() => {
      // Non-fatal — the edit just won't survive a reload this time.
    });
  };

  const handleExport = async () => {
    if (!report) return;
    setIsExporting(true);
    try {
      const blob = await exportReportCsv({
        title: report.title,
        dateRangeLabel: report.dateRangeLabel,
        summary: summaryText,
        teamsTable: report.teamsTable,
        weeklyChart: report.weeklyChart,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'report.csv';
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
    <div className="max-w-5xl mx-auto space-y-6">
      <FilterBar options={filterOptions} filters={filters} onChange={onFilterChange} onReset={onResetFilters} />

      {error && <p className="text-sm text-red-600">{error}</p>}

      {report && (
        <>
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">{report.title}</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {report.dateRangeLabel}
                {report.projects.length ? ` · проекты ${report.projects.join(', ')}` : ''} · собран автоматически
              </p>
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
            <p className="text-sm font-medium text-gray-700 mb-2">Резюме для стейкхолдеров</p>
            <textarea
              value={summaryText}
              onChange={(e) => setSummaryText(e.target.value)}
              onBlur={handleSummaryBlur}
              rows={4}
              className="w-full text-sm text-gray-700 border border-gray-200 rounded p-3 focus:outline-none focus:ring-1 focus:ring-blue-400"
              placeholder="Резюме появится здесь автоматически"
            />
            <p className="text-xs text-gray-400 mt-1">Текст сгенерирован автоматически — можно поправить вручную, правки сохраняются.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 min-w-0">
              <p className="text-sm font-medium text-gray-700 mb-3">План vs факт по командам</p>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200">
                      <th className="py-2 pr-4">Команда</th>
                      <th className="py-2 pr-4">План, SP</th>
                      <th className="py-2 pr-4">Факт, SP</th>
                      <th className="py-2 pr-4">%</th>
                      <th className="py-2 pr-4">Комментарий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.teamsTable.map((row) => (
                      <tr key={row.team} className="border-b border-gray-100">
                        <td className="py-2 pr-4 whitespace-nowrap">{row.team}</td>
                        <td className="py-2 pr-4">{row.planSp}</td>
                        <td className="py-2 pr-4">{row.factSp}</td>
                        <td className="py-2 pr-4">{row.pct == null ? '—' : `${row.pct}%`}</td>
                        <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">{row.comment}</td>
                      </tr>
                    ))}
                    {report.teamsTable.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-4 text-center text-gray-400">Нет данных</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 min-w-0">
              <p className="text-sm font-medium text-gray-700 mb-3">Динамика доставки, {report.weeklyChart.length} недель</p>
              <WeeklyChart data={report.weeklyChart} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
