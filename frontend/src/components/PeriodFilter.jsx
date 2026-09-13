import React, { useEffect, useRef, useState } from 'react';

export const PERIOD_PRESETS = [
  { value: 'all', label: 'Всё время' },
  { value: '7', label: 'Последние 7 дней' },
  { value: '30', label: 'Последние 30 дней' },
  { value: '90', label: 'Последние 90 дней' },
];

function presetLabel(period) {
  return PERIOD_PRESETS.find((p) => p.value === period)?.label;
}

// The shared "Период" control (4.1) — a preset (Всё время/7/30/90) or an
// arbitrary custom date range. `value` is { period, periodStart, periodEnd }
// (periodStart/periodEnd only meaningful when period === 'custom', as
// 'YYYY-MM-DD' strings); `onChange` receives the same shape back.
export default function PeriodFilter({ period, periodStart, periodEnd, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(periodStart || '');
  const [draftEnd, setDraftEnd] = useState(periodEnd || '');
  const ref = useRef(null);

  useEffect(() => {
    setDraftStart(periodStart || '');
    setDraftEnd(periodEnd || '');
  }, [periodStart, periodEnd]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectPreset = (value) => {
    onChange({ period: value, periodStart: null, periodEnd: null });
    setIsOpen(false);
  };

  const applyCustom = () => {
    if (!draftStart || !draftEnd) return;
    onChange({ period: 'custom', periodStart: draftStart, periodEnd: draftEnd });
    setIsOpen(false);
  };

  const isActive = period !== 'all';
  const buttonLabel =
    period === 'custom'
      ? periodStart && periodEnd
        ? `${periodStart} — ${periodEnd}`
        : 'Свой период'
      : presetLabel(period) || 'Всё время';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className={`border rounded px-3 py-1.5 text-sm whitespace-nowrap ${
          isActive ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-700'
        }`}
      >
        {buttonLabel} <span className="text-xs">▾</span>
      </button>

      {isOpen && (
        <div className="absolute z-10 mt-1 w-64 bg-white border border-gray-200 rounded shadow-lg p-3 space-y-3">
          <div className="space-y-1">
            {PERIOD_PRESETS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => selectPreset(opt.value)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-gray-50 ${
                  period === opt.value ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="border-t border-gray-100 pt-3 space-y-2">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Свой период</p>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={draftStart}
                onChange={(e) => setDraftStart(e.target.value)}
                className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
              />
              <span className="text-gray-400 text-xs">—</span>
              <input
                type="date"
                value={draftEnd}
                onChange={(e) => setDraftEnd(e.target.value)}
                className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
              />
            </div>
            <button
              onClick={applyCustom}
              disabled={!draftStart || !draftEnd}
              className="w-full text-sm bg-blue-600 text-white rounded px-3 py-1.5 hover:bg-blue-700 disabled:opacity-50"
            >
              Применить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
