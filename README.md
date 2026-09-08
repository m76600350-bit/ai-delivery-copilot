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
│       └── jira.js       # sync/status/issues/fields/field-mapping/tasks
├── frontend/           # React + Vite + Tailwind
│   ├── package.json
│   ├── index.html
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   ├── api.js
│   │   ├── index.css
│   │   └── components/
│   │       ├── TopNav.jsx
│   │       ├── Upload.jsx
│   │       ├── Dashboard.jsx
│   │       ├── WidgetDrilldown.jsx
│   │       ├── Tasks.jsx
│   │       ├── TaskDetailPanel.jsx
│   │       ├── MultiSelectFilter.jsx
│   │       ├── StatusBadge.jsx
│   │       ├── Settings.jsx
│   │       ├── JiraPanel.jsx
│   │       └── FieldMapping.jsx
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

1. **Авторизация** — `GET /api/auth/login` редиректит пользователя на страницу согласия Jira (`auth.atlassian.com/authorize`), защищено CSRF-параметром `state` в HttpOnly-куке. `GET /api/auth/callback` обменивает код на `access_token`/`refresh_token`, запрашивает `cloud_id` сайта через `accessible-resources`, сохраняет токены в таблице `jira_tokens` (одна активная запись, при повторном подключении перезаписывается) и редиректит обратно на фронтенд с `?jira=connected` (по умолчанию — `https://ai-delivery-copilot.vercel.app`, переопределяется через `FRONTEND_URL`). Фронтенд ([App.jsx](frontend/src/App.jsx)) читает этот параметр при первом рендере, сразу показывает статус «подключено» и сообщение «Jira успешно подключена», затем убирает параметр из URL через `history.replaceState` и всё равно уточняет статус через `GET /api/jira/status`.
2. **Синхронизация** — `POST /api/jira/sync` берёт актуальный access token (автоматически обновляя его через `refresh_token`, если истёк), запрашивает issues проекта `SCRUM` через `POST .../rest/api/3/search/jql` (актуальный endpoint — старый `/rest/api/3/search` Atlassian удалила, он отвечает `410 Gone`) и для каждой issue делает UPSERT в таблицу `issues`: если `issue_key` уже есть — сравнивает поля `status`, `assignee`, `sprint`, `priority` со старыми значениями и при изменении пишет запись в `issue_history`, затем обновляет строку; если issue новая — создаёт запись. Существующие записи никогда не удаляются автоматически (`is_deleted` зарезервировано для будущей логики). `last_synced_at` обновляется для каждой обработанной issue. Пагинация — курсорная (`nextPageToken`/`isLast`), а не `startAt`/`total`, как было в старом API; `fetchAllIssues` в [routes/jira.js](backend/routes/jira.js) листает страницы, пока не встретит `isLast: true` или пустой `nextPageToken`.
   - **Lead time и cycle time** считаются точно, а не эвристикой: `lead_time_days = resolutiondate − created`; `cycle_time_days` — сумма всех периодов, когда статус был в категории «In Progress» (реплей истории статусов, а не разница «первый вход в работу — резолюция», поэтому reopen учитывается честно). Оба — `null`, пока issue не резолвнута. `reopen_count` (сколько раз статус уходил из категории Done обратно) считается независимо от текущего состояния резолюции. Для этого на каждую issue дополнительно запрашивается `GET /rest/api/3/issue/{key}/changelog` (курсор `nextPageToken`/`isLast` или офсет `startAt`/`total` — источники по этому эндпоинту расходятся в формате, поэтому `fetchChangelog` в [routes/jira.js](backend/routes/jira.js) поддерживает оба) плюс один общий запрос `GET /rest/api/3/status` за весь sync, чтобы сопоставить исторические статусы из changelog с категорией («To Do»/«In Progress»/«Done»).
     - **Сопоставление по id статуса, не по имени.** Changelog отдаёт `fromString`/`toString` — это *дефолтные* (обычно английские) имена статусов независимо от локали аккаунта, тогда как `GET /rest/api/3/status` (и текущий статус issue из search API) возвращает имена, локализованные под пользователя, выполняющего запрос. На нелокализованном (en) сайте оба совпадают и баг не проявляется; на любом другом — сопоставление по имени тихо не находит категорию ни для одного статуса, и `cycle_time` получается `0` для всех резолвнутых issues при корректном `lead_time`. Оба API также отдают числовой `id` статуса, который не зависит от локали и совпадает в обоих ответах — `statusCategoryByName` в `fetchStatusCategoryMap` строит карты `byId` (основная) и `byName` (фолбэк на случай записи changelog без id), `categoryOf` в `computeLeadCycleReopen` матчит сначала по id.
     - **Отладка**: если задать `DEBUG_CYCLE_TIME=1` в окружении backend, `/api/jira/sync` пишет в лог по каждой обработанной issue созданные сегменты статус-таймлайна (статус, id, категория, границы периода, кол-во дней, засчитан ли в cycle time) и итоговые `cycleTimeDays`/`leadTimeDays`/`reopenCount` — полезно для проверки на реальном Jira-сайте, если расчёт снова покажется подозрительным.
   - **Ускорение повторных синков**: changelog запрашивается только для issues, у которых Jira-поле `updated` изменилось с прошлой синхронизации (или для новых) — для остальных `cycle_time`/`lead_time_days`/`reopen_count` просто переносятся из уже сохранённой строки без лишнего похода в Jira.
   - **Прогресс синка** — отдельная таблица `sync_progress` (одна строка, `id = 1`) обновляется после каждой обработанной issue; `GET /api/jira/sync/progress` её читает. Это намеренно через БД, а не in-memory состояние на `/sync` — на Vercel запрос, который поллит прогресс, может попасть на другой инстанс serverless-функции, чем тот, что выполняет сам sync. Фронтенд ([useSyncProgress.js](frontend/src/useSyncProgress.js)) поллит каждые 800 мс, пока идёт синхронизация, и кнопки в [JiraPanel.jsx](frontend/src/components/JiraPanel.jsx) и [Dashboard.jsx](frontend/src/components/Dashboard.jsx) показывают «Синхронизация... получено N из M задач» вместо простого текста.
