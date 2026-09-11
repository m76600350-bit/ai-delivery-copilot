import React, { useState } from 'react';

// The "···" menu every Dashboard widget carries, with a single "Удалить
// виджет" action — no drag&drop/reorder/customize, per spec, so this is
// intentionally minimal rather than a general-purpose menu component.
export default function WidgetMenu({ onRemove }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Настройки виджета"
        className="text-gray-400 hover:text-gray-700 text-sm leading-none px-1"
      >
        ···
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-44 bg-white border border-gray-200 rounded shadow-lg z-20">
            <button
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
              className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-gray-50"
            >
              Удалить виджет
            </button>
          </div>
        </>
      )}
    </div>
  );
}
