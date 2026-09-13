import React, { useState } from 'react';

// The funnel icon every non-stats-card Dashboard widget carries (4.3) —
// opens a small popover of LOCAL filters that override the dashboard's own
// shared filter bar for this one widget only, without touching global state.
// Each widget supplies its own controls as children; this just owns the
// open/close chrome, shared the same way WidgetMenu owns the "···" chrome.
export default function WidgetFilterPopover({ active, children }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Фильтр виджета"
        className={`text-sm leading-none px-1 ${active ? 'text-blue-600' : 'text-gray-400 hover:text-gray-700'}`}
      >
        ▽
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-60 bg-white border border-gray-200 rounded shadow-lg z-20 p-3 space-y-3">
            {children}
          </div>
        </>
      )}
    </div>
  );
}
