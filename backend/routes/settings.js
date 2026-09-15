const express = require('express');
const { THRESHOLD_DEFS, getThresholds, setThreshold, resetThresholds } = require('../lib/metricThresholds');

const router = express.Router();

// GET /api/settings/metric-thresholds — defs (key/label/description/default,
// static) + values (current, from the DB) for the "Метрики и SLA" screen.
router.get('/metric-thresholds', async (req, res) => {
  try {
    const values = await getThresholds();
    res.json({
      defs: THRESHOLD_DEFS.map(({ key, label, description, default: def }) => ({ key, label, description, default: def })),
      values,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/metric-thresholds/:key — body: { value: number }.
// Applies immediately, no separate save step (matches the rest of Настройки).
router.put('/metric-thresholds/:key', async (req, res) => {
  try {
    await setThreshold(req.params.key, Number(req.body?.value));
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/settings/metric-thresholds/reset — restores every threshold to
// its hardcoded-default value in one call.
router.post('/metric-thresholds/reset', async (req, res) => {
  try {
    await resetThresholds();
    const values = await getThresholds();
    res.json({ values });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
