import React, { useState } from 'react';
import JiraPanel from './JiraPanel.jsx';
import FieldMapping from './FieldMapping.jsx';

export default function Settings({ jiraStatus, onStatusChange, onDataLoaded }) {
  const [showFieldMapping, setShowFieldMapping] = useState(false);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h2 className="text-lg font-semibold text-gray-800">Настройки</h2>
      <JiraPanel
        status={jiraStatus}
        onStatusChange={onStatusChange}
        onDataLoaded={onDataLoaded}
        onConfigureFields={jiraStatus?.connected ? () => setShowFieldMapping(true) : undefined}
      />
      {showFieldMapping && jiraStatus?.connected && (
        <FieldMapping
          onClose={() => setShowFieldMapping(false)}
          onSaved={() => setShowFieldMapping(false)}
        />
      )}
    </div>
  );
}
