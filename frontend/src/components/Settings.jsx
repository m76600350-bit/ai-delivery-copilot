import React, { useState } from 'react';
import { jiraLoginUrl, getJiraIssues, getJiraStatus } from '../api.js';
import FieldMapping from './FieldMapping.jsx';
import SyncHistory from './SyncHistory.jsx';

function domainFromSiteUrl(siteUrl) {
  if (!siteUrl) return null;
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}

export default function Settings({ jiraStatus, onStatusChange, onDataLoaded }) {
  const [showFieldMapping, setShowFieldMapping] = useState(false);

  const handleSynced = async () => {
    try {
      onDataLoaded?.(await getJiraIssues());
    } catch {
      // Dashboard just keeps showing whatever it already had.
    }
    try {
      onStatusChange?.(await getJiraStatus());
    } catch {
      // Non-fatal — the connection card just keeps its previous numbers.
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h2 className="text-lg font-semibold text-gray-800">Настройки</h2>

      <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-700">Подключение Jira</h3>
          {jiraStatus?.connected && (
            <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 font-medium">
              подключено
            </span>
          )}
        </div>

        {!jiraStatus ? (
          <p className="text-sm text-gray-500">Загрузка...</p>
        ) : !jiraStatus.connected ? (
          <a
            href={jiraLoginUrl}
            className="inline-block bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded hover:bg-blue-700"
          >
            Подключить Jira
          </a>
        ) : (
          <div className="space-y-3">
            <div className="text-sm text-gray-600">
              {jiraStatus.siteUrl && (
                <p>
                  Домен: <span className="font-medium text-gray-800">{domainFromSiteUrl(jiraStatus.siteUrl)}</span>
                </p>
              )}
              <p className="text-xs text-gray-400 mt-0.5">задач в базе: {jiraStatus.issueCount}</p>
            </div>
            <div className="flex gap-4 items-center flex-wrap">
              <a
                href={jiraLoginUrl}
                className="text-sm border border-gray-300 rounded px-4 py-2 hover:bg-gray-50"
              >
                Переподключить Jira
              </a>
              <button
                onClick={() => setShowFieldMapping(true)}
                className="text-sm text-blue-600 hover:underline"
              >
                Настройки полей
              </button>
            </div>
          </div>
        )}
      </div>

      {showFieldMapping && jiraStatus?.connected && (
        <FieldMapping
          onClose={() => setShowFieldMapping(false)}
          onSaved={() => setShowFieldMapping(false)}
        />
      )}

      {jiraStatus?.connected && <SyncHistory onSynced={handleSynced} />}
    </div>
  );
}
