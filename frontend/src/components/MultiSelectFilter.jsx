import React, { useEffect, useRef, useState } from 'react';

// Each entry in `options` is either a plain string (value === label) or
// { value, label } when the stored value and the displayed text need to
// differ — e.g. a Jira project key stored/sent to the API, with the
// project's full name shown to the user.
function normalizeOption(opt) {
  return typeof opt === 'string' ? { value: opt, label: opt } : opt;
}

export default function MultiSelectFilter({ label, options, selected, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);
  const normalizedOptions = options.map(normalizeOption);
  const labelByValue = Object.fromEntries(normalizedOptions.map((o) => [o.value, o.label]));

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleValue = (value) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const buttonLabel =
    selected.length === 0
      ? label
      : selected.length === 1
        ? (labelByValue[selected[0]] ?? selected[0])
        : `${label}: ${selected.length}`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className={`border rounded px-3 py-1.5 text-sm whitespace-nowrap ${
          selected.length > 0
            ? 'border-blue-300 bg-blue-50 text-blue-700'
            : 'border-gray-300 text-gray-700'
        }`}
      >
        {buttonLabel} <span className="text-xs">▾</span>
      </button>

      {isOpen && (
        <div className="absolute z-10 mt-1 w-56 bg-white border border-gray-200 rounded shadow-lg max-h-64 overflow-y-auto">
          {normalizedOptions.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-400">Нет значений</p>
          )}
          {normalizedOptions.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => toggleValue(opt.value)}
                className="rounded border-gray-300"
              />
              <span className="truncate">{opt.label}</span>
            </label>
          ))}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full text-left px-3 py-1.5 text-xs text-blue-600 hover:underline border-t border-gray-100"
            >
              Сбросить
            </button>
          )}
        </div>
      )}
    </div>
  );
}