3. **Статус** — `GET /api/jira/status` возвращает `{ connected, issueCount, lastSyncedAt }`.
4. **Данные для дашборда** — `GET /api/jira/issues` отдаёт содержимое таблицы `issues` в том же формате, что и `POST /api/upload` (`total`/`byStatus`/`byTeam`/`byType`/`issues`), плюс `lastSyncedAt` — поэтому `Dashboard.jsx` одинаково рендерит и загруженный XLSX, и данные из БД. Пока Jira подключена (`jiraStatus.connected`, независимо от того, откуда пришли текущие данные на экране), в шапке дашборда рядом с «Загрузить другой файл» показывается кнопка **«Обновить данные из Jira»** — она вызывает тот же `POST /api/jira/sync` → `GET /api/jira/issues`, что и кнопка на стартовом экране, подставляет новые данные без перезагрузки страницы и обновляет отметку времени синхронизации; во время запроса кнопка блокируется и показывает «Синхронизация...». Если Jira не подключена (например, показан только загруженный файл), кнопка не рендерится вовсе.
5. **Маппинг полей** — id кастомных полей (`customfield_XXXXX`) уникальны для каждого Jira-сайта, поэтому Sprint/Team/Story Points не хардкодятся, а настраиваются через UI:
   - `GET /api/jira/fields` — список всех полей текущего Jira-сайта (`id` + `name`) через `GET /rest/api/3/field`.
   - `GET /api/jira/field-mapping` / `POST /api/jira/field-mapping` — чтение и сохранение соответствия `canonical_field → jira_field_id` в таблице `jira_field_mapping` (ключ — `cloud_id`, так что маппинг привязан к конкретному Jira-сайту).
   - На фронтенде это экран **«Настройка полей Jira»** ([FieldMapping.jsx](frontend/src/components/FieldMapping.jsx)) — dropdown на каждое поле, опции берутся из `/api/jira/fields`, кнопка «Сохранить маппинг». Открывается автоматически сразу после первого подключения Jira (если маппинг ещё пустой) и в любой момент повторно — кнопкой **«Настройки полей»** в [JiraPanel.jsx](frontend/src/components/JiraPanel.jsx).
   - Если маппинг не настроен, `POST /api/jira/sync` не падает и не блокируется — просто использует `null` для несопоставленных canonical-полей (для `team` дополнительно есть фолбэк на `labels`, как и раньше).
