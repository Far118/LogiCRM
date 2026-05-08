# LogiCRM

CRM-система для логистической компании. Полный цикл работы с клиентами — от холодного лида до повторных продаж — плюс оперативная логистика: база перевозчиков и запросы на перевозку.

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
  │ :80 / :443
  ▼
┌─────────────────────────────────────────┐
│  Docker Compose                         │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  Nginx :80/:443                 │    │
│  │  /api/* → backend:3000          │    │
│  │  статика → frontend/dist/       │    │
│  └──────────────┬──────────────────┘    │
│                 │ /api/*                │
│  ┌──────────────▼──────────────────┐    │
│  │  Node.js cluster (workers × N)  │    │
│  │  Express · Knex.js · Zod        │    │
│  │  14 роутов /api/*               │    │
│  └──────────────┬──────────────────┘    │
│                 │ pg pool               │
│  ┌──────────────▼──────────────────┐    │
│  │  PostgreSQL 16 · volume pgdata  │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

Все три контейнера — в одной Docker-сети. Наружу открыты только 80/443 через Nginx.

---

## Структура проекта

```
logicrm/
├── .github/
│   └── workflows/
│       └── deploy.yml              # CI/CD: build → rsync → docker deploy
│
├── backend/
│   ├── server.js                   # Express + Node.js cluster + push scheduler
│   ├── config.js                   # параметры из .env
│   ├── package.json
│   ├── Dockerfile
│   ├── db/
│   │   ├── pool.js                 # pg Pool (legacy)
│   │   ├── knex.js                 # Knex query builder
│   │   ├── migrate.js              # idempotent schema + seed admin
│   │   ├── schema.sql              # 8 таблиц, триггеры, индексы
│   │   └── push_migration.sql      # таблица push_subscriptions
│   ├── middleware/
│   │   ├── auth.js                 # authenticate, requireRole
│   │   └── validate.js             # validate(ZodSchema)
│   ├── services/
│   │   └── notifier.js             # Web Push — отправка по расписанию
│   └── routes/
│       ├── auth.js
│       ├── companies.js            # Knex + Zod ✓
│       ├── contacts.js             # Knex + Zod ✓
│       ├── deals.js                # Knex + Zod ✓
│       ├── activities.js           # Knex + Zod ✓
│       ├── carriers.js             # Knex + Zod ✓
│       ├── requests.js             # Knex + Zod ✓
│       ├── reports.js              # Knex + Zod ✓
│       ├── plans.js                # Knex ✓ (copy-month)
│       ├── notifications.js        # Web Push subscribe/unsubscribe
│       ├── users.js
│       ├── import.js
│       ├── search.js
│       └── lookup.js               # DaData API (ИНН → реквизиты)
│
├── frontend/
│   ├── vite.config.js              # MPA: 13 HTML-страниц, target: esnext
│   ├── package.json                # alpinejs + vite
│   ├── public/
│   │   └── sw.js                   # Service Worker для Web Push
│   ├── dist/                       # Vite build output → Nginx
│   ├── css/
│   │   └── app.css
│   ├── js/
│   │   ├── db.js                   # API-клиент
│   │   ├── auth.js                 # JWT сессия, can(), ROLES
│   │   ├── ui.js                   # initUI, сайдбар, toast
│   │   ├── companies.js            # CRUD + SEGMENT_LABELS/COLORS
│   │   ├── contacts.js
│   │   ├── deals.js
│   │   ├── activities.js
│   │   └── pages/
│   │       ├── dashboard.js        # Alpine: дашборд + воронка + календарь + push
│   │       ├── activities.js       # Alpine: страница активностей
│   │       ├── company.js          # Alpine: карточка компании
│   │       └── plans.js            # Alpine: планы продаж
│   └── *.html                      # 13 страниц
│
├── nginx/
│   └── logicrm.conf
├── scripts/
│   └── backup-s3.sh                # pg_dump → gzip → S3 (cron 02:00)
├── docker-compose.yml
├── .env.example
└── .gitignore
```

---

## База данных

9 таблиц PostgreSQL. Автотриггер `set_updated_at` на все мутации. GIN-индекс на `companies.name`.

```
companies ──┬── contacts
            ├── deals ── activities
            ├── activities
            └── requests ── carriers

users
plans              (user_id + year + month, уникальный индекс)
push_subscriptions (Web Push подписки, CASCADE от users)
```

### Сегменты воронки компаний

| Ключ | Метка |
|---|---|
| `cold_lead` | Холодный лид |
| `warm_lead` | Тёплый лид |
| `hot_lead` | Горячий лид |
| `active_client` | Клиент |
| `vip` | VIP клиент |
| `inactive` | Не активен |
| `lost` | Потерян |

---

## Роли доступа (RBAC)

| Роль | Права |
|---|---|
| `admin` | Всё, включая управление пользователями |
| `head` | Все компании/сделки, планы команды, массовые действия, копирование планов |
| `manager` | Только свои компании / сделки / активности / заявки |
| `ops` | Только запросы на перевозку |

JWT в httpOnly cookie, срок 8 ч. Rate limit на `/api/auth/login` — 20 req/15 min.

---

## API

| Метод | Путь | Описание |
|---|---|---|
| POST | `/auth/login` | Вход |
| POST | `/auth/logout` | Выход |
| GET/POST | `/companies` | Список / создать |
| PUT | `/companies/:id` | Обновить |
| POST | `/companies/bulk` | Массовые действия |
| GET/POST | `/deals` | Список / создать |
| PATCH | `/deals/:id/stage` | Сменить стадию |
| PATCH | `/deals/:id/close` | Закрыть сделку |
| GET/POST | `/requests` | Логистические заявки |
| PATCH | `/requests/:id/status` | Сменить статус |
| GET | `/reports/summary` | Сводная аналитика |
| GET | `/reports/funnel` | Воронка продаж |
| GET | `/reports/team` | Отчёт по менеджерам |
| GET | `/reports/timeline` | График активности |
| POST | `/plans/copy-month` | Копировать планы с другого месяца |
| GET | `/notifications/vapid-key` | VAPID публичный ключ |
| POST | `/notifications/subscribe` | Подписаться на push |
| DELETE | `/notifications/subscribe` | Отписаться |
| GET | `/lookup/inn/:inn` | Поиск по ИНН (DaData) |
| GET | `/health` | Health check |

---

## Frontend

MPA на Vite. 13 HTML-страниц как отдельные точки входа. Два режима:

**Alpine.js** — реактивные страницы: `dashboard`, `activities`, `company`, `plans`

**Нативный JS** — остальные страницы (`companies`, `deals`, `reports` и др.)

### Дашборд

- Счётчики задач (просрочено / сегодня / неделя / компании)
- **Воронка продаж** — горизонтальные бары по стадиям с pipeline, клик → переход на сделки
- Список задач с группировкой по сроку (просрочено → сегодня → неделя)
- **Мини-календарь** — dropdown-кнопка в топбаре, точки на днях с задачами и касаниями
- Свежие компании, активность за 7 дней, план на месяц с прогрессом
- **Push-уведомления** — тоггл включения, уведомления в 9:00 по расписанию

### Планы продаж (head/admin)

- Inline-редактирование с автосохранением (debounce 800ms)
- Факт vs план с прогрессбаром по каждому показателю
- **Копировать с другого месяца** — модальное окно с выбором источника

---

## Push-уведомления

Web Push через VAPID. Service Worker `/sw.js` принимает push и открывает нужную страницу при клике.

**Расписание** (настраивается в `backend/services/notifier.js`):

| Тип | Время | Условие |
|---|---|---|
| Просроченные задачи | 9:00 UTC | `next_step_due < today && !is_done` |
| Задачи на сегодня | 9:00 UTC | `next_step_due = today && !is_done` |
| Касания с компаниями | 9:00 UTC | `next_action_at = today` |

> **Важно:** время UTC. Для Москвы (UTC+3) ставь `hour !== 6`.

Генерация VAPID-ключей:
```bash
npx web-push generate-vapid-keys
```

---

## Запуск в production

### Требования
- Ubuntu 22.04+, Docker Engine 24+, Docker Compose v2

### Первый запуск

```bash
git clone git@github.com:ВАШ_ЮЗЕР/logicrm.git /opt/logicrm
cd /opt/logicrm
cp .env.example .env
nano .env   # заполнить все переменные

# Применить миграцию push-уведомлений
docker compose up -d postgres
sleep 5
docker exec -i logicrm_db psql -U logicrm logicrm < backend/db/push_migration.sql

# Собрать фронтенд
cd frontend && npm ci && npm run build && cd ..

# Запустить всё
docker compose up -d --build
```

### Обновление через CI/CD

```bash
git push origin main
# GitHub Actions автоматически задеплоит (~2 минуты)
```

### Обновление вручную

```bash
cd /opt/logicrm
docker compose up -d --build --no-deps backend
docker exec logicrm_nginx nginx -s reload
```

---

## CI/CD (GitHub Actions)

При `git push origin main`:
1. `npm ci` + `vite build` на GitHub-раннере
2. `rsync` → копирует `backend/`, `frontend/dist/`, `nginx/`, `docker-compose.yml`
3. SSH → `docker compose up --build --no-deps backend`
4. Health check `/api/health`
5. `nginx -s reload`

### Секреты GitHub (Settings → Secrets → Actions)

| Секрет | Значение |
|---|---|
| `SSH_PRIVATE_KEY` | Приватный ключ `~/.ssh/logicrm_deploy` |
| `SSH_HOST` | IP сервера |
| `SSH_USER` | `deploy` |
| `DEPLOY_PATH` | `/opt/logicrm` |

---

## Бэкапы

```bash
# Добавить в crontab -e
0 2 * * * /opt/logicrm/scripts/backup-s3.sh >> /var/log/logicrm-backup.log 2>&1
```

`backup-s3.sh`: `pg_dump` → `gzip` → S3. Локально 7 дней, в S3 90 дней.

**Восстановление:**
```bash
gunzip -c /home/deploy/backups/logicrm_YYYYMMDD_HHMMSS.sql.gz \
  | docker exec -i logicrm_db psql -U logicrm logicrm
```

---

## Переменные окружения (.env)

```bash
# База данных
DB_NAME=logicrm
DB_USER=logicrm
DB_PASSWORD=           # сильный пароль

# Приложение
JWT_SECRET=            # минимум 32 случайных символа
CORS_ORIGIN=https://yourdomain.com
NODE_ENV=production
PORT=3000

# Admin (создаётся при первом запуске)
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=        # сменить после первого входа

# DaData (поиск по ИНН, опционально)
DADATA_API_KEY=

# Web Push VAPID (генерация: npx web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# Node.js кластер (авто если не задан)
WEB_CONCURRENCY=2
```

---

## Локальная разработка

```bash
# Backend
cd backend && npm install
node db/migrate.js
node server.js          # или: node --watch server.js

# Frontend (в отдельном терминале)
cd frontend && npm install
npm run dev             # → http://localhost:5173, /api/* → :3000
```
