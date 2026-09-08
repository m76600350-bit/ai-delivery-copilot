import React, { useEffect, useRef, useState } from 'react';
import { getSyncFilter, saveSyncFilter } from '../api.js';
import MultiSelectFilter from './MultiSelectFilter.jsx';

// Debounces the "Период" number input so every keystroke doesn't fire a
// save — the dropdowns below save immediately since a checkbox click is
// already a single discrete action, not a stream of them.
const PERIOD_SAVE_DELAY_MS = 600;

export default function SyncFilter() {
  const [filter, setFilter] = useState({ projects: [], issueTypes: [], teams: [], updatedSinceDays: null });
  const [options, setOptions] = useState({ projects: [], issueTypes: [], teams: [] });
  const [periodInput, setPeriodInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const periodSaveTimer = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await getSyncFilter();
        setFilter(data.filter);
        setOptions(data.options);
        setPeriodInput(data.filter.updatedSinceDays == null ? '' : String(data.filter.updatedSinceDays));
      } catch (err) {
        setError(err.response?.data?.error || 'Не удалось загрузить фильтр синхронизации');
      } finally {
        setIsLoading(false);
      }
    })();
    return () => clearTimeout(periodSaveTimer.current);
  }, []);

  const persist = async (next) => {
    setIsSaving(true);
    setError(null);
    try {
      const result = await saveSyncFilter(next);
      setFilter(result.filter);
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось сохранить фильтр');
    } finally {
      setIsSaving(false);
    }
  };

  const updateField = (field, value) => {
    const next = { ...filter, [field]: value };
    setFilter(next);
    persist(next);
  };

  const handlePeriodChange = (e) => {
    const raw = e.target.value;
    setPeriodInput(raw);
    clearTimeout(periodSaveTimer.current);
    periodSaveTimer.current = setTimeout(() => {
      const parsed = raw.trim() === '' ? null : Math.max(0, parseInt(raw, 10) || 0);
      const next = { ...filter, updatedSinceDays: parsed };
      setFilter(next);
      persist(next);
    }, PERIOD_SAVE_DELAY_MS);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-gray-700">Фильтр синхронизации</h3>
        <p className="text-xs text-gray-400 mt-0.5">
          Определяет, какие задачи попадают в базу при следующей синхронизации. Изменения применяются сразу.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Загрузка...</p>
      ) : (
        <div className="flex flex-wrap gap-3 items-start">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Проект</label>
            <MultiSelectFilter
              label="Все проекты"
              options={options.projects.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` }))}
              selected={filter.projects}
              onChange={(v) => updateField('projects', v)}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Тип задачи</label>
            <MultiSelectFilter
              label="Все типы"
              options={options.issueTypes}
              selected={filter.issueTypes}
              onChange={(v) => updateField('issueTypes', v)}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Команда</label>
            <MultiSelectFilter
              label="Все команды"
              options={options.teams}
              selected={filter.teams}
              onChange={(v) => updateField('teams', v)}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Период (дней)</label>
            <input
              type="number"
              min="0"
              placeholder="Не ограничено"
              value={periodInput}
              onChange={handlePeriodChange}
              className="w-36 border border-gray-300 rounded px-3 py-1.5 text-sm"
            />
          </div>
        </div>
      )}

      {isSaving && <p className="text-xs text-gray-400">Сохранение...</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {options.issueTypes.length === 0 && options.teams.length === 0 && !isLoading && (
        <p className="text-xs text-gray-400 italic">
          Списки типов и команд заполняются из уже синхронизированных задач — выполните первую синхронизацию, чтобы они появились.
        </p>
      )}
    </div>
  );
}
