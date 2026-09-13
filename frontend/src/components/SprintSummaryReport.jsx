import React, { useEffect, useState } from 'react';
import { getSprintSummaryReport, exportSprintSummaryCsv } from '../api.js';

function TrendTag({ trend }) {
  if (!trend) return null;
  const arrow = trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→';
  const cls = trend.direction === 'up' ? 'text-green-600' : trend.direction === 'down' ? 'text-red-600' : 'text-gray-400';
  const sign = trend.pct > 0 ? '+' : '';
  return <span className={`text-xs font-medium ml-1 ${cls}`}>{arrow} {sign}{trend.pct}%</span>;
}

function KpiCard({ title, value, trend }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{title}</p>
      <p className="text-2xl font-semibold text-gray-800 mt-1">
        {value}
        <TrendTag trend={trend} />
      </p>
      <p className="text-xs text-gray-400 mt-1">к среднему за предыдущие спринты</p>
    </div>
  );
}

// filters here supplies only Проект/Команда/Тип, per spec 4.3 — Спринты
// screen's own filter bar has never included Статус/Приоритет/Период
// either (a sprint report is scoped to one sprint, not a date range).
export default function SprintSummaryReport({ jiraConnected, filters }) {
  const [report, setReport] = useState(null);
  const [sprintId, setSprintId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    if (!jiraConnected) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getSprintSummaryReport({
      sprint: sprintId || undefined,
      team: filters.team.length ? filters.team : undefined,
      type: filters.type.length ? filters.type : undefined,
    })
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        if (data.sprint) setSprintId((prev) => prev || String(data.sprint.id));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jiraConnected, sprintId, filters.team, filters.type]);

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
      const blob = await exportSprintSummaryCsv(report);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sprint-report.csv';
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

  if (report && !report.sprint) {
    return <p className="text-center text-gray-400 text-sm mt-16">Нет спринтов для отображения</p>;
  }

  const isActive = report?.sprint?.state === 'active';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Итоги спринта{report ? ` — ${report.sprint.name}` : ''}</h2>
          <div className="flex items-center gap-3 mt-1">
            <select
              value={sprintId || ''}
              onChange={(e) => setSprintId(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-xs"
            >
              {(report?.sprintOptions || []).map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <span className="text-xs text-gray-400">{isActive ? 'активный спринт' : 'завершён'} · собран автоматически</span>
          </div>
        </div>
        <button
          onClick={handleExport}
          disabled={isExporting || !report}
          className="text-sm border border-gray-300 rounded px-4 py-1.5 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
        >
          {isExporting ? 'Экспорт...' : 'CSV / XLSX'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {report && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <KpiCard title="Взято SP" value={report.kpis?.takenSp ?? '—'} trend={report.kpiTrends.takenSp} />
            <KpiCard title="Сделано SP" value={report.kpis?.doneSp ?? '—'} trend={report.kpiTrends.doneSp} />
            <KpiCard
              title="% выполнения"
              value={report.kpis?.doneSpPct != null ? `${Math.round(report.kpis.doneSpPct)}%` : '—'}
              trend={report.kpiTrends.doneSpPct}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
              <p className="text-sm font-medium text-gray-700 mb-1">
                Scope creep {report.scopeCreepPct != null ? `— ${Math.round(report.scopeCreepPct)}%` : ''}
              </p>
              <p className="text-xs text-gray-400 mb-3">задачи, добавленные после старта спринта</p>
              {report.scopeCreepItems.length === 0 ? (
                <p className="text-xs text-gray-400">Нет добавленных задач</p>
              ) : (
                <table className="min-w-full text-sm">
                  <tbody>
                    {report.scopeCreepItems.map((i) => (
                      <tr key={i.issueKey} className="border-b border-gray-100">
                        <td className="py-1.5 pr-3 font-medium text-gray-700 whitespace-nowrap">{i.issueKey}</td>
                        <td className="py-1.5 pr-3 text-gray-500">{i.summary}</td>
                        <td className="py-1.5 text-gray-500 text-right">{i.storyPoints ?? '—'} SP</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
              <p className="text-sm font-medium text-gray-700 mb-1">Перенесённые задачи</p>
              <p className="text-xs text-gray-400 mb-3">
                {isActive ? 'прогноз по текущему темпу — задачи, ещё не в Done' : 'не завершены к концу спринта'}
              </p>
              {report.carriedOverItems.length === 0 ? (
                <p className="text-xs text-gray-400">Нет незавершённых задач</p>
              ) : (
                <table className="min-w-full text-sm">
                  <tbody>
                    {report.carriedOverItems.map((i) => (
                      <tr key={i.issueKey} className="border-b border-gray-100">
                        <td className="py-1.5 pr-3 font-medium text-gray-700 whitespace-nowrap">{i.issueKey}</td>
                        <td className="py-1.5 pr-3 text-gray-500">{i.summary}</td>
                        <td className="py-1.5 text-gray-500 whitespace-nowrap">{i.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
              <p className="text-sm font-medium text-gray-700 mb-1">Reopen rate за спринт</p>
              <p className="text-2xl font-semibold text-gray-800 mt-1">{report.reopenRatePct != null ? `${report.reopenRatePct}%` : '—'}</p>
              <p className="text-xs text-gray-400 mt-1">задач спринта с хотя бы одним reopen</p>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
              <p className="text-sm font-medium text-gray-700 mb-3">Топ-3 самых долгих задачи</p>
              {report.topLongest.length === 0 ? (
                <p className="text-xs text-gray-400">Нет данных</p>
              ) : (
                <table className="min-w-full text-sm">
                  <tbody>
                    {report.topLongest.map((i) => (
                      <tr key={i.issueKey} className="border-b border-gray-100">
                        <td className="py-1.5 pr-3 font-medium text-gray-700 whitespace-nowrap">{i.issueKey}</td>
                        <td className="py-1.5 pr-3 text-gray-500">{i.summary}</td>
                        <td className="py-1.5 pr-3 text-gray-500 whitespace-nowrap">{i.status}</td>
                        <td className="py-1.5 text-gray-500 text-right whitespace-nowrap">{i.days} д</td>
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
