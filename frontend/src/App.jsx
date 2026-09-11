import React, { useState, useEffect, useCallback } from 'react';
import Dashboard from './components/Dashboard.jsx';
import JiraPanel from './components/JiraPanel.jsx';
import FieldMapping from './components/FieldMapping.jsx';
import Tasks from './components/Tasks.jsx';
import Teams from './components/Teams.jsx';
import Sprints from './components/Sprints.jsx';
import Settings from './components/Settings.jsx';
import TopNav from './components/TopNav.jsx';
import useSharedFilters from './useSharedFilters.js';
import { getJiraStatus, getFieldMapping, syncJira, getJiraIssues } from './api.js';

// /api/auth/callback redirects here with ?jira=connected once the OAuth flow
// finishes. Read it once during the initial render (lazy state init), not
// inside an effect — an effect can run twice in React StrictMode dev builds,
// and by the second run the query param would already be stripped from the URL.
function readJustConnected() {
  return new URLSearchParams(window.location.search).get('jira') === 'connected';
}

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [stats, setStats] = useState(null);
  const [jiraStatus, setJiraStatus] = useState(() =>
    readJustConnected() ? { connected: true, issueCount: 0, lastSyncedAt: null } : null
  );
  const [showFieldMapping, setShowFieldMapping] = useState(false);
  const [justConnected, setJustConnected] = useState(readJustConnected);
  // Shared between Dashboard and Tasks (both read/write the same instance),
  // and persisted to localStorage so it survives a reload too.
  const { filters, updateFilter, replaceFilters, resetFilters } = useSharedFilters();

  // A dashboard widget's drill-down row/cell click replaces the whole shared
  // filter set with the clicked dimension(s) and jumps to Задачи.
  const navigateToTasks = useCallback((partialFilters) => {
    replaceFilters(partialFilters);
    setActiveTab('tasks');
  }, [replaceFilters]);

  // assumeConnected: the ?jira=connected redirect already proved the OAuth
  // flow succeeded, so a transient failure of this status check shouldn't
  // flip the UI back to "not connected".
  const refreshJiraStatus = useCallback(async (assumeConnected = false) => {
    try {
      const status = await getJiraStatus();
      setJiraStatus(status);

      if (status.connected) {
        // The DB already has whatever was last synced — load it straight
        // away so a page refresh lands on the dashboard, not a connect screen.
        try {
          setStats(await getJiraIssues());
        } catch {
          // No data yet (first connect, before any sync) — Dashboard's own
          // sync button covers that; leave stats null.
        }

        try {
          const { mapping } = await getFieldMapping();
          // First time connecting with nothing mapped yet — walk the user
          // straight into the field-mapping step instead of a silent no-op sync.
          if (!mapping || Object.keys(mapping).length === 0) {
            setShowFieldMapping(true);
          }
        } catch {
          // Field mapping is optional — sync falls back to null/labels either way.
        }
      }
    } catch {
      if (assumeConnected) {
        setJiraStatus((prev) => ({ issueCount: 0, lastSyncedAt: null, ...prev, connected: true }));
      } else {
        setJiraStatus({ connected: false, issueCount: 0, lastSyncedAt: null });
      }
    }
  }, []);

  // Shared by the "Синхронизировать данные из Jira" button on the connect
  // screen and the "Обновить данные из Jira" button on the dashboard itself.
  const syncFromJira = useCallback(async (force = false) => {
    await syncJira(force);
    const data = await getJiraIssues();
    setStats(data);
    setJiraStatus((prev) => ({ ...(prev || {}), connected: true, issueCount: data.total, lastSyncedAt: data.lastSyncedAt }));
    return data;
  }, []);

  useEffect(() => {
    if (justConnected && window.location.search.includes('jira=')) {
      const params = new URLSearchParams(window.location.search);
      params.delete('jira');
      const newSearch = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (newSearch ? `?${newSearch}` : ''));
    }

    refreshJiraStatus(justConnected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fieldMappingOverlay = showFieldMapping && jiraStatus?.connected && (
    <FieldMapping
      onClose={() => setShowFieldMapping(false)}
      onSaved={() => setShowFieldMapping(false)}
    />
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <TopNav activeTab={activeTab} onChangeTab={setActiveTab} />

      <main className="p-6">
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            {justConnected && (
              <div className="max-w-2xl mx-auto bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg px-4 py-3 flex items-center justify-between">
                <span>Jira успешно подключена</span>
                <button
                  onClick={() => setJustConnected(false)}
                  className="text-green-600 hover:text-green-800"
                >
                  ×
                </button>
              </div>
            )}

            {!jiraStatus ? (
              <p className="text-center text-gray-400 text-sm mt-16">Загрузка...</p>
            ) : !jiraStatus.connected ? (
              <>
                <JiraPanel
                  status={jiraStatus}
                  onStatusChange={setJiraStatus}
                  onDataLoaded={setStats}
                  onConfigureFields={undefined}
                />
                {fieldMappingOverlay}
              </>
            ) : (
              <>
                {fieldMappingOverlay}
                {stats ? (
                  <Dashboard
                    stats={stats}
                    jiraConnected
                    onSyncJira={syncFromJira}
                    onNavigateToTasks={navigateToTasks}
                    filters={filters}
                    onFilterChange={updateFilter}
                    onResetFilters={resetFilters}
                    siteUrl={jiraStatus?.siteUrl}
                  />
                ) : (
                  <div className="max-w-2xl mx-auto space-y-6">
                    <p className="text-center text-gray-400 text-sm">
                      Данных пока нет — синхронизируйте с Jira.
                    </p>
                    <JiraPanel
                      status={jiraStatus}
                      onStatusChange={setJiraStatus}
                      onDataLoaded={setStats}
                      onConfigureFields={() => setShowFieldMapping(true)}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'tasks' && (
          <Tasks
            jiraConnected={jiraStatus?.connected || false}
            filters={filters}
            onFilterChange={updateFilter}
            onResetFilters={resetFilters}
          />
        )}

        {activeTab === 'teams' && <Teams jiraConnected={jiraStatus?.connected || false} />}

        {activeTab === 'sprints' && <Sprints jiraConnected={jiraStatus?.connected || false} />}

        {activeTab === 'settings' && (
          <Settings jiraStatus={jiraStatus} onStatusChange={setJiraStatus} onDataLoaded={setStats} />
        )}
      </main>
    </div>
  );
}
