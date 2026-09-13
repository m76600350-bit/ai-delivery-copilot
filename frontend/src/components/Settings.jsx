import React, { useState } from 'react';
import { jiraLoginUrl, getJiraIssues, getJiraStatus, syncJira } from '../api.js';
import FieldMapping from './FieldMapping.jsx';
import SyncHistory from './SyncHistory.jsx';
import TeamRoles from './TeamRoles.jsx';
import WipLimitsModal from './WipLimitsModal.jsx';
import useSyncProgress from '../useSyncProgress.js';

function domainFromSiteUrl(siteUrl) {
  if (!siteUrl) return null;
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}

const SECTIONS = [
  { key: 'connection', label: 'Подключение Jira' },
  { key: 'people', label: 'Команды и люди' },
  { key: 'metrics', label: 'Метрики и SLA' },
  { key: 'alerts', label: 'Алерты' },
  { key: 'history', label: 'История синхронизаций' },
];

// 5.1/5.3 — a left sidebar of fixed sections; only the selected one renders
// on the right (no more scrolling through every block stacked one after
// another).
function ConnectionSection({ jiraStatus, onStatusChange, onDataLoaded }) {
  const [showFieldMapping, setShowFieldMapping] = useState(false);
  const [isFullSyncing, setIsFullSyncing] = useState(false);
  const [fullSyncError, setFullSyncError] = useState(null);
  const fullSyncProgress = useSyncProgress(isFullSyncing);

  // 3.3 — "Полная пересинхронизация" moved here from the section headers;
  // recomputes lead/cycle/reopen time for every issue regardless of whether
  // Jira's `updated` timestamp changed (see syncJira's own doc comment).
  const handleFullResync = async () => {
    setIsFullSyncing(true);
    setFullSyncError(null);
    try {
      await syncJira(true);
      try {
        onDataLoaded?.(await getJiraIssues());
      } catch {
        // Non-fatal — whatever's currently loaded stays as-is.
      }
      try {
        onStatusChange?.(await getJiraStatus());
      } catch {
        // Non-fatal.
      }
    } catch (err) {
      setFullSyncError(err.response?.data?.error || 'Не удалось выполнить полную пересинхронизацию');
    } finally {
      setIsFullSyncing(false);
    }
  };

  return (
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
            <button
              onClick={handleFullResync}
              disabled={isFullSyncing}
              title="Пересчитывает время в статусах для всех задач заново, даже если они не менялись в Jira — используйте после обновления приложения, если цифры выглядят устаревшими"
              className="text-sm text-gray-500 hover:text-gray-700 hover:underline disabled:opacity-50"
            >
              {isFullSyncing
                ? fullSyncProgress && fullSyncProgress.total > 0
                  ? `Синхронизация... получено ${fullSyncProgress.completed} из ${fullSyncProgress.total} задач`
                  : 'Синхронизация...'
                : 'Полная пересинхронизация'}
            </button>
          </div>
          {fullSyncError && <p className="text-sm text-red-600">{fullSyncError}</p>}
        </div>
      )}

      {showFieldMapping && jiraStatus?.connected && (
        <FieldMapping
          onClose={() => setShowFieldMapping(false)}
          onSaved={() => setShowFieldMapping(false)}
        />
      )}
    </div>
  );
}

export default function Settings({ jiraStatus, onStatusChange, onDataLoaded }) {
  const [activeSection, setActiveSection] = useState('connection');

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
    <div className="max-w-5xl mx-auto flex gap-6">
      <h2 className="sr-only">Настройки</h2>
      <aside className="w-56 shrink-0 space-y-1">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide px-2 mb-2">Настройки</p>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setActiveSection(s.key)}
            className={`w-full text-left text-sm px-3 py-2 rounded ${
              activeSection === s.key ? 'bg-gray-100 text-gray-900 font-medium' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            {s.label}
          </button>
        ))}
      </aside>

      <div className="flex-1 min-w-0 space-y-6">
        {activeSection === 'connection' && (
          <ConnectionSection jiraStatus={jiraStatus} onStatusChange={onStatusChange} onDataLoaded={onDataLoaded} />
        )}

        {activeSection === 'people' && (jiraStatus?.connected ? <TeamRoles /> : <p className="text-sm text-gray-500">Подключите Jira, чтобы назначать роли.</p>)}

        {activeSection === 'metrics' && (jiraStatus?.connected ? <WipLimitsModal /> : <p className="text-sm text-gray-500">Подключите Jira, чтобы настроить WIP-лимиты.</p>)}

        {activeSection === 'alerts' && (
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <p className="text-sm text-gray-500">Скоро: уведомления о блокерах и отставании от графика.</p>
          </div>
        )}

        {activeSection === 'history' && (jiraStatus?.connected ? <SyncHistory onSynced={handleSynced} /> : <p className="text-sm text-gray-500">Подключите Jira, чтобы увидеть историю синхронизаций.</p>)}
      </div>
    </div>
  );
}
