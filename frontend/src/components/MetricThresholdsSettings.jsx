import React, { useEffect, useState } from 'react';
import { getMetricThresholds, setMetricThreshold, resetMetricThresholds } from '../api.js';

// A per-row debounce (not a form-wide save button, per spec 3 — "изменения
// применяются сразу, как остальные настройки в проекте") so typing a number
// doesn't fire a request per keystroke.
function useDebouncedCommit(delayMs, commit) {
  const timerRef = React.useRef(null);
  return (value) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => commit(value), delayMs);
  };
}

function ThresholdRow({ def, value, onChange, saveState }) {
  const [draft, setDraft] = useState(String(value));
  const commit = useDebouncedCommit(500, (v) => onChange(def.key, v));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const handleInput = (e) => {
    const raw = e.target.value;
    setDraft(raw);
    const num = Number(raw);
    if (raw !== '' && Number.isFinite(num)) commit(num);
  };

  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-gray-100 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-700">{def.label}</p>
        <p className="text-xs text-gray-400 mt-0.5">{def.description}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {saveState === 'saving' && <span className="text-xs text-gray-400">Сохранение...</span>}
        {saveState === 'error' && <span className="text-xs text-red-600">Ошибка</span>}
        <input
          type="number"
          step="any"
          value={draft}
          onChange={handleInput}
          className="w-24 border border-gray-300 rounded px-2 py-1.5 text-sm text-right"
        />
      </div>
    </div>
  );
}

export default function MetricThresholdsSettings() {
  const [defs, setDefs] = useState([]);
  const [values, setValues] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveStateByKey, setSaveStateByKey] = useState({});
  const [isResetting, setIsResetting] = useState(false);

  const load = () => {
    setIsLoading(true);
    setError(null);
    getMetricThresholds()
      .then((data) => {
        setDefs(data.defs);
        setValues(data.values);
      })
      .catch((err) => setError(err.response?.data?.error || 'Не удалось загрузить настройки'))
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const handleChange = async (key, value) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaveStateByKey((prev) => ({ ...prev, [key]: 'saving' }));
    try {
      await setMetricThreshold(key, value);
      setSaveStateByKey((prev) => ({ ...prev, [key]: null }));
    } catch (err) {
      setSaveStateByKey((prev) => ({ ...prev, [key]: 'error' }));
    }
  };

  const handleReset = async () => {
    setIsResetting(true);
    setError(null);
    try {
      const data = await resetMetricThresholds();
      setValues(data.values);
      setSaveStateByKey({});
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось сбросить настройки');
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-700">Метрики и SLA</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            Пороги, по которым приложение считает задачу "зависшей", команду — "в риске"/"перегруженной", а исполнителя —
            перегруженным. Используются в разделах «Дашборд» («Требует внимания»), «Команды» и «Спринты».
          </p>
        </div>
        <button
          onClick={handleReset}
          disabled={isResetting || isLoading}
          className="text-sm border border-gray-300 rounded px-4 py-2 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
        >
          {isResetting ? 'Сброс...' : 'Сбросить к значениям по умолчанию'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {isLoading ? (
        <p className="text-sm text-gray-400">Загрузка...</p>
      ) : (
        <div>
          {defs.map((def) => (
            <ThresholdRow
              key={def.key}
              def={def}
              value={values[def.key] ?? def.default}
              onChange={handleChange}
              saveState={saveStateByKey[def.key]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
