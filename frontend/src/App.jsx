import React, { useState, useEffect, useCallback } from 'react';
import Upload from './components/Upload.jsx';
import Dashboard from './components/Dashboard.jsx';
import JiraPanel from './components/JiraPanel.jsx';
import FieldMapping from './components/FieldMapping.jsx';
import { getJiraStatus, getFieldMapping } from './api.js';

export default function App() {
  const [stats, setStats] = useState(null);
  const [jiraStatus, setJiraStatus] = useState(null);
  const [showFieldMapping, setShowFieldMapping] = useState(false);

  const refreshJiraStatus = useCallback(async () => {
    try {
      const status = await getJiraStatus();
      setJiraStatus(status);

      if (status.connected) {
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
            <JiraPanel
              status={jiraStatus}
              onStatusChange={setJiraStatus}
              onDataLoaded={setStats}
              onConfigureFields={jiraStatus?.connected ? () => setShowFieldMapping(true) : undefined}
            />
            {showFieldMapping && jiraStatus?.connected && (
              <FieldMapping
                onClose={() => setShowFieldMapping(false)}
                onSaved={() => setShowFieldMapping(false)}
              />
            )}
            <Upload onUploaded={setStats} />
          </div>
        ) : (
          <Dashboard stats={stats} onReset={() => setStats(null)} />
        )}
      </main>
    </div>
  );
}
