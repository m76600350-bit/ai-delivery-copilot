import React, { useMemo, useState } from 'react';

function StatCard({ title, value }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{title}</p>
      <p className="text-2xl font-semibold text-gray-800 mt-1">{value}</p>
    </div>
  );
}

function BreakdownCard({ title, data }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 1;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
      <p className="text-sm font-medium text-gray-700 mb-3">{title}</p>
      <div className="space-y-2">
        {entries.map(([key, count]) => (
          <div key={key}>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span className="truncate max-w-[70%]">{key}</span>
              <span>{count}</span>
            </div>
            <div className="w-full bg-gray-100 rounded h-2">
              <div
                className="bg-blue-500 h-2 rounded"
                style={{ width: `${(count / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
        {entries.length === 0 && (
          <p className="text-xs text-gray-400">Нет данных</p>
        )}
      </div>
    </div>
  );
}

export default function Dashboard({ stats, onReset }) {
  const [statusFilter, setStatusFilter] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [search, setSearch] = useState('');

  const statuses = useMemo(() => Object.keys(stats.byStatus || {}), [stats]);
  const teams = useMemo(() => Object.keys(stats.byTeam || {}), [stats]);

  const filteredIssues = useMemo(() => {
    return (stats.issues || []).filter((issue) => {
      if (statusFilter && issue.status !== statusFilter) return false;
      if (teamFilter && !String(issue.labels).includes(teamFilter)) return false;
      if (
        search &&
        !`${issue.code} ${issue.name}`.toLowerCase().includes(search.toLowerCase())
      )
        return false;
      return true;
    });
  }, [stats.issues, statusFilter, teamFilter, search]);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Статистика</h2>
          {stats.lastSyncedAt && (
            <p className="text-xs text-gray-400 mt-0.5">
              Последняя синхронизация с Jira: {new Date(stats.lastSyncedAt).toLocaleString('ru-RU')}
            </p>
          )}
        </div>
        <button
          onClick={onReset}
          className="text-sm text-blue-600 hover:underline"
        >
          Загрузить другой файл
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Всего задач" value={stats.total} />
        <StatCard title="Статусов" value={Object.keys(stats.byStatus || {}).length} />
        <StatCard title="Команд" value={Object.keys(stats.byTeam || {}).length} />
        <StatCard title="Типов" value={Object.keys(stats.byType || {}).length} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <BreakdownCard title="По статусу" data={stats.byStatus} />
        <BreakdownCard title="По команде" data={stats.byTeam} />
        <BreakdownCard title="По типу" data={stats.byType} />
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
        <div className="flex flex-wrap gap-3 mb-4">
          <input
            type="text"
            placeholder="Поиск по коду/названию..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 min-w-[200px]"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm"
          >
            <option value="">Все статусы</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm"
          >
            <option value="">Все команды</option>
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-4">Код</th>
                <th className="py-2 pr-4">Название</th>
                <th className="py-2 pr-4">Статус</th>
                <th className="py-2 pr-4">Команда</th>
                <th className="py-2 pr-4">Тип</th>
                <th className="py-2 pr-4">Cycle time</th>
                <th className="py-2 pr-4">LT</th>
                <th className="py-2 pr-4">Дата создания</th>
              </tr>
            </thead>
            <tbody>
              {filteredIssues.map((issue, idx) => (
                <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2 pr-4 whitespace-nowrap">{issue.code}</td>
                  <td className="py-2 pr-4">{issue.name}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{issue.status}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{issue.labels}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{issue.type}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{issue.cycleTime}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{issue.leadTime}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{issue.createdAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredIssues.length === 0 && (
            <p className="text-center text-gray-400 text-sm py-6">
              Ничего не найдено
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
