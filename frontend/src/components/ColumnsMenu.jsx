import React, { useEffect, useRef, useState } from 'react';

// The Задачи table's "Ключ"/"Название" columns are always shown (rendered
// with a disabled, checked checkbox rather than omitted entirely, so the
// list still reads as "every column, some toggleable" per the mockup).
// Every other column is optional; `optionalKeys` is COLUMN_DEFS filtered to
// just those, passed in rather than hardcoded here so this stays a generic
// "pick from a list, always-on items included" popover.
export default function ColumnsMenu({ columns, visible, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggle = (key) => {
    if (visible.includes(key)) onChange(visible.filter((k) => k !== key));
    else onChange([...visible, key]);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="text-sm border border-gray-300 rounded px-4 py-2 hover:bg-gray-50"
      >
        Колонки
      </button>

      {isOpen && (
        <div className="absolute right-0 z-20 mt-1 w-64 bg-white border border-gray-200 rounded shadow-lg max-h-80 overflow-y-auto">
          {columns.map((col) => (
            <label
              key={col.key}
              className={`flex items-center gap-2 px-3 py-1.5 text-sm ${col.alwaysOn ? 'text-gray-400' : 'hover:bg-gray-50 cursor-pointer'}`}
            >
              <input
                type="checkbox"
                checked={col.alwaysOn || visible.includes(col.key)}
                disabled={col.alwaysOn}
                onChange={() => toggle(col.key)}
                className="rounded border-gray-300"
              />
              <span className="truncate">{col.label}{col.alwaysOn ? ' (всегда включено)' : ''}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
