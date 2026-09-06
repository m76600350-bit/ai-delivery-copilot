import React, { useState, useEffect, useCallback } from 'react';
import Upload from './components/Upload.jsx';
import Dashboard from './components/Dashboard.jsx';
import JiraPanel from './components/JiraPanel.jsx';
import { getJiraStatus } from './api.js';

export default function App() {
  const [stats, setStats] = useState(null);
  const [jiraStatus, setJiraStatus] = useState(null);

  const refreshJiraStatus = useCallback(async () => {
    try {
      setJiraStatus(await getJiraStatus());
    } catch {
      setJiraStatus({ connected: false, issueCount: 0, lastSyncedAt: null });
    }
  }, []);

  useEffect(() => {
    refreshJiraStatus();
  }, [refreshJiraStatus]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-800">Delivery Dashboard</h1>
      </header>

      <main className="p-6">
        {!stats ? (
          <div className="space-y-6">
            <JiraPanel status={jiraStatus} onStatusChange={setJiraStatus} onDataLoaded={setStats} />
            <Upload onUploaded={setStats} />
          </div>
        ) : (
          <Dashboard stats={stats} onReset={() => setStats(null)} />
        )}
      </main>
    </div>
  );
}
