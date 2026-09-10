import React, { useEffect, useRef, useState } from 'react';
import { getTeamRoles, saveTeamRole } from '../api.js';

const PRESET_ROLES = ['Аналитик', 'Разработчик', 'QA', 'Дизайнер'];
const CUSTOM = '__custom__';

// A member's role select shows one of PRESET_ROLES, "Другое" (which reveals
// a free-text input), or blank ("роль не задана"). A role already saved
// that isn't one of the presets (typed in via "Другое" previously) still
// needs to render as "Другое" + that text, not silently disappear.
function modeFor(role) {
  if (!role) return { select: '', text: '' };
  if (PRESET_ROLES.includes(role)) return { select: role, text: '' };
  return { select: CUSTOM, text: role };
}

export default function TeamRoles() {
  const [teams, setTeams] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  // Keyed by `${team} ${assignee}` -> { select, text }.
  const [state, setState] = useState({});
  const saveTimers = useRef({});

  useEffect(() => {
    getTeamRoles()
      .then((data) => {
        setTeams(data.teams);
        const next = {};
        for (const t of data.teams) {
          for (const m of t.members) {
            next[`${t.team} ${m.assignee}`] = modeFor(m.role);
          }
        }
        setState(next);
      })
      .catch((err) => setError(err.response?.data?.error || 'Не удалось загрузить список команд'))
      .finally(() => setIsLoading(false));

    return () => {
      Object.values(saveTimers.current).forEach(clearTimeout);
    };
  }, []);

  const persist = async (team, assignee, role) => {
    try {
      await saveTeamRole(team, assignee, role);
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось сохранить роль');
    }
  };

  const handleSelectChange = (team, assignee, value) => {
    const key = `${team} ${assignee}`;
    setState((prev) => ({ ...prev, [key]: { select: value, text: '' } }));
    if (value !== CUSTOM) {
      persist(team, assignee, value);
    }
    // Selecting "Другое" waits for text input before saving anything.
  };

  const handleTextChange = (team, assignee, raw) => {
    const key = `${team} ${assignee}`;
    setState((prev) => ({ ...prev, [key]: { select: CUSTOM, text: raw } }));
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => {
      persist(team, assignee, raw.trim());
    }, 600);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-gray-700">Команды и роли</h3>
        <p className="text-xs text-gray-400 mt-0.5">
          Список участников собран из уже загруженных задач. Без роли участник не учитывается в расчёте WIP-лимита команды.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Загрузка...</p>
      ) : teams.length === 0 ? (
        <p className="text-xs text-gray-400 italic">Участники появятся здесь после первой синхронизации с Jira.</p>
      ) : (
        <div className="space-y-5">
          {teams.map((t) => (
            <div key={t.team}>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">{t.team}</p>
              <div className="space-y-2">
                {t.members.map((m) => {
                  const key = `${t.team} ${m.assignee}`;
                  const { select, text } = state[key] || modeFor(m.role);
                  return (
                    <div key={key} className="flex items-center gap-3">
                      <span className="text-sm text-gray-700 flex-1 min-w-[160px]">
                        {m.assignee}
                        {!select && <span className="text-xs text-gray-400 ml-2">роль не задана</span>}
                      </span>
                      <select
                        value={select}
                        onChange={(e) => handleSelectChange(t.team, m.assignee, e.target.value)}
                        className="border border-gray-300 rounded px-3 py-1.5 text-sm w-40"
                      >
                        <option value="">Не задана</option>
                        {PRESET_ROLES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                        <option value={CUSTOM}>Другое...</option>
                      </select>
                      {select === CUSTOM && (
                        <input
                          type="text"
                          placeholder="своя роль"
                          value={text}
                          onChange={(e) => handleTextChange(t.team, m.assignee, e.target.value)}
                          className="border border-gray-300 rounded px-3 py-1.5 text-sm w-36"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
