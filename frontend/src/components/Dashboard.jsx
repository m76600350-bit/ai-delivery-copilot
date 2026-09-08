import React, { useState } from 'react';
import WidgetDrilldown from './WidgetDrilldown.jsx';

function StatCard({ title, value }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{title}</p>
      <p className="text-2xl font-semibold text-gray-800 mt-1">{value}</p>
    </div>
  );
}

function BreakdownCard({ title, data, onExpand }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 1;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 relative">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-gray-700">{title}</p>
        {onExpand && (
          <button
            onClick={onExpand}
            title="Развернуть на весь экран"
            className="text-gray-400 hover:text-gray-700 text-sm leading-none"
          >
            ⛶
          </button>
        )}
      </div>
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

const WIDGET_TITLES = {
  status: 'По статусу',
  team: 'По команде',
  type: 'По типу',
};

export default function Dashboard({ stats, onReset, jiraConnected, onSyncJira, onNavigateToTasks }) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [expandedWidget, setExpandedWidget] = useState(null);

  const handleSyncJira = async () => {
    setIsSyncing(true);
    setSyncError(null);
    try {
      await onSyncJira();
    } catch (err) {
      setSyncError(err.response?.data?.error || 'Не удалось синхронизировать данные из Jira');
    } finally {
      setIsSyncing(false);
    }
  };

  // Every hook above must run on every render regardless of this branch —
  // an early return before them would violate the Rules of Hooks and throw
  // "Rendered fewer hooks than expected" the moment a widget is expanded.
  if (expandedWidget) {
    return (
      <WidgetDrilldown
        dimension={expandedWidget}
        title={WIDGET_TITLES[expandedWidget]}
        issues={stats.issues || []}
        onBack={() => setExpandedWidget(null)}
        onNavigateToTasks={(filters) => {
          setExpandedWidget(null);
          onNavigateToTasks?.(filters);
        }}
      />
    );
  }

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
        <div className="flex items-center gap-4">
          {jiraConnected && (
            <button
              onClick={handleSyncJira}
              disabled={isSyncing}
              className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {isSyncing ? 'Синхронизация...' : 'Обновить данные из Jira'}
            </button>
          )}
          <button
            onClick={onReset}
            className="text-sm text-blue-600 hover:underline"
          >
            Загрузить другой файл
          </button>
        </div>
      </div>

      {syncError && (
        <p className="text-sm text-red-600 -mt-4">{syncError}</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Всего задач" value={stats.total} />
        <StatCard title="Статусов" value={Object.keys(stats.byStatus || {}).length} />
        <StatCard title="Команд" value={Object.keys(stats.byTeam || {}).length} />
        <StatCard title="Типов" value={Object.keys(stats.byType || {}).length} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <BreakdownCard title="По статусу" data={stats.byStatus} onExpand={() => setExpandedWidget('status')} />
        <BreakdownCard title="По команде" data={stats.byTeam} onExpand={() => setExpandedWidget('team')} />
        <BreakdownCard title="По типу" data={stats.byType} onExpand={() => setExpandedWidget('type')} />
      </div>
    </div>
  );
}
