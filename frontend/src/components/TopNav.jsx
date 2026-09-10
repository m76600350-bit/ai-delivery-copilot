import React from 'react';

const TABS = [
  { key: 'dashboard', label: 'Дашборд', active: true },
  { key: 'tasks', label: 'Задачи', active: true },
  { key: 'teams', label: 'Команды', active: true },
  { key: 'sprints', label: 'Спринты', active: true },
  { key: 'reports', label: 'Отчёты', active: false },
  { key: 'settings', label: 'Настройки', active: true },
];

export default function TopNav({ activeTab, onChangeTab }) {
  return (
    <header className="bg-white border-b border-gray-200 px-6 py-3">
      <div className="max-w-7xl mx-auto flex items-center gap-8">
        <span className="text-sm font-bold tracking-wide text-gray-800">DELIVERY BOARD</span>
        <nav className="flex items-center gap-1">
          {TABS.map((tab) =>
            tab.active ? (
              <button
                key={tab.key}
                onClick={() => onChangeTab(tab.key)}
                className={`px-3 py-1.5 rounded text-sm font-medium ${
                  activeTab === tab.key
                    ? 'bg-gray-100 text-gray-900'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {tab.label}
              </button>
            ) : (
              <span
                key={tab.key}
                title="Скоро"
                className="px-3 py-1.5 rounded text-sm font-medium text-gray-300 cursor-not-allowed select-none"
              >
                {tab.label}
              </span>
            )
          )}
        </nav>
      </div>
    </header>
  );
}
