# Delivery Dashboard

Дашборд для анализа выгрузок задач из Kaiten/Jira-подобных систем (XLSX).

## Структура

```
ai-delivery-copilot/
├── backend/            # Node.js + Express API
│   ├── server.js
│   ├── db.js            # Postgres pool + schema creation
│   ├── package.json
│   ├── lib/
│   │   └── jiraAuth.js   # token storage + refresh
│   └── routes/
│       ├── upload.js     # POST /api/upload, GET /api/stats
│       ├── auth.js       # GET /api/auth/login, /api/auth/callback (Jira OAuth)
│       └── jira.js       # POST /api/jira/sync, GET /api/jira/status, /api/jira/issues
├── frontend/           # React + Vite + Tailwind
│   ├── package.json
│   ├── index.html
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   ├── api.js
│   │   ├── index.css
│   │   └── components/
│   │       ├── Upload.jsx
│   │       ├── Dashboard.jsx
│   │       └── JiraPanel.jsx
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

## Деплой backend на Vercel

`backend/server.js` экспортирует `app` (Express-приложение), а `app.listen()` вызывается только при локальном запуске (`require.main === module`) — при импорте Vercel как serverless-функции `listen` не выполняется.

`backend/vercel.json` направляет все запросы в `server.js` через `@vercel/node`.

Загрузка файла обрабатывается через `multer.memoryStorage()` — буфер парсится напрямую (`XLSX.read(buffer)`), без записи на диск, так как serverless-окружение либо доступно на запись только в `/tmp`, либо файловая система вообще недоступна между вызовами.

**Ограничение:** `lastStats` для `GET /api/stats` хранится в памяти процесса. На serverless это не гарантированно переживает вызовы — «холодный старт» или другой инстанс не будет видеть данные предыдущей загрузки. Для продакшена лучше передавать данные напрямую в ответе `POST /api/upload` (как уже делает фронтенд) либо вынести хранение в внешнее хранилище (БД, Redis, Vercel KV) — именно это и делает интеграция с Jira ниже.

Настройки в панели Vercel: Root Directory — `backend`, Framework Preset — Other.

## Интеграция с Jira Cloud (OAuth 2.0)

### Как это работает

1. **Авторизация** — `GET /api/auth/login` редиректит пользователя на страницу согласия Jira (`auth.atlassian.com/authorize`), защищено CSRF-параметром `state` в HttpOnly-куке. `GET /api/auth/callback` обменивает код на `access_token`/`refresh_token`, запрашивает `cloud_id` сайта через `accessible-resources` и сохраняет токены в таблице `jira_tokens` (одна активная запись, при повторном подключении перезаписывается).
2. **Синхронизация** — `POST /api/jira/sync` берёт актуальный access token (автоматически обновляя его через `refresh_token`, если истёк), запрашивает issues проекта `SCRUM` через `GET .../rest/api/3/search` и для каждой issue делает UPSERT в таблицу `issues`: если `issue_key` уже есть — сравнивает поля `status`, `assignee`, `sprint`, `priority` со старыми значениями и при изменении пишет запись в `issue_history`, затем обновляет строку; если issue новая — создаёт запись. Существующие записи никогда не удаляются автоматически (`is_deleted` зарезервировано для будущей логики). `last_synced_at` обновляется для каждой обработанной issue.
3. **Статус** — `GET /api/jira/status` возвращает `{ connected, issueCount, lastSyncedAt }`.
4. **Данные для дашборда** — `GET /api/jira/issues` отдаёт содержимое таблицы `issues` в том же формате, что и `POST /api/upload` (`total`/`byStatus`/`byTeam`/`byType`/`issues`), плюс `lastSyncedAt` — поэтому `Dashboard.jsx` одинаково рендерит и загруженный XLSX, и данные из БД.

### Переменные окружения (backend)

| Переменная | Назначение |
| --- | --- |
| `DATABASE_URL` | строка подключения к Postgres (например, Neon) — уже подключена |
| `JIRA_CLIENT_ID` | Client ID OAuth 2.0 (3LO) приложения в [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/) |
| `JIRA_CLIENT_SECRET` | Client Secret того же приложения |
| `JIRA_CALLBACK_URL` | URL обратного вызова, должен **точно** совпадать со значением в настройках приложения, например `https://ai-delivery-copilot-backend.vercel.app/api/auth/callback` |
| `FRONTEND_URL` *(опционально)* | если задан, `/api/auth/callback` после успешной авторизации редиректит сюда с `?jira=connected`; если не задан — показывает простую HTML-страницу с подтверждением |

В приложении Jira нужно включить OAuth 2.0 (3LO) и выдать API-scopes `read:jira-work`, `read:jira-user`, `offline_access` (последний обязателен для получения `refresh_token`).

### Ограничения текущей реализации

- **Sprint** — REST-поиск не возвращает имя спринта без знания id кастомного поля конкретного Jira-сайта (`customfield_XXXXX`), поэтому колонка `sprint` пока всегда `null`. Значение поля легко подставить в `mapJiraFields` в [routes/jira.js](backend/routes/jira.js), как только известен id поля вашего инстанса.
- **cycle_time / started_at** — вычисляются эвристически из текущего статуса и `created`/`updated` полей issue, без обращения к changelog. Для точного времени входа в статус потребуется дополнительный запрос `GET /rest/api/3/issue/{key}/changelog` — сознательно не включён в MVP, чтобы не увеличивать число запросов к Jira API при синхронизации большого проекта.
- Схема БД создаётся автоматически при первом обращении к любому Jira-эндпоинту (`CREATE TABLE IF NOT EXISTS` в [db.js](backend/db.js)) — отдельного шага миграции не требуется.
