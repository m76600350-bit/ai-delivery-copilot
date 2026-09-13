// Shared "Период" resolution for the unified filter bar (Дашборд/Задачи/
// Команды/Отчёты) — a preset ('7'/'30'/'90' days back from now, or 'all'
// for no bound) OR an arbitrary custom range (period='custom' +
// periodStart/periodEnd as 'YYYY-MM-DD'). Used identically everywhere a
// query needs "issues created within this window" so the four screens can
// never disagree about what a given Период selection means.
const PRESET_DAYS = { '7': 7, '30': 30, '90': 90 };

function parseDateOnly(value, endOfDay) {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Returns { start: Date|null, end: Date|null } — both null means "всё
// время" (no bound at all).
function resolvePeriodRange(query) {
  if (query.period === 'custom') {
    return {
      start: parseDateOnly(query.periodStart, false),
      end: parseDateOnly(query.periodEnd, true),
    };
  }
  const days = PRESET_DAYS[query.period];
  if (!days) return { start: null, end: null };
  return { start: new Date(Date.now() - days * 86400000), end: null };
}

module.exports = { resolvePeriodRange };
