import React, { useState } from 'react';
import useSyncProgress from '../useSyncProgress.js';

function syncButtonLabel(isSyncing, progress) {
  if (!isSyncing) return 'Обновить данные из Jira';
  if (progress && progress.total > 0) {
    return `Синхронизация... получено ${progress.completed} из ${progress.total} задач`;
  }
  return 'Синхронизация...';
}

// Shared section header (3.1) for Дашборд/Задачи/Команды/Спринты/Отчёты —
// title + "последняя синхронизация" on the left, the regular (non-force)
// sync button on the right. Self-contained regarding sync state (isSyncing/
// progress/error) so every screen using it gets identical sync UX for free;
// `onSync` is just App's shared syncFromJira(false). "Полная
// пересинхронизация" is NOT here (3.3) — moved to Настройки → Подключение Jira.
export default function SectionHeader({ title, lastSyncedAt, onSync }) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState(null);
  const syncProgress = useSyncProgress(isSyncing);

  const handleSync = async () => {
    setIsSyncing(true);
    setError(null);
    try {
      await onSync(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось синхронизировать данные из Jira');
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="flex items-center justify-between">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">{title}</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          {lastSyncedAt ? `Последняя синхронизация с Jira: ${new Date(lastSyncedAt).toLocaleString('ru-RU')}` : 'Ещё не синхронизировано'}
        </p>
        {error && <p className="text-xs text-red-600 mt-0.5">{error}</p>}
      </div>
      <button
        onClick={handleSync}
        disabled={isSyncing}
        className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
      >
        {syncButtonLabel(isSyncing, syncProgress)}
      </button>
    </div>
  );
}
