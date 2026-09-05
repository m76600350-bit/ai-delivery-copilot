const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');

const router = express.Router();

// Serverless environments (e.g. Vercel) only allow writes under /tmp and give
// no guarantee a written file survives past the current invocation, so the
// upload is kept in memory and parsed straight from the buffer.
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xls') {
      return cb(new Error('Only .xlsx/.xls files are allowed'));
    }
    cb(null, true);
  },
});

// In-memory cache of the last parsed stats, so /api/stats works without re-upload
let lastStats = null;

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const byStatus = {};
  const byTeam = {};
  const byType = {};
  const issues = [];

  for (const row of rows) {
    const code = row['Код'] ?? '';
    const name = row['Название'] ?? '';
    const status = row['Статус'] ?? 'Без статуса';
    const labels = row['Метки'] ?? '';
    const cycleTime = row['Cycle time'] ?? '';
    const leadTime = row['LT'] ?? '';
    const createdAt = row['Дата создания'] ?? '';
    const type = row['Тип'] ?? row['Тип задачи'] ?? 'Без типа';

    byStatus[status] = (byStatus[status] || 0) + 1;
    byType[type] = (byType[type] || 0) + 1;

    const teams = String(labels)
      .split(/[,;]/)
      .map((t) => t.trim())
      .filter(Boolean);

    if (teams.length === 0) {
      byTeam['Без команды'] = (byTeam['Без команды'] || 0) + 1;
    } else {
      for (const team of teams) {
        byTeam[team] = (byTeam[team] || 0) + 1;
      }
    }

    issues.push({
      code,
      name,
      status,
      labels,
      cycleTime,
      leadTime,
      createdAt,
      type,
    });
  }

  return {
    total: rows.length,
    byStatus,
    byTeam,
    byType,
    issues,
  };
}

router.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const stats = parseWorkbook(req.file.buffer);
    lastStats = stats;
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', (req, res) => {
  if (!lastStats) {
    return res.status(404).json({ error: 'No data available. Please upload a file first.' });
  }
  res.json(lastStats);
});

module.exports = router;
