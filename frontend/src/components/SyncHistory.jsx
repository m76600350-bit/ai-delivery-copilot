import React, { useEffect, useState } from 'react';
import { getSyncHistory, syncJira } from '../api.js';
import useSyncProgress from '../useSyncProgress.js';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

function syncButtonLabel(isSyncing, progress) {
  if (!isSyncing) return 'Обновить сейчас';
  if (progress && progress.total > 0) {
    return `Синхронизация... получено ${progress.completed} из ${progress.total} задач`;
  }
  return 'Синхронизация...';
}

export default function SyncHistory({ onSynced }) {
  const [history, setHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState(null);
  const progress = useSyncProgress(isSyncing);

  const loadHistory = async () => {
    try {
      const data = await getSyncHistory();
      setHistory(data.items);
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось загрузить историю синхронизаций');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const handleSync = async () => {
    setIsSyncing(true);
    setError(null);
    try {
      await syncJira();
      await loadHistory();
      onSynced?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось синхронизировать данные из Jira');
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">Синхронизация</h3>
        <button
          onClick={handleSync}
          disabled={isSyncing}
          className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {syncButtonLabel(isSyncing, progress)}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {isLoading ? (
        <p className="text-sm text-gray-500">Загрузка...</p>
      ) : history.length === 0 ? (
        <p className="text-sm text-gray-400">Синхронизаций ещё не было.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-4">Время</th>
                <th className="py-2 pr-4">Источник</th>
                <th className="py-2 pr-4">Задач</th>
                <th className="py-2 pr-4">Итог</th>
              </tr>
            </thead>
            <tbody>
              {history.map((run, idx) => (
                <tr key={idx} className="border-b border-gray-100">
                  <td className="py-2 pr-4 whitespace-nowrap">{formatDate(run.startedAt)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{run.source}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{run.total ?? '—'}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {run.status === 'success' ? (
                      <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                        успешно
                      </span>
                    ) : (
                      <span
                        className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700"
                        title={run.error || ''}
                      >
                        ошибка
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
