# LogiCRM

CRM-система для логистической компании. Ведёт полный цикл работы с клиентами — от холодного лида до повторных продаж — и включает оперативную логистику: базу перевозчиков и запросы на перевозку.

---

## Стек технологий

| Слой | Технологии |
|---|---|
| **Backend** | Node.js 20, Express, Knex.js, Zod |
| **База данных** | PostgreSQL 16 |
| **Frontend** | Vite MPA, Alpine.js, нативный JS |
| **Инфраструктура** | Docker Compose, Nginx |
| **CI/CD** | GitHub Actions |

---

## Архитектура

```
Браузер
  │
  │ :80 / :443
  ▼
┌─────────────────────────────────────────┐
│  Docker Compose                         │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  Nginx :80/:443                 │    │
│  │  /api/* → backend:3000          │    │
│  │  статика → frontend/dist/       │    │
│  └────────────────┬────────────────┘    │
│                   │ /api/*              │
│  ┌────────────────▼────────────────┐    │
│  │  Node.js cluster (workers × N)  │    │
│  │  Express + Knex.js + Zod        │    │
│  │  13 роутов /api/*               │    │
│  └────────────────┬────────────────┘    │
│                   │ pg pool             │
│  ┌────────────────▼────────────────┐    │
│  │  PostgreSQL 16                  │    │
│  │  volume: pgdata                 │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

Все три контейнера работают в одной Docker-сети. Наружу открыты только порты 80/443 через Nginx. Node.js и PostgreSQL слушают только `127.0.0.1` и недоступны напрямую извне.

---

## Структура проекта

```
logicrm/
├── .github/
│   └── workflows/
│       └── deploy.yml          # CI/CD: сборка → rsync → docker deploy
│
├── backend/
│   ├── server.js               # Express + Node.js cluster
│   ├── config.js               # параметры из .env
│   ├── package.json
│   ├── Dockerfile
│   ├── db/
│   │   ├── pool.js             # pg Pool (legacy-совместимость)
│   │   ├── knex.js             # Knex query builder
│   │   ├── migrate.js          # idempotent schema + seed admin
│   │   └── schema.sql          # 8 таблиц, триггеры, индексы
│   ├── middleware/
│   │   ├── auth.js             # authenticate, requireRole
│   │   └── validate.js         # validate(ZodSchema)
│   └── routes/
│       ├── auth.js
│       ├── companies.js        # Knex + Zod ✓
│       ├── contacts.js         # Knex + Zod ✓
│       ├── deals.js            # Knex + Zod ✓
│       ├── activities.js       # Knex + Zod ✓
│       ├── carriers.js         # Knex + Zod ✓
│       ├── requests.js         # Knex + Zod ✓
│       ├── reports.js          # Knex + Zod ✓
│       ├── plans.js
│       ├── users.js
│       ├── import.js
│       ├── search.js
│       └── lookup.js           # DaData API (ИНН → реквизиты)
│
├── frontend/
│   ├── vite.config.js          # MPA: 13 HTML-страниц как точки входа
│   ├── package.json            # alpinejs + vite
│   ├── dist/                   # Vite build output → раздаёт Nginx
│   ├── js/
│   │   ├── db.js               # API-клиент (dbAdd/dbGet/dbPut/dbDelete)
│   │   ├── auth.js             # JWT сессия, can(), ROLES
│   │   ├── ui.js               # initUI, сайдбар, toast, поиск
│   │   ├── companies.js        # CRUD + SEGMENT_LABELS/COLORS
│   │   ├── contacts.js         # CRUD контактов
│   │   ├── deals.js            # CRUD сделок, воронка
│   │   ├── activities.js       # CRUD активностей
│   │   └── pages/
│   │       ├── activities.js   # Alpine.data('activitiesPage')
│   │       └── company.js      # Alpine.data('companyPage')
│   └── *.html                  # 13 страниц
│
├── nginx/
│   └── logicrm.conf            # reverse proxy, кэш, gzip, SSL
│
├── scripts/
│   └── backup-s3.sh            # pg_dump → gzip → S3 (cron 02:00)
│
├── docker-compose.yml
├── .env.example
└── .gitignore
```

---

## База данных

8 таблиц PostgreSQL. Автотриггер `set_updated_at` на все мутирующие таблицы. GIN-индекс на `companies.name` для полнотекстового поиска.

```
companies          — центральная сущность
  ├── contacts     — контакты (ЛПР, менеджеры)
  ├── deals        — сделки с историей стадий (JSONB stage_history)
  ├── activities   — активности (звонки, письма, встречи, задачи)
  └── requests     — логистические заявки

carriers           — база перевозчиков
  └── requests     — заявки привязываются к перевозчику