6. **Раздел «Задачи»** ([Tasks.jsx](frontend/src/components/Tasks.jsx)) — таблица issues из БД с живым поиском (debounce 300 мс), множественным выбором по статусу/команде/типу/приоритету ([MultiSelectFilter.jsx](frontend/src/components/MultiSelectFilter.jsx)), пагинацией по 20 и экспортом текущей выборки в CSV. Backing endpoint `GET /api/jira/tasks` (query: `search`, повторяемые `status`/`team`/`type`/`priority`, `page`; с `export=csv` отдаёт файл без пагинации) и `GET /api/jira/tasks/filters` (списки значений для дропдаунов, только то, что реально есть в БД). Колонка «Дней в статусе» считается на бэкенде от `updated_at` до текущего момента и показывает `—`, если `status_category` уже `Done`. Клик по строке открывает боковую панель со всеми полями задачи ([TaskDetailPanel.jsx](frontend/src/components/TaskDetailPanel.jsx)) и ссылкой «Открыть в Jira» — `{site_url}/browse/{issue_key}`, где `site_url` (например, `https://your-domain.atlassian.net`) сохраняется в `jira_tokens` при OAuth (Jira отдаёт его в том же ответе `accessible-resources`, откуда берётся `cloud_id`).
7. **Верхняя навигация** ([TopNav.jsx](frontend/src/components/TopNav.jsx)) — табы «Дашборд», «Задачи», «Настройки» рабочие; «Команды», «Спринты», «Отчёты» показаны как заглушки (неактивны, без обработчиков) — задел под будущие разделы по общему макету продукта. «Настройки» переиспользует существующие `JiraPanel`/`FieldMapping` ([Settings.jsx](frontend/src/components/Settings.jsx)), чтобы управление подключением Jira было доступно не только на стартовом экране до первой загрузки данных.
8. **Разворот виджетов дашборда** ([WidgetDrilldown.jsx](frontend/src/components/WidgetDrilldown.jsx)) — карточки «По статусу», «По команде», «По типу» получили иконку ⛶, разворачивающую виджет на весь экран поверх обычного дашборда (не роут, локальный `expandedWidget` state в [Dashboard.jsx](frontend/src/components/Dashboard.jsx)). Полноэкранный вид считает группировку прямо на клиенте из уже загруженного `stats.issues` — никаких новых полей в БД не потребовалось. Слева — локальные фильтры (Период/Команда/Тип задачи), которые сужают только это представление и не трогают `stats` в `Dashboard`. «По команде» — единственная группировка с реальной вложенностью (команда → статус, разворачивается стрелкой, если у команды больше одного статуса); «По статусу» и «По типу» — плоские таблицы. Клик по названию группы (или по числу в строке без вложенности) переключает верхнюю навигацию на «Задачи» с фильтром по этому одному измерению; клик по числу в развёрнутой подстроке — с комбинированным фильтром (например, команда + статус одновременно). Передача фильтра между экранами — через `taskFilterRequest`/`navigateToTasks` в [App.jsx](frontend/src/App.jsx): клик создаёт новый объект фильтра, `Tasks.jsx` подхватывает его в `useEffect`, завязанном на identity этого объекта — так эффект срабатывает даже при повторном клике на то же самое значение (объект каждый раз новый).

### Переменные окружения (backend)

| Переменная | Назначение |
| --- | --- |
| `DATABASE_URL` | строка подключения к Postgres (например, Neon) — уже подключена |
| `JIRA_CLIENT_ID` | Client ID OAuth 2.0 (3LO) приложения в [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/) |
| `JIRA_CLIENT_SECRET` | Client Secret того же приложения |
| `JIRA_CALLBACK_URL` | URL обратного вызова, должен **точно** совпадать со значением в настройках приложения, например `https://ai-delivery-copilot-backend.vercel.app/api/auth/callback` |
| `FRONTEND_URL` *(опционально)* | куда `/api/auth/callback` редиректит после успешной авторизации (добавляется `?jira=connected`); по умолчанию `https://ai-delivery-copilot.vercel.app` — задайте, если фронтенд развёрнут на другом домене или для локальной разработки |

В приложении Jira нужно включить OAuth 2.0 (3LO) и выдать API-scopes `read:jira-work`, `read:jira-user`, `offline_access` (последний обязателен для получения `refresh_token`).

### Ограничения текущей реализации

- **Sprint/Team/Story Points** зависят от того, настроен ли маппинг через UI «Настройки полей» — без него эти поля синкаются как `null` (Team — как `labels`). Значения из Jira извлекаются универсальным хелпером `extractFieldValue` в [routes/jira.js](backend/routes/jira.js), который умеет доставать имя/value из объекта, брать последний элемент массива (актуально для Sprint — Jira отдаёт историю всех спринтов issue) или число.
- **started_at** — по-прежнему эвристика («первый раз статус стал не To Do»), не из changelog; используется только для отображения, не для расчёта cycle time (тот теперь считается по полной истории статусов — см. выше).
- **Формат ответа `GET /rest/api/3/issue/{key}/changelog`** — точную структуру (курсорная или офсетная пагинация, ключ `values` или `histories`) не удалось верифицировать против реальной Jira: официальная документация Atlassian отдаёт JS-рендерящуюся SPA, не читаемую через обычный fetch, а сторонние источники (форумы, блоги) расходятся между собой. `fetchChangelog` написан защитно — поддерживает оба варианта — но стоит перепроверить на первом реальном sync с продовым Jira-сайтом.
- Сами **категории** статусов (`statusCategory.name` — их всего 3: To Do/In Progress/Done) сравниваются с литеральными английскими строками. Это отдельная сущность от имени конкретного статуса (которое уже сопоставляется по id, см. выше) — категории в Jira обычно не переводятся, но это не проверено на реальном локализованном сайте; если `DEBUG_CYCLE_TIME=1` покажет `category: null` там, где ожидается «In Progress»/«Done», проблема в этом месте.
- Схема БД создаётся автоматически при первом обращении к любому Jira-эндпоинту (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` в [db.js](backend/db.js)) — отдельного шага миграции не требуется.
- Маппинг полей общий на всё приложение (по `cloud_id`, без пользовательских аккаунтов) — это согласуется с тем, что и Jira-подключение в текущей реализации одно на всё приложение (одна строка в `jira_tokens`).
