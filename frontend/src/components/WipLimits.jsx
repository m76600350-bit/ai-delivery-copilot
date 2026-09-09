import React, { useEffect, useRef, useState } from 'react';
import { getWipLimits, saveWipLimit } from '../api.js';

// Debounces each status's number input the same way SyncFilter's "Период"
// field does — a status limit is edited by typing digits, not by a single
// discrete click, so saving on every keystroke would be wasteful.
const SAVE_DELAY_MS = 600;

export default function WipLimits() {
  const [statuses, setStatuses] = useState([]);
  const [values, setValues] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const saveTimers = useRef({});

  useEffect(() => {
    getWipLimits()
      .then((data) => {
        setStatuses(data.statuses);
        const initial = {};
        for (const status of data.statuses) {
          initial[status] = data.limits[status] == null ? '' : String(data.limits[status]);
        }
        setValues(initial);
      })
      .catch((err) => setError(err.response?.data?.error || 'Не удалось загрузить WIP-лимиты'))
      .finally(() => setIsLoading(false));

    return () => {
      Object.values(saveTimers.current).forEach(clearTimeout);
    };
  }, []);

  const handleChange = (status, raw) => {
    setValues((prev) => ({ ...prev, [status]: raw }));
    clearTimeout(saveTimers.current[status]);
    saveTimers.current[status] = setTimeout(async () => {
      try {
        const parsed = raw.trim() === '' ? null : Math.max(0, parseInt(raw, 10) || 0);
        await saveWipLimit(status, parsed);
      } catch (err) {
        setError(err.response?.data?.error || 'Не удалось сохранить лимит');
      }
    }, SAVE_DELAY_MS);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-gray-700">WIP-лимиты</h3>
        <p className="text-xs text-gray-400 mt-0.5">
          Лимит задач в статусе «в работе» на команду. Пусто = без лимита. Изменения применяются сразу.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Загрузка...</p>
      ) : statuses.length === 0 ? (
        <p className="text-xs text-gray-400 italic">
          Статусы «в работе» появятся здесь после первой синхронизации с Jira.
        </p>
      ) : (
        <div className="space-y-2">
          {statuses.map((status) => (
            <div key={status} className="flex items-center justify-between gap-4">
              <span className="text-sm text-gray-700">{status}</span>
              <input
                type="number"
                min="0"
                placeholder="без лимита"
                value={values[status] ?? ''}
                onChange={(e) => handleChange(status, e.target.value)}
                className="w-32 border border-gray-300 rounded px-3 py-1.5 text-sm text-right"
              />
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
