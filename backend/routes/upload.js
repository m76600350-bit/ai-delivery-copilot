const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, file.originalname),
});

const upload = multer({
  storage,
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

function parseWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath);
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
    const stats = parseWorkbook(req.file.path);
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
