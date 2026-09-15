const { ensureSchema, getPool } = require('../db');

// The canonical list of every threshold/multiplier the app used to hardcode
// — now stored in metric_thresholds (see db.js) and editable from Настройки
// → "Метрики и SLA". `default` here is what db.js seeds a fresh row with AND
// what "Сбросить к значениям по умолчанию" restores; `label`/`description`
// are exactly what the settings UI renders, so there's one place to update
// if a threshold's meaning or default ever changes.
const THRESHOLD_DEFS = [
  {
    key: 'aging_wip_ratio_threshold',
    default: 0.9,
    label: 'Aging WIP: порог зависания',
    description: 'Во сколько раз текущее время в работе должно превысить эталонный cycle time, чтобы задача считалась "зависшей".',
  },
  {
    key: 'health_wip_signal_threshold',
    default: 1.0,
    label: 'Здоровье команды: превышение WIP-лимита',
    description: 'Во сколько раз текущий WIP должен превысить лимит команды, чтобы сработал сигнал "WIP" в разделе «Команды».',
  },
  {
    key: 'health_cycle_time_signal_threshold',
    default: 1.3,
    label: 'Здоровье команды: рост Cycle Time',
    description: 'Во сколько раз недавний средний Cycle Time команды должен превысить её собственный исторический, чтобы сработал сигнал "Cycle Time".',
  },
  {
    key: 'health_velocity_signal_threshold',
    default: 0.7,
    label: 'Здоровье команды: просадка Velocity',
    description: 'Ниже какой доли от среднего по предыдущим спринтам должна упасть Velocity последнего спринта, чтобы сработал сигнал "Velocity".',
  },
  {
    key: 'health_risk_signal_count',
    default: 1,
    label: 'Здоровье команды: сигналов для статуса "риск"',
    description: 'Сколько из трёх сигналов (WIP/Cycle Time/Velocity) должны сработать, чтобы команде присвоили статус "риск".',
  },
  {
    key: 'health_overload_signal_count',
    default: 2,
    label: 'Здоровье команды: сигналов для статуса "перегруз"',
    description: 'Сколько из трёх сигналов должны сработать, чтобы команде присвоили статус "перегруз" вместо "риск".',
  },
  {
    key: 'workload_normal_max',
    default: 3,
    label: 'Загрузка людей: макс. задач для статуса "норма"',
    description: 'Максимум задач в работе на одного исполнителя, при котором его загрузка считается "норма".',
  },
  {
    key: 'workload_at_limit_max',
    default: 6,
    label: 'Загрузка людей: макс. задач для статуса "на пределе"',
    description: 'Максимум задач в работе на исполнителя для статуса "на пределе"; больше этого — "перегруз".',
  },
  {
    key: 'review_stuck_days_threshold',
    default: 3,
    label: 'Дней в статусе ревью до "зависла"',
    description: 'Сколько дней подряд задача может находиться в статусе ревью, прежде чем попадёт в риски спринта как "висит на ревью".',
  },
];

const DEFAULTS = Object.fromEntries(THRESHOLD_DEFS.map((d) => [d.key, d.default]));
const VALID_KEYS = new Set(THRESHOLD_DEFS.map((d) => d.key));

// Returns { [key]: number } for every known threshold — DB value if a row
// exists, DEFAULTS otherwise (so a threshold introduced after a user's
// install first ran, or a row somehow missing, never leaves a caller with
// `undefined` instead of a usable number).
async function getThresholds() {
  await ensureSchema();
  const { rows } = await getPool().query('SELECT key, value FROM metric_thresholds');
  const values = { ...DEFAULTS };
  for (const row of rows) {
    if (VALID_KEYS.has(row.key)) values[row.key] = Number(row.value);
  }
  return values;
}

async function setThreshold(key, value) {
  if (!VALID_KEYS.has(key)) {
    const err = new Error(`Unknown threshold key: ${key}`);
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(value)) {
    const err = new Error('value must be a finite number');
    err.status = 400;
    throw err;
  }
  await ensureSchema();
  await getPool().query(
    `INSERT INTO metric_thresholds (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value]
  );
}

async function resetThresholds() {
  await ensureSchema();
  const pool = getPool();
  for (const def of THRESHOLD_DEFS) {
    await pool.query(
      `INSERT INTO metric_thresholds (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [def.key, def.default]
    );
  }
}

module.exports = { THRESHOLD_DEFS, DEFAULTS, getThresholds, setThreshold, resetThresholds };
