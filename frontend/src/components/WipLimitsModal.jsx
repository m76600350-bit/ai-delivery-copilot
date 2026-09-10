import React, { useEffect, useState } from 'react';
import { getTeamsFilters, getWipLimitsForTeam, saveWipLimitsForTeam } from '../api.js';

function Modal({ children, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-xl max-h-[85vh] overflow-y-auto p-6 space-y-4">
        {children}
      </div>
    </div>
  );
}

function buildInitialRows(statuses, limits) {
  const rows = {};
  for (const status of statuses) {
    const existing = limits.filter((l) => l.statusName === status);
    rows[status] = existing.length
      ? existing.map((l) => ({ role: l.role, limitValue: l.limitValue == null ? '' : String(l.limitValue) }))
      : [{ role: '', limitValue: '' }];
  }
  return rows;
}

export default function WipLimitsModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [teams, setTeams] = useState([]);
  const [team, setTeam] = useState('');
  const [config, setConfig] = useState(null); // { statuses, roles }
  const [rows, setRows] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);

  const open = () => {
    setIsOpen(true);
    setTeam('');
    setConfig(null);
    setError(null);
    getTeamsFilters()
      .then((data) => setTeams(data.teams))
      .catch(() => setTeams([]));
  };

  const close = () => setIsOpen(false);

  useEffect(() => {
    if (!team) {
      setConfig(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    getWipLimitsForTeam(team)
      .then((data) => {
        setConfig(data);
        setRows(buildInitialRows(data.statuses, data.limits));
      })
      .catch((err) => setError(err.response?.data?.error || 'Не удалось загрузить статусы команды'))
      .finally(() => setIsLoading(false));
  }, [team]);

  const updateRow = (status, index, field, value) => {
    setRows((prev) => {
      const next = [...(prev[status] || [])];
      next[index] = { ...next[index], [field]: value };
      return { ...prev, [status]: next };
    });
  };

  const addRole = (status) => {
    setRows((prev) => ({ ...prev, [status]: [...(prev[status] || []), { role: '', limitValue: '' }] }));
  };

  const removeRole = (status, index) => {
    setRows((prev) => {
      const next = (prev[status] || []).filter((_, i) => i !== index);
      return { ...prev, [status]: next.length ? next : [{ role: '', limitValue: '' }] };
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const entries = [];
      for (const [statusName, statusRows] of Object.entries(rows)) {
        for (const row of statusRows) {
          if (!row.role) continue;
          entries.push({ statusName, role: row.role, limitValue: row.limitValue === '' ? null : row.limitValue });
        }
      }
      await saveWipLimitsForTeam(team, entries);
      close();
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось сохранить WIP-лимиты');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 flex items-center justify-between">
      <div>
        <h3 className="text-sm font-medium text-gray-700">Настройка WIP</h3>
        <p className="text-xs text-gray-400 mt-0.5">
          WIP-лимит на человека для каждой пары «статус × роль» — по командам.
        </p>
      </div>
      <button
        onClick={open}
        className="text-sm border border-gray-300 rounded px-4 py-2 hover:bg-gray-50"
      >
        Настроить
      </button>

      {isOpen && (
        <Modal onClose={close}>
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-gray-800">Настройка WIP</h4>
            <button onClick={close} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Выберите команду</label>
            <select
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
            >
              <option value="">— выберите —</option>
              {teams.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {isLoading && <p className="text-sm text-gray-500">Загрузка...</p>}

          {team && !isLoading && config && (
            <>
              {config.statuses.length === 0 ? (
                <p className="text-xs text-gray-400 italic">
                  У этой команды сейчас нет задач в статусах «в работе».
                </p>
              ) : config.roles.length === 0 ? (
                <p className="text-xs text-gray-400 italic">
                  Участникам этой команды ещё не назначены роли — сделайте это в блоке «Команды и роли» выше, затем вернитесь сюда.
                </p>
              ) : (
                <div className="space-y-4">
                  {config.statuses.map((status) => (
                    <div key={status} className="border border-gray-100 rounded p-3 space-y-2">
                      <p className="text-sm font-medium text-gray-700">{status}</p>
                      {(rows[status] || []).map((row, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <select
                            value={row.role}
                            onChange={(e) => updateRow(status, index, 'role', e.target.value)}
                            className="border border-gray-300 rounded px-2 py-1.5 text-sm flex-1"
                          >
                            <option value="">Роль...</option>
                            {config.roles.map((r) => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </select>
                          <input
                            type="number"
                            min="0"
                            placeholder="без лимита"
                            value={row.limitValue}
                            onChange={(e) => updateRow(status, index, 'limitValue', e.target.value)}
                            className="w-32 border border-gray-300 rounded px-2 py-1.5 text-sm"
                          />
                          <span className="text-xs text-gray-400 whitespace-nowrap">на человека</span>
                          {(rows[status] || []).length > 1 && (
                            <button
                              onClick={() => removeRole(status, index)}
                              className="text-gray-400 hover:text-red-600 text-sm"
                              title="Убрать роль"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        onClick={() => addRole(status)}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        + добавить роль
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
            <button onClick={close} className="text-sm border border-gray-300 rounded px-4 py-2 hover:bg-gray-50">
              Отмена
            </button>
            <button
              onClick={handleSave}
              disabled={!team || isSaving}
              className="text-sm bg-blue-600 text-white rounded px-4 py-2 hover:bg-blue-700 disabled:opacity-50"
            >
              {isSaving ? 'Сохранение...' : 'Сохранить'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
