import React, { useEffect, useState } from 'react';
import { getTeamsHealthReport, exportTeamsHealthCsv } from '../api.js';

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

const VELOCITY_TREND_LABEL = { growing: 'растёт', falling: 'падает', stable: 'стабильна' };

function Sparkline({ values }) {
  if (!values.length) return <span className="text-xs text-gray-300">—</span>;
  const max = Math.max(1, ...values);
  return (
    <div className="flex items-end gap-0.5 h-8">
      {values.map((v, i) => (
        <div key={i} className="w-2 bg-blue-300 rounded-t" style={{ height: `${Math.max(8, (v / max) * 100)}%` }} title={`${v} SP`} />
      ))}
    </div>
  );
}

// filters here supplies Проект/Команда/Тип (4.3) plus Период (3.1) — passed
// straight through to computeTeamsReport, same as the Команды screen itself.
export default function TeamsHealthReport({ jiraConnected, filters }) {
  const [report, setReport] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    if (!jiraConnected) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getTeamsHealthReport({
      project: filters.project.length ? filters.project : undefined,
      team: filters.team.length ? filters.team : undefined,
      type: filters.type.length ? filters.type : undefined,
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
  }, [jiraConnected, filters.project, filters.team, filters.type]);

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
      const blob = await exportTeamsHealthCsv(report);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'teams-health-report.csv';
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
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Здоровье команд</h2>
          <p className="text-xs text-gray-400 mt-0.5">собран автоматически</p>
        </div>
        <button
          onClick={handleExport}
          disabled={isExporting || !report}
          className="text-sm border border-gray-300 rounded px-4 py-1.5 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
        >
          {isExporting ? 'Экспорт...' : 'CSV / XLSX'}
        </button>
      </div>

      <p className="text-xs text-gray-400 italic">
        Блок «Изменения с прошлого периода» не реализован — WIP-сигнал здоровья зависит от текущего снимка задач и не имеет
        исторической записи, поэтому пересчитать здоровье «на момент прошлого периода» нельзя без отдельного, гораздо более
        сложного движка, который рискует разойтись с живым расчётом в «Командах». Подробности — в README, раздел «Отчёты».
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {report && (
        <>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
            <p className="text-sm font-medium text-gray-700 mb-3">Здоровье команд</p>
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-4">Команда</th>
                  <th className="py-2 pr-4">Статус</th>
                  <th className="py-2 pr-4">Причина</th>
                </tr>
              </thead>
              <tbody>
                {report.teams.map((t) => (
                  <tr key={t.team} className="border-b border-gray-100">
                    <td className="py-2 pr-4 font-medium text-gray-700">{t.team}</td>
                    <td className="py-2 pr-4">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${HEALTH_CLASS[t.health]}`}>
                        {HEALTH_LABEL[t.health]}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-500">{t.reasons.length ? t.reasons.join(', ') : '—'}</td>
                  </tr>
                ))}
                {report.teams.length === 0 && (
                  <tr><td colSpan={3} className="py-4 text-center text-gray-400">Нет данных</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
            <p className="text-sm font-medium text-gray-700 mb-1">Тренд Velocity</p>
            <p className="text-xs text-gray-400 mb-3">Done SP за последние закрытые спринты (до 5) · тренд = последние 2 vs. среднее по остальным</p>
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-4">Команда</th>
                  <th className="py-2 pr-4">Спарклайн</th>
                  <th className="py-2 pr-4">Тренд</th>
                </tr>
              </thead>
              <tbody>
                {report.teams.map((t) => (
                  <tr key={t.team} className="border-b border-gray-100">
                    <td className="py-2 pr-4 font-medium text-gray-700">{t.team}</td>
                    <td className="py-2 pr-4"><Sparkline values={t.velocityHistory.map((s) => s.doneSp)} /></td>
                    <td className="py-2 pr-4 text-gray-500">{t.velocityTrend ? VELOCITY_TREND_LABEL[t.velocityTrend] : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
            <p className="text-sm font-medium text-gray-700 mb-3">Загрузка людей</p>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-4">Команда</th>
                    <th className="py-2 pr-4">Исполнитель</th>
                    <th className="py-2 pr-4">В работе</th>
                    <th className="py-2 pr-4">SP</th>
                    <th className="py-2 pr-4">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {report.peopleLoad.map((p, i) => (
                    <tr key={`${p.team}-${p.assignee || i}`} className="border-b border-gray-100">
                      <td className="py-2 pr-4 text-gray-500">{p.team}</td>
                      <td className="py-2 pr-4">{p.assignee || 'не назначен'}</td>
                      <td className="py-2 pr-4">{p.inProgress}</td>
                      <td className="py-2 pr-4">{p.sp ?? '—'}</td>
                      <td className="py-2 pr-4">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${PEOPLE_STATUS_CLASS[p.status]}`}>
                          {PEOPLE_STATUS_LABEL[p.status]}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {report.peopleLoad.length === 0 && (
                    <tr><td colSpan={5} className="py-4 text-center text-gray-400">Сейчас нет задач в работе</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