users              — пользователи системы (4 роли)
plans              — планы продаж (user_id + year + month, уникальный индекс)
```

### Ключевые поля

**companies** — `segment` (воронка), `priority`, `owner_id`, `next_action_at`, JSONB-поля: `regions`, `cargo_types`, `directions`, `routes`, `tags`

**deals** — 10 стадий воронки, `stage_history: JSONB`, `outcome` (in_progress / won / lost / postponed), `planned_revenue`, `planned_margin`

**requests** — маршрут, груз (вес, объём, ADR, негабарит), финансы (бюджет, наша ставка, ставка перевозчика, маржа), статус от `new` до `won/lost`

**activities** — 8 типов, `next_step` + `next_step_due` для задач, частичный индекс только по незавершённым

---

## Роли доступа (RBAC)

| Роль | Права |
|---|---|
| `admin` | Всё, включая управление пользователями |
| `head` | Все компании и сделки, планы команды, массовые действия, удаление |
| `manager` | Только свои компании / сделки / активности / заявки |
| `ops` | Только запросы на перевозку |

Реализовано через JWT (httpOnly cookie, 8 ч) + middleware `authenticate` → `requireRole`.

---

## API

Base URL: `/api`

| Метод | Путь | Описание |
|---|---|---|
| POST | `/auth/login` | Вход (rate limit: 20 req/15min) |
| POST | `/auth/logout` | Выход |
| GET | `/companies` | Список компаний |
| POST | `/companies` | Создать компанию |
| PUT | `/companies/:id` | Обновить |
| POST | `/companies/bulk` | Массовые действия |
| GET | `/deals` | Список сделок |
| PATCH | `/deals/:id/stage` | Сменить стадию |
| PATCH | `/deals/:id/close` | Закрыть сделку |
| GET | `/requests` | Логистические заявки |
| PATCH | `/requests/:id/status` | Сменить статус заявки |
| GET | `/reports/summary` | Сводная аналитика |
| GET | `/reports/funnel` | Воронка продаж |
| GET | `/reports/team` | Отчёт по менеджерам |
| GET | `/reports/timeline` | График активности |
| GET | `/lookup/inn/:inn` | Поиск компании по ИНН (DaData) |
| GET | `/health` | Health check (возвращает PID воркера) |

---

## Frontend

MPA (Multi-Page Application) на Vite. Каждая HTML-страница — отдельная точка входа. Нет роутера, нет глобального состояния.

Два режима на разных страницах:
- **Нативный JS** — `companies.html`, `deals.html`, `reports.html` и др. (DOM напрямую)
- **Alpine.js** — `activities.html`, `company.html` (декларативные шаблоны, реактивное состояние)

Все API-вызовы идут через `js/db.js` — тонкая обёртка над `fetch` с автоматической обработкой ошибок и поддержкой `existing_id` при дублировании ИНН.

---

## Запуск в production

### Требования
- Ubuntu 22.04+
- Docker Engine 24+
- Docker Compose v2

### Первый запуск

```bash
git clone git@github.com:ВАШ_ЮЗЕР/logicrm.git /opt/logicrm
cd /opt/logicrm

# Создать .env из шаблона и заполнить
cp .env.example .env
nano .env

# Собрать фронтенд
cd frontend && npm ci && npm run build && cd ..

# Запустить
docker compose up -d --build
```

При старте `migrate.js` автоматически применяет `schema.sql` (идемпотентно) и создаёт admin-пользователя из `.env`.

### Обновление

После настройки CI/CD обновление происходит автоматически при `git push origin main`. Вручную:

```bash
docker compose up -d --build --no-deps backend
docker exec logicrm_nginx nginx -s reload
```

---

## CI/CD (GitHub Actions)

При каждом `git push origin main`:

1. `npm ci` + `vite build` на GitHub-раннере
2. `rsync` — копирует `backend/`, `frontend/dist/`, `nginx/`, `docker-compose.yml` на сервер
3. SSH на сервер → `docker compose up --build --no-deps backend`
4. Health check `/api/health`
5. `nginx -s reload`

Время деплоя: ~2 минуты.

### Необходимые секреты в GitHub

| Секрет | Значение |
|---|---|
| `SSH_PRIVATE_KEY` | Приватный ключ (`~/.ssh/logicrm_deploy`) |
| `SSH_HOST` | IP сервера |
| `SSH_USER` | `deploy` |
| `DEPLOY_PATH` | `/opt/logicrm` |

---

## Бэкапы

Автоматически каждую ночь в 02:00 через cron:

```bash
# Добавить в crontab -e пользователя deploy
0 2 * * * /opt/logicrm/scripts/backup-s3.sh >> /var/log/logicrm-backup.log 2>&1
```

`backup-s3.sh` делает `pg_dump` внутри контейнера, сжимает gzip и загружает в S3-совместимое хранилище (AWS S3, Yandex Object Storage). Локальные файлы хранятся 7 дней, в S3 — 90 дней.

Восстановление из бэкапа:

```bash
gunzip -c /home/deploy/backups/logicrm_YYYYMMDD_HHMMSS.sql.gz \
  | docker exec -i logicrm_db psql -U logicrm logicrm
```

---

## Переменные окружения

Скопировать `.env.example` → `.env` и заполнить:

```bash
# База данных
DB_NAME=logicrm
DB_USER=logicrm
DB_PASSWORD=             # ← сильный пароль

# Приложение
JWT_SECRET=              # ← минимум 32 случайных символа
CORS_ORIGIN=https://yourdomain.com
NODE_ENV=production
PORT=3000

# Admin по умолчанию (создаётся при первом запуске)
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=          # ← сменить после первого входа

# DaData API (опционально — поиск по ИНН)
DADATA_API_KEY=

# Кластер Node.js (опционально)
WEB_CONCURRENCY=2        # число воркеров; авто если не задан

# Бэкапы (для backup-s3.sh)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_DEFAULT_REGION=
S3_BUCKET=
```

---

## Node.js кластер

`server.js` при старте форкает `WEB_CONCURRENCY` (или `availableParallelism()`) воркеров. Primary только управляет воркерами и перезапускает упавших. Каждый воркер — полноценный Express на порту 3000. Nginx балансирует между ними.

Проверка:
```bash
# PID меняется при каждом запросе — кластер работает
for i in 1 2 3 4; do curl -s http://localhost:3000/api/health | python3 -m json.tool; done
```

Отключить кластер для отладки:
```bash
WEB_CONCURRENCY=1 node server.js
```

---

## Разработка локально

```bash
# Backend
cd backend
cp ../.env.example .env  # заполнить DB_ для локальной БД
npm install
node db/migrate.js
node server.js

# Frontend (в отдельном терминале)
cd frontend
npm install
npm run dev  # → http://localhost:5173, /api/* проксируется на :3000
```
