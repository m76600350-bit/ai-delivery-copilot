# Delivery Dashboard

Дашборд для анализа выгрузок задач из Kaiten/Jira-подобных систем (XLSX).

## Структура

```
ai-delivery-copilot/
├── backend/            # Node.js + Express API
│   ├── server.js
│   ├── package.json
│   └── routes/
│       └── upload.js   # POST /api/upload, GET /api/stats
├── frontend/           # React + Vite + Tailwind
│   ├── package.json
│   ├── index.html
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   ├── index.css
│   │   └── components/
│   │       ├── Upload.jsx
│   │       └── Dashboard.jsx
│   └── public/
│       └── index.html
└── README.md
```

## Запуск

### Backend

```bash
cd backend
npm install
npm start
```

Сервер поднимется на `http://localhost:5000`.

> На macOS порт 5000 может быть занят системным AirPlay Receiver (ControlCenter). Если при старте видите `EADDRINUSE`, либо отключите AirPlay Receiver в System Settings → General → AirDrop & Handoff, либо запустите backend с другим портом: `PORT=5050 npm start` (и поменяйте `/api` proxy в `frontend/vite.config.js` соответственно).

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Приложение поднимется на `http://localhost:3000` (запросы к `/api/*` проксируются на backend).

## API

- `POST /api/upload` — принимает `multipart/form-data` с полем `file` (.xlsx/.xls), парсит его и возвращает статистику.
- `GET /api/stats` — возвращает статистику последнего загруженного файла.

Ожидаемые колонки в файле: `Код`, `Название`, `Статус`, `Метки`, `Cycle time`, `LT`, `Дата создания`, `Тип`/`Тип задачи`.

Ответ:

```json
{
  "total": 123,
  "byStatus": { "В работе": 10, "Готово": 50 },
  "byTeam": { "Backend": 30, "Frontend": 20 },
  "byType": { "Баг": 15, "Фича": 40 },
  "issues": [ { "code": "...", "name": "...", "status": "...", "labels": "...", "cycleTime": "...", "leadTime": "...", "createdAt": "...", "type": "..." } ]
}
```

## Примечания

- Колонка `Метки` может содержать несколько команд через запятую/точку с запятой — каждая учитывается отдельно в `byTeam`.
- `frontend/public/index.html` — статический шаблон по требованиям структуры; фактический entry point для Vite — `frontend/index.html`.
