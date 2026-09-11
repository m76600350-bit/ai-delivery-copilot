import React from 'react';

// Descriptions + display order for the fixed widget catalog — no
// categories/search/filter in this modal (only 5 widgets exist, that'd be
// overkill), and no "Настройка" panel (name/grouping/width) either, since
// nothing about a widget is customizable — it's either on the dashboard or
// it isn't.
export const WIDGET_CATALOG = [
  { type: 'stats_cards', title: 'Карточки статистики', description: 'Всего задач / Статусов / Команд / Типов' },
  { type: 'by_status', title: 'По статусу', description: 'Разбивка задач по статусу' },
  { type: 'by_team', title: 'По команде', description: 'Разбивка задач по команде' },
  { type: 'by_type', title: 'По типу', description: 'Разбивка задач по типу' },
  { type: 'attention', title: 'Требует внимания', description: 'Блокеры и зависшие задачи (aging WIP)' },
];

export default function WidgetLibraryModal({ widgets, onAdd, onClose }) {
  const enabledTypes = new Set(widgets.filter((w) => w.enabled).map((w) => w.widgetType));

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-800">Библиотека виджетов</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ×
          </button>
        </div>

        <div className="p-6 space-y-3">
          {WIDGET_CATALOG.map((w) => {
            const added = enabledTypes.has(w.type);
            return (
              <div
                key={w.type}
                className="flex items-center justify-between gap-4 border border-gray-100 rounded-lg p-4"
              >
                <div>
                  <p className="text-sm font-medium text-gray-800">{w.title}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{w.description}</p>
                </div>
                <button
                  onClick={() => onAdd(w.type)}
                  disabled={added}
                  className="shrink-0 text-sm border border-gray-300 rounded px-4 py-1.5 hover:bg-gray-50 disabled:opacity-50 disabled:hover:bg-white whitespace-nowrap"
                >
                  {added ? 'Уже на дашборде' : 'Добавить'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
