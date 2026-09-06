import React, { useEffect, useState } from 'react';
import { getJiraFields, getFieldMapping, saveFieldMapping } from '../api.js';

const CANONICAL_FIELDS = [
  { key: 'sprint', label: 'Sprint' },
  { key: 'team', label: 'Team' },
  { key: 'story_points', label: 'Story Points' },
];

export default function FieldMapping({ onClose, onSaved }) {
  const [fields, setFields] = useState([]);
  const [mapping, setMapping] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [fieldsData, mappingData] = await Promise.all([getJiraFields(), getFieldMapping()]);
        setFields(fieldsData);
        setMapping(mappingData.mapping || {});
      } catch (err) {
        setError(err.response?.data?.error || 'Не удалось загрузить список полей Jira');
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const handleChange = (key, value) => {
    setSaved(false);
    setMapping((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const result = await saveFieldMapping(mapping);
      setMapping(result.mapping || mapping);
      setSaved(true);
      onSaved?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось сохранить маппинг полей');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-gray-700">Настройка полей Jira</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Сопоставьте наши внутренние поля с полями вашего проекта в Jira.
          </p>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-sm text-gray-400 hover:text-gray-600">
            Закрыть
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Загрузка списка полей...</p>
      ) : (
        <div className="space-y-3">
          {CANONICAL_FIELDS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-3">
              <label className="w-32 text-sm text-gray-600 shrink-0">{label}</label>
              <select
                value={mapping[key] || ''}
                onChange={(e) => handleChange(key, e.target.value)}
                className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm"
              >
                <option value="">Не сопоставлено</option>
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.id})
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && !error && <p className="text-sm text-green-600">Маппинг сохранён.</p>}

      <button
        onClick={handleSave}
        disabled={isSaving || isLoading}
        className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {isSaving ? 'Сохранение...' : 'Сохранить маппинг'}
      </button>
    </div>
  );
}
