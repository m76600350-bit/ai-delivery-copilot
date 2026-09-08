import React, { useMemo, useState } from 'react';
import MultiSelectFilter from './MultiSelectFilter.jsx';

const PERIOD_OPTIONS = [
  { value: 'all', label: 'Всё время' },
  { value: '7', label: 'Последние 7 дней' },
  { value: '30', label: 'Последние 30 дней' },
  { value: '90', label: 'Последние 90 дней' },
];

function issueTeams(issue) {
  const source = issue.team || issue.labels || '';
  const teams = String(source).split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  return teams.length ? teams : ['Без команды'];
}

function issueStatus(issue) {
  return issue.status || 'Без статуса';
}

function issueType(issue) {
  return issue.type || 'Без типа';
}

// Widget's own dimension (status/team/type) always groups the table; team
// additionally breaks each group down by status, since that's the one
// combination in our data with a real second axis worth drilling into.
function buildGroups(issues, dimension) {
  const groups = new Map();

  for (const issue of issues) {
    if (dimension === 'team') {
      for (const team of issueTeams(issue)) {
        if (!groups.has(team)) groups.set(team, { total: 0, sub: new Map() });
        const g = groups.get(team);
        g.total += 1;
        const status = issueStatus(issue);
        g.sub.set(status, (g.sub.get(status) || 0) + 1);
      }
    } else {
      const key = dimension === 'status' ? issueStatus(issue) : issueType(issue);
      if (!groups.has(key)) groups.set(key, { total: 0, sub: null });
      groups.get(key).total += 1;
    }
  }

  return [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
}

const DIMENSION_FILTER_KEY = { status: 'status', team: 'team', type: 'type' };

export default function WidgetDrilldown({ dimension, title, issues, onBack, onNavigateToTasks }) {
  const [period, setPeriod] = useState('all');
  const [teamFilter, setTeamFilter] = useState([]);
  const [typeFilter, setTypeFilter] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());

  const allTeams = useMemo(() => {
    const set = new Set();
    for (const issue of issues) for (const t of issueTeams(issue)) set.add(t);
    return [...set].sort();
  }, [issues]);

  const allTypes = useMemo(() => {
    const set = new Set();
    for (const issue of issues) set.add(issueType(issue));
    return [...set].sort();
  }, [issues]);

  const filteredIssues = useMemo(() => {
    const cutoff = period === 'all' ? null : Date.now() - Number(period) * 86400000;
    return issues.filter((issue) => {
      if (cutoff != null) {
        const created = issue.createdAt ? new Date(issue.createdAt).getTime() : null;
        if (!created || Number.isNaN(created) || created < cutoff) return false;
      }
      if (teamFilter.length && !issueTeams(issue).some((t) => teamFilter.includes(t))) return false;
      if (typeFilter.length && !typeFilter.includes(issueType(issue))) return false;
      return true;
    });
  }, [issues, period, teamFilter, typeFilter]);

  const groups = useMemo(() => buildGroups(filteredIssues, dimension), [filteredIssues, dimension]);

  const toggleExpanded = (key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const dimensionKey = DIMENSION_FILTER_KEY[dimension];

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-gray-500 hover:text-gray-800 text-lg leading-none"
            title="Назад"
          >
            ←
          </button>
          <h2 className="text-lg font-semibold text-gray-800">{title}</h2>
          <span className="text-xs text-gray-400">развёрнутый вид · {filteredIssues.length} задач</span>
        </div>
        <button
          onClick={onBack}
          className="text-sm border border-gray-300 rounded px-3 py-1.5 hover:bg-gray-50"
        >
          Свернуть
        </button>
      </div>

      <div className="flex gap-6">
        <aside className="w-56 shrink-0 bg-white rounded-lg border border-gray-200 p-4 space-y-4 h-fit">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Фильтры виджета</p>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Период</label>
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            >
              {PERIOD_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Команда</label>
            <MultiSelectFilter label="Все команды" options={allTeams} selected={teamFilter} onChange={setTeamFilter} />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Тип задачи</label>
            <MultiSelectFilter label="Все типы" options={allTypes} selected={typeFilter} onChange={setTypeFilter} />
          </div>

          <p className="text-xs text-gray-400 italic">
            локальный фильтр не влияет на общий дашборд
          </p>
        </aside>

        <div className="flex-1 bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 px-4">{title.replace('По ', '')}</th>
                <th className="py-2 px-4">Всего</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([key, group]) => {
                const isExpandable = dimension === 'team' && group.sub.size > 1;
                const isOpen = expanded.has(key);

                return (
                  <React.Fragment key={key}>
                    <tr className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-2 px-4">
                        <div className="flex items-center gap-2">
                          {isExpandable && (
                            <button
                              onClick={() => toggleExpanded(key)}
                              className="text-gray-400 hover:text-gray-700 text-xs w-4"
                            >
                              {isOpen ? '▾' : '▸'}
                            </button>
                          )}
                          <button
                            onClick={() => onNavigateToTasks({ [dimensionKey]: [key] })}
                            className="text-blue-600 hover:underline text-left"
                          >
                            {key}
                          </button>
                        </div>
                      </td>
                      <td className="py-2 px-4">
                        <button
                          onClick={() => onNavigateToTasks({ [dimensionKey]: [key] })}
                          className="text-gray-700 hover:underline font-medium"
                        >
                          {group.total}
                        </button>
                      </td>
                    </tr>

                    {isExpandable &&
                      isOpen &&
                      [...group.sub.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .map(([status, count]) => (
                          <tr key={`${key}__${status}`} className="border-b border-gray-50 bg-gray-50/50">
                            <td className="py-1.5 px-4 pl-10 text-gray-500">
                              <button
                                onClick={() => onNavigateToTasks({ team: [key], status: [status] })}
                                className="text-blue-600 hover:underline text-left"
                              >
                                {status}
                              </button>
                            </td>
                            <td className="py-1.5 px-4">
                              <button
                                onClick={() => onNavigateToTasks({ team: [key], status: [status] })}
                                className="text-gray-600 hover:underline"
                              >
                                {count}
                              </button>
                            </td>
                          </tr>
                        ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>

          {groups.length === 0 && (
            <p className="text-center text-gray-400 text-sm py-8">Нет данных по выбранным фильтрам</p>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-400">
        клик по строке → задачи этого среза · клик по числу → более узкий срез
      </p>
    </div>
  );
}
