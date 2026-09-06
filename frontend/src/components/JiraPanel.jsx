import React, { useState } from 'react';
import { jiraLoginUrl, syncJira, getJiraIssues } from '../api.js';

function formatDate(value) {
  if (!value) return null;
  return new Date(value).toLocaleString('ru-RU');
}

export default function JiraPanel({ status, onStatusChange, onDataLoaded }) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState(null);

  if (!status) return null;

  const handleSync = async () => {
    setIsSyncing(true);
    setError(null);
    try {
      await syncJira();
      const data = await getJiraIssues();
      onDataLoaded(data);
      onStatusChange({
        connected: true,
        issueCount: data.total,
        lastSyncedAt: data.lastSyncedAt,
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось синхронизировать данные из Jira');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleShowExisting = async () => {
    setError(null);
    try {
      const data = await getJiraIssues();
      onDataLoaded(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось загрузить данные из базы');
    }
  };

  return (
    <div className="max-w-2xl mx-auto bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-sm font-medium text-gray-700 mb-3">Jira</h2>

      {!status.connected ? (
        <a
          href={jiraLoginUrl}
          className="inline-block bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded hover:bg-blue-700"
        >
          Подключить Jira
        </a>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            Подключено · задач в базе: {status.issueCount}
            {status.lastSyncedAt && (
              <> · последняя синхронизация: {formatDate(status.lastSyncedAt)}</>
            )}
          </p>
          <div className="flex gap-4 items-center">
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {isSyncing ? 'Синхронизация...' : 'Синхронизировать данные из Jira'}
            </button>
            {status.issueCount > 0 && (
              <button
                onClick={handleShowExisting}
                className="text-sm text-blue-600 hover:underline"
              >
                Показать данные из базы
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
