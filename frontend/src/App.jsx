import React, { useState } from 'react';
import Upload from './components/Upload.jsx';
import Dashboard from './components/Dashboard.jsx';

export default function App() {
  const [stats, setStats] = useState(null);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-800">Delivery Dashboard</h1>
      </header>

      <main className="p-6">
        {!stats ? (
          <Upload onUploaded={setStats} />
        ) : (
          <Dashboard stats={stats} onReset={() => setStats(null)} />
        )}
      </main>
    </div>
  );
}
