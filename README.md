# LogiCRM

CRM-система для логистической компании. Полный цикл работы с клиентами — от холодного лида до повторных продаж — плюс оперативная логистика: база перевозчиков, запросы на перевозку и планы продаж.

---

## Содержание

1. [Стек технологий](#1-стек-технологий)
2. [Архитектура системы](#2-архитектура-системы)
3. [Структура проекта](#3-структура-проекта)
4. [Требования для запуска](#4-требования-для-запуска)
5. [Быстрый старт production](#5-быстрый-старт-production)
6. [Переменные окружения](#6-переменные-окружения)
7. [SSL-сертификаты](#7-ssl-сертификаты)
8. [Push-уведомления VAPID](#8-push-уведомления-vapid)
9. [Миграции базы данных](#9-миграции-базы-данных)
10. [Локальная разработка](#10-локальная-разработка)
11. [CI/CD через GitHub Actions](#11-cicd-через-github-actions)
12. [Бэкапы](#12-бэкапы)
13. [API — справочник эндпоинтов](#13-api--справочник-эндпоинтов)
14. [Роли и права доступа](#14-роли-и-права-доступа)
15. [База данных](#15-база-данных)
16. [Обновление и обслуживание](#16-обновление-и-обслуживание)
17. [Диагностика и решение проблем](#17-диагностика-и-решение-проблем)
18. [Безопасность](#18-безопасность)

---

## 1. Стек технологий

### Backend

| Пакет | Версия | Назначение |
|---|---|---|
| Node.js | 20 LTS | Runtime |
| Express | 4.19 | HTTP-фреймворк |
| Knex.js | 3.1 | Query builder (основной клиент БД) |
| pg | 8.11 | PostgreSQL driver |
| Zod | 3.23 | Валидация входящих данных |
| bcryptjs | 2.4 | Хэширование паролей |
| jsonwebtoken | 9.0 | JWT авторизация |
| web-push | 3.6 | Web Push уведомления (VAPID) |
| helmet | 7.1 | Security headers |
| express-rate-limit | 7.3 | Rate limiting |
| dotenv | 16.4 | Загрузка .env |

### Frontend

| Инструмент | Версия | Назначение |
|---|---|---|
| Vite | 5.4 | Сборщик (MPA, target: esnext) |
| Alpine.js | 3.14 | Реактивность на страницах dashboard, company, activities, plans |
| Нативный JS | — | Остальные 9 страниц |

### Инфраструктура

| Компонент | Версия | Назначение |
|---|---|---|
| PostgreSQL | 16-alpine | Основная база данных |
| Nginx | 1.25-alpine | Reverse proxy + раздача статики |
| Docker Compose | v2 | Оркестрация контейнеров |
| GitHub Actions | — | CI/CD: security scan → build → deploy |

---

## 2. Архитектура системы

```
Браузер
  │
  ├─ :80  ──→ HTTP 301 redirect → HTTPS
  └─ :443 ──→ Nginx
                ├── /         → frontend/dist/ (Vite static build)
                └── /api/*    → backend:3000 (внутренняя Docker-сеть)

┌─────────────────── Docker Compose ────────────────────────────────┐
│                                                                     │
│  logicrm_nginx  (nginx:1.25-alpine)                                │
│    ports: 80:80, 443:443                                            │
│    volumes: dist/:ro, logicrm.conf:ro, /opt/logicrm-certs:ro      │
│    cap_drop: ALL, cap_add: NET_BIND_SERVICE                         │
│                            │ proxy_pass http://backend:3000        │
│  logicrm_backend  (node:20-alpine)                                 │
│    expose: 3000  (только внутри Docker-сети, снаружи закрыт)       │
│    USER node  (непривилегированный пользователь)                    │
│    cap_drop: ALL                                                    │
│    Node.js cluster: primary + N workers                             │
│    primary: push notifications cron (каждый час)                    │
│                            │ Knex / pg pool                        │
│  logicrm_db  (postgres:16-alpine)                                  │
│    expose: 5432  (только внутри Docker-сети)                        │
│    volume: pgdata (persistent Docker volume)                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

/opt/logicrm-certs/  ← сертификаты на хосте (вне репозитория)
  ├── fullchain.pem
  └── privkey.pem
```

**Ключевые принципы безопасности архитектуры:**
- Backend и PostgreSQL не публикуют порты наружу (`expose`, не `ports`)
- SSL-сертификаты хранятся вне репозитория в `/opt/logicrm-certs/`
- Node.js запускается от непривилегированного пользователя `node`
- Все контейнеры работают с `cap_drop: ALL`

---

## 3. Структура проекта

```
logicrm/
├── .github/
│   ├── workflows/
│   │   └── deploy.yml           # CI/CD: security scan → build → rsync → deploy
│   └── dependabot.yml           # Автообновление Actions и npm зависимостей
│
├── backend/
│   ├── server.js                # Точка входа: кластер + Express + push cron
│   ├── config.js                # Все параметры из .env (require_env для обязательных)
│   ├── package.json
│   ├── package-lock.json        # Фиксация зависимостей (используется npm ci)
│   ├── Dockerfile               # USER node, npm ci --ignore-scripts, apk curl
│   ├── .dockerignore            # Исключает .env из Docker-образа
│   ├── db/
│   │   ├── pool.js              # pg.Pool (legacy, в части роутов)
│   │   ├── knex.js              # Knex query builder (основной клиент)
│   │   ├── migrate.js           # Idempotent schema apply + seed admin
│   │   ├── schema.sql           # 8 таблиц, триггеры, индексы
│   │   └── push_migration.sql   # Таблица push_subscriptions
│   ├── middleware/
│   │   ├── auth.js              # authenticate, requireRole, signToken, setCookie
│   │   └── validate.js          # validate(ZodSchema) — middleware для роутов
│   ├── services/
│   │   └── notifier.js          # Web Push: runScheduler, sendPush, notifyUser
│   └── routes/
│       ├── auth.js              # login, logout, me, password
│       ├── users.js             # CRUD пользователей
│       ├── companies.js         # CRUD + bulk actions (Knex + Zod)
│       ├── contacts.js          # CRUD + IDOR protection (Knex + Zod)
│       ├── deals.js             # CRUD + stage/close/reopen (Knex + Zod)
│       ├── activities.js        # CRUD активностей (Knex + Zod)
│       ├── carriers.js          # CRUD перевозчиков (Knex + Zod)
│       ├── requests.js          # Логистические заявки (Knex + Zod)
│       ├── reports.js           # 5 аналитических отчётов (Knex + Zod query)
│       ├── plans.js             # Планы продаж + copy-month (Knex)
│       ├── notifications.js     # Web Push subscribe/unsubscribe/test
│       ├── import.js            # Массовый импорт компаний из CSV
│       ├── search.js            # Глобальный поиск по 4 таблицам
│       └── lookup.js            # DaData API (поиск по ИНН)
│
├── frontend/
│   ├── vite.config.js           # MPA: 13 HTML-страниц, target: esnext
│   ├── package.json
│   ├── package-lock.json
│   ├── public/
│   │   └── sw.js                # Service Worker для Web Push
│   ├── dist/                    # Vite build output (git-ignored, раздаётся Nginx)
│   ├── css/
│   │   └── app.css              # Дизайн-система: CSS-переменные, компоненты
│   ├── js/
│   │   ├── db.js                # API-клиент: fetch-обёртка, обработка ошибок
│   │   ├── auth.js              # JWT-сессия, can(), ROLES, getSession()
│   │   ├── ui.js                # initUI, сайдбар, toast, escHtml, fmtDate
│   │   ├── companies.js         # CRUD, SEGMENT_LABELS/COLORS
│   │   ├── contacts.js          # CRUD контактов
│   │   ├── deals.js             # CRUD сделок, воронка
│   │   ├── activities.js        # CRUD активностей, ACTIVITY_TYPE_LABELS
│   │   └── pages/
│   │       ├── dashboard.js     # Alpine: дашборд, воронка, календарь, push
│   │       ├── activities.js    # Alpine: страница активностей
│   │       ├── company.js       # Alpine: карточка компании
│   │       └── plans.js         # Alpine: планы продаж
│   └── *.html                   # 13 страниц (index, login, companies, company,
│                                # deals, activities, requests, carriers,
│                                # reports, plans, import, admin/users)
│
├── nginx/
│   └── logicrm.conf             # SSL, CSP, security headers, кэш, proxy
│
├── scripts/
│   ├── backup-s3.sh             # pg_dump → gzip → S3 (запускается по cron)
│   └── renew-certs.sh           # Копирует обновлённый сертификат + nginx reload
│
├── docker-compose.yml
├── .env.example
├── .gitignore
└── README.md
```

---

## 4. Требования для запуска

### Production-сервер

| Требование | Минимум | Рекомендуется |
|---|---|---|
| ОС | Ubuntu 22.04 LTS | Ubuntu 22.04 / 24.04 LTS |
| CPU | 1 ядро | 2 ядра |
| RAM | 1 GB | 2 GB |
| Диск | 20 GB | 40 GB SSD |
| Docker Engine | 24.0+ | последняя стабильная |
| Docker Compose | v2.20+ | последняя стабильная |
| Открытые порты | 22, 80, 443 | |
| Домен | указывает на IP сервера | |

### Проверка установки на сервере

```bash
docker --version
# Docker version 24.x.x или новее

docker compose version
# Docker Compose version v2.x.x

# Если не установлены:
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

### Локальная разработка

- Node.js 20 LTS: https://nodejs.org
- Git
- Docker Desktop (для локальной БД): https://docker.com/products/docker-desktop

---

## 5. Быстрый старт (production)

### 1. Клонируем репозиторий на сервер

```bash
git clone git@github.com:ВАША_ОРГАНИЗАЦИЯ/logicrm.git /opt/logicrm
cd /opt/logicrm
```

### 2. Создаём файл переменных окружения

```bash
cp .env.example .env
nano .env
# Заполнить все обязательные поля (см. раздел 6)
chmod 600 .env
```

### 3. Получаем SSL-сертификат

```bash
sudo apt update && sudo apt install -y certbot

# Получаем сертификат (порт 80 должен быть свободен)
sudo certbot certonly --standalone -d yourdomain.com -d www.yourdomain.com

# Копируем реальные файлы (не симлинки — Docker их не разрешает)
sudo mkdir -p /opt/logicrm-certs
sudo cp /etc/letsencrypt/archive/yourdomain.com/fullchain1.pem /opt/logicrm-certs/fullchain.pem
sudo cp /etc/letsencrypt/archive/yourdomain.com/privkey1.pem   /opt/logicrm-certs/privkey.pem
sudo chmod 644 /opt/logicrm-certs/*.pem

# Прописываем ваш домен в nginx конфиге
sed -i 's/mankochat.ru/yourdomain.com/g' nginx/logicrm.conf
```

### 4. Применяем миграцию push-уведомлений (один раз)

```bash
# Запускаем только БД
docker compose up -d postgres
sleep 10

# Применяем миграцию
docker exec -i logicrm_db psql -U logicrm logicrm < backend/db/push_migration.sql
```

### 5. Собираем фронтенд

```bash
cd frontend
npm ci
npm run build
cd ..
```

### 6. Запускаем все контейнеры

```bash
docker compose up -d --build

# Проверяем статус
docker compose ps
```

Ожидаемый результат:
```
NAME                STATUS              PORTS
logicrm_db          Up (healthy)
logicrm_backend     Up
logicrm_nginx       Up                  0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
```

### 7. Проверяем работу

```bash
# Health check через nginx
curl -sk https://yourdomain.com/api/health
# {"ok":true,"ts":"2026-05-09T..."}

# Логи backend
docker logs logicrm_backend --tail 10
# [migrate] Готово ✓
# [worker XXXXX] LogiCRM API запущен на порту 3000 [production]
```

### 8. Первый вход

Откройте `https://yourdomain.com` в браузере:
- Email: значение `ADMIN_EMAIL` из `.env`
- Пароль: значение `ADMIN_PASSWORD` из `.env`

> ⚠️ Обязательно смените пароль сразу после первого входа через Настройки профиля.

---

## 6. Переменные окружения

### Обязательные (сервер не стартует без них)

```bash
# Пароль PostgreSQL
DB_PASSWORD=минимум_16_символов

# Секрет для подписи JWT (минимум 32 случайных символа)
JWT_SECRET=случайная_строка_минимум_32_символа

# CORS origin — точный адрес фронтенда
CORS_ORIGIN=https://yourdomain.com

# Пароль первого администратора (мин. 12 символов, буква+цифра+спецсимвол)
ADMIN_PASSWORD=СильныйПароль123!
```

### Полный список переменных

```bash
# ── База данных ───────────────────────────────────────────────────────────────
DB_NAME=logicrm                    # Имя базы данных
DB_USER=logicrm                    # Пользователь PostgreSQL
DB_PASSWORD=                       # ⚠️ ОБЯЗАТЕЛЬНО
DB_HOST=postgres                   # Хост (в Docker: имя сервиса postgres)
DB_PORT=5432                       # Порт PostgreSQL
DB_POOL_MAX=10                     # Максимальный размер пула соединений

# ── Приложение ────────────────────────────────────────────────────────────────
NODE_ENV=production                # production | development
PORT=3000                          # Внутренний порт Express
JWT_SECRET=                        # ⚠️ ОБЯЗАТЕЛЬНО
JWT_EXPIRES_IN=8h                  # Срок жизни токена: 1h, 8h, 24h, 7d
CORS_ORIGIN=                       # ⚠️ ОБЯЗАТЕЛЬНО в production
BCRYPT_ROUNDS=12                   # Раунды bcrypt (не менее 10)
WEB_CONCURRENCY=2                  # Кол-во Node.js воркеров (авто если не задано)

# ── Администратор ─────────────────────────────────────────────────────────────
ADMIN_EMAIL=admin@yourdomain.com   # Email первого администратора
ADMIN_PASSWORD=                    # ⚠️ ОБЯЗАТЕЛЬНО

# ── DaData (поиск по ИНН, опционально) ───────────────────────────────────────
# Ключ: https://dadata.ru/profile/#info
DADATA_API_KEY=

# ── Web Push (VAPID, опционально) ─────────────────────────────────────────────
# Генерация: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# ── Бэкапы в S3 (для backup-s3.sh) ───────────────────────────────────────────
S3_BUCKET=your-bucket
S3_PREFIX=backups
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_DEFAULT_REGION=ru-central1
# Для Yandex Object Storage раскомментировать:
# AWS_ENDPOINT_URL=https://storage.yandexcloud.net
```

### Генерация JWT_SECRET

```bash
# Linux/macOS
openssl rand -base64 32

# Node.js (любая платформа)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# PowerShell (Windows)
[System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

---

## 7. SSL-сертификаты

### Первичная настройка

```bash
# Устанавливаем certbot
sudo apt update && sudo apt install -y certbot

# Получаем сертификат (nginx должен быть остановлен)
docker stop logicrm_nginx 2>/dev/null || true
sudo certbot certonly --standalone -d yourdomain.com -d www.yourdomain.com

# Создаём папку для сертификатов (вне git-репозитория!)
sudo mkdir -p /opt/logicrm-certs

# Копируем реальные файлы (не симлинки)
# Certbot нумерует файлы: fullchain1.pem, fullchain2.pem...
LATEST_FULL=$(ls -t /etc/letsencrypt/archive/yourdomain.com/fullchain*.pem | head -1)
LATEST_KEY=$(ls -t /etc/letsencrypt/archive/yourdomain.com/privkey*.pem | head -1)
sudo cp "$LATEST_FULL" /opt/logicrm-certs/fullchain.pem
sudo cp "$LATEST_KEY"  /opt/logicrm-certs/privkey.pem
sudo chmod 644 /opt/logicrm-certs/fullchain.pem
sudo chmod 644 /opt/logicrm-certs/privkey.pem

# Запускаем nginx
docker compose up -d nginx
```

### Автоматическое обновление через webroot

Режим `webroot` позволяет обновлять сертификат без остановки nginx:

```bash
# Настраиваем webroot
sudo nano /etc/letsencrypt/renewal/yourdomain.com.conf
# Изменить: authenticator = nginx
# Добавить:  webroot_path = /var/www/certbot

# Добавляем deploy-hook (копирует обновлённые файлы + перезагружает nginx)
sudo bash -c 'echo "deploy-hook = /opt/logicrm/scripts/renew-certs.sh" >> /etc/letsencrypt/renewal/yourdomain.com.conf'
chmod +x /opt/logicrm/scripts/renew-certs.sh

# Проверяем (dry-run не применяет изменения)
sudo certbot renew --dry-run
# Ожидаем: "Simulating renewal of an existing certificate... The dry run was successful"
```

### Ручное обновление (если dry-run прошёл)

```bash
sudo certbot renew
# Если предлагает выбор — выбрать "2: Renew & replace"
```

---

## 8. Push-уведомления (VAPID)

### Генерация ключей

```bash
# На сервере или локально
npx web-push generate-vapid-keys
```

Вывод:
```
=======================================
Public Key:  BNxxx...длинная_строка
Private Key: xxx...короткая_строка
=======================================
```

### Добавление в .env на сервере

```bash
nano /opt/logicrm/.env
# Добавить:
VAPID_PUBLIC_KEY=BNxxx...
VAPID_PRIVATE_KEY=xxx...
```

### Применение (перезапуск контейнера)

```bash
cd /opt/logicrm
docker compose up -d --force-recreate backend
docker logs logicrm_backend --tail 5
# Строчки "[notifier] VAPID_PUBLIC_KEY не заданы" быть не должно
```

### Настройка времени уведомлений

По умолчанию уведомления отправляются в **9:00 UTC**. Для разных часовых поясов:

| Город | UTC | hour в коде |
|---|---|---|
| Москва (UTC+3) | 6:00 UTC | `hour !== 6` |
| Новосибирск (UTC+7) | 2:00 UTC | `hour !== 2` |
| Владивосток (UTC+10) | 23:00 UTC | `hour !== 23` |

```javascript
// backend/services/notifier.js — найди и замени в трёх функциях:
if (hour !== 6) return;  // Для Москвы: 9:00 MSK = 6:00 UTC
```

---

## 9. Миграции базы данных

### Основная схема (применяется автоматически)

При каждом запуске контейнера `backend` автоматически выполняется `node db/migrate.js`:
- Применяет `schema.sql` (idempotent — безопасно повторять)
- Создаёт 8 таблиц с триггерами и индексами (если не существуют)
- Если admin не существует — создаёт из `ADMIN_EMAIL` + `ADMIN_PASSWORD`

### Push migration (один раз вручную)

```bash
# Только при первоначальном развёртывании или на новом сервере
docker exec -i logicrm_db psql -U logicrm logicrm < backend/db/push_migration.sql

# Проверка
docker exec logicrm_db psql -U logicrm logicrm -c "\d push_subscriptions"
```

### Прямой доступ к PostgreSQL

```bash
# Интерактивный psql
docker exec -it logicrm_db psql -U logicrm logicrm

# Полезные команды внутри psql:
\dt              -- список таблиц
\d companies     -- структура таблицы companies
\di              -- все индексы
SELECT version(); -- версия PostgreSQL
\q               -- выход
```

### Просмотр текущих данных

```bash
# Количество записей в таблицах
docker exec logicrm_db psql -U logicrm logicrm -c "
  SELECT
    (SELECT count(*) FROM companies)    AS companies,
    (SELECT count(*) FROM deals)        AS deals,
    (SELECT count(*) FROM activities)   AS activities,
    (SELECT count(*) FROM users)        AS users;
"
```

---

## 10. Локальная разработка

### Предварительные требования

```bash
node --version   # v20.x.x
npm --version    # 10.x.x
```

### Запуск PostgreSQL через Docker (рекомендуется)

```bash
# Запускаем только базу данных
cd /путь/к/logicrm
docker compose up -d postgres
```

### Настройка backend

```bash
cd backend
cp ../.env.example .env
nano .env
```

Минимальный `.env` для разработки:
```bash
NODE_ENV=development
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=logicrm
DB_USER=logicrm
DB_PASSWORD=logicrm
JWT_SECRET=dev_secret_minimum_32_characters_long
CORS_ORIGIN=*
ADMIN_EMAIL=admin@local.dev
ADMIN_PASSWORD=DevPassword123!
WEB_CONCURRENCY=1
```

```bash
npm install

# Применяем схему БД
node db/migrate.js
# [migrate] Подключено к БД: logicrm
# [migrate] Схема применена
# [migrate] Admin создан: admin@local.dev

# Запуск с hot-reload
node --watch server.js
# [worker 12345] LogiCRM API запущен на порту 3000 [development]
```

### Запуск фронтенда

```bash
# В отдельном терминале
cd frontend
npm install
npm run dev
# Открыть: http://localhost:5173
# /api/* автоматически проксируется на http://localhost:3000
```

Прокси настроен в `vite.config.js`:
```javascript
server: {
  proxy: {
    '/api': { target: 'http://localhost:3000', changeOrigin: true }
  }
}
```

### Сборка фронтенда

```bash
cd frontend
npm run build    # Создаёт frontend/dist/
npm run preview  # Превью собранной версии на порту 4173
```

### Структура .env для разных окружений

```
.env               ← production (на сервере, в .gitignore)
.env.example       ← шаблон (в репозитории)
backend/.env       ← для локальной разработки backend (в .gitignore)
```

---

## 11. CI/CD через GitHub Actions

### Что происходит при `git push origin main`

```
┌─ job: security (параллельно) ──────────────────────────────────┐
│  1. npm audit --audit-level=high (backend)                      │
│  2. npm audit --audit-level=high (frontend)                     │
│  3. Gitleaks secret scan                                        │
└──────────────────────────────────────────────────────────────── ┘
              ↓ (только если security прошёл)
┌─ job: deploy ──────────────────────────────────────────────────┐
│  1. npm ci (frontend)                                           │
│  2. vite build → frontend/dist/                                 │
│  3. rsync backend/ → сервер (без node_modules, без .env)        │
│  4. rsync frontend/dist/ → сервер                               │
│  5. rsync nginx/ → сервер                                       │
│  6. rsync docker-compose.yml → сервер                           │
│  7. SSH: docker compose up --build --no-deps backend            │
│  8. SSH: health check (wget внутри контейнера)                  │
│  9. SSH: nginx -s reload                                        │
└──────────────────────────────────────────────────────────────── ┘
```

Время деплоя: ~3–5 минут.

### Обязательные секреты GitHub

Перейдите: репозиторий → **Settings → Secrets and variables → Actions → New repository secret**

| Секрет | Описание | Как получить |
|---|---|---|
| `SSH_PRIVATE_KEY` | Приватный SSH-ключ для деплоя | `cat ~/.ssh/logicrm_deploy` |
| `SSH_HOST` | IP-адрес сервера | Ваш IP, напр. `82.146.54.101` |
| `SSH_USER` | Пользователь на сервере | Обычно `deploy` |
| `DEPLOY_PATH` | Путь к проекту | `/opt/logicrm` |
| `SSH_HOST_KEY` | Публичный ключ сервера | `ssh-keyscan -t rsa,ecdsa,ed25519 IP 2>/dev/null` |

### Создание SSH-ключа для деплоя

```bash
# На локальном компьютере
ssh-keygen -t ed25519 -C "logicrm-github-actions" -f ~/.ssh/logicrm_deploy
# Passphrase — оставить пустым (нажать Enter дважды)

# Копируем публичный ключ на сервер
ssh-copy-id -i ~/.ssh/logicrm_deploy.pub deploy@82.146.54.101

# Проверяем
ssh -i ~/.ssh/logicrm_deploy deploy@82.146.54.101 "echo Подключение успешно"

# Смотрим приватный ключ для добавления в GitHub Secrets
cat ~/.ssh/logicrm_deploy
# -----BEGIN OPENSSH PRIVATE KEY-----
# ... весь текст включая BEGIN и END ...
# -----END OPENSSH PRIVATE KEY-----
```

### Получение SSH_HOST_KEY

```bash
# На сервере
ssh-keyscan -t rsa,ecdsa,ed25519 82.146.54.101 2>/dev/null
# 82.146.54.101 ssh-rsa AAAA...
# 82.146.54.101 ecdsa-sha2-nistp256 AAAA...
# 82.146.54.101 ssh-ed25519 AAAA...
# Скопировать ВСЕ 3 строки в секрет SSH_HOST_KEY
```

### Ручной запуск деплоя

В GitHub: Actions → последний workflow → **Re-run all jobs**

Или через GitHub CLI:
```bash
gh workflow run deploy.yml
```

### Ручной деплой без CI/CD

```bash
cd /opt/logicrm
git pull

# Только backend
docker compose up -d --build --no-deps backend

# Только nginx (после изменений конфига)
docker compose up -d --force-recreate nginx

# Полный перезапуск всего
docker compose down && docker compose up -d --build
```

---

## 12. Бэкапы

### Настройка автоматического бэкапа

```bash
# На сервере
chmod 750 /opt/logicrm/scripts/backup-s3.sh

# Тестовый запуск
/opt/logicrm/scripts/backup-s3.sh
# Ожидаем: "Backup completed successfully"

# Добавляем в crontab (каждую ночь в 2:00)
crontab -e
```

Добавить строку:
```cron
0 2 * * * /opt/logicrm/scripts/backup-s3.sh >> /var/log/logicrm-backup.log 2>&1
```

### Переменные для backup-s3.sh

В файле `.env` (или отдельном `.env.backup`):
```bash
S3_BUCKET=your-bucket-name
S3_PREFIX=logicrm/backups
BACKUP_DIR=/home/deploy/backups
RETENTION_LOCAL_DAYS=7       # Хранить локально 7 дней
RETENTION_S3_DAYS=90         # Хранить в S3 90 дней
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_DEFAULT_REGION=ru-central1

# Для Yandex Object Storage:
# AWS_ENDPOINT_URL=https://storage.yandexcloud.net
```

### Ручной бэкап

```bash
# Создать дамп немедленно
docker exec logicrm_db pg_dump -U logicrm logicrm \
  | gzip > /tmp/logicrm_manual_$(date +%Y%m%d_%H%M%S).sql.gz

echo "Размер бэкапа:"
ls -lh /tmp/logicrm_manual_*.sql.gz | tail -1
```

### Восстановление из бэкапа

```bash
# ⚠️ ВНИМАНИЕ: полностью заменяет текущие данные!

# Останавливаем backend (чтобы не было активных соединений)
docker compose stop backend

# Восстанавливаем
gunzip -c /path/to/logicrm_YYYYMMDD_HHMMSS.sql.gz \
  | docker exec -i logicrm_db psql -U logicrm logicrm

# Запускаем backend
docker compose start backend

# Проверяем
docker exec logicrm_db psql -U logicrm logicrm \
  -c "SELECT count(*) FROM companies;"
```

---

## 13. API — справочник эндпоинтов

**Base URL:** `https://yourdomain.com/api`

Все эндпоинты (кроме `/auth/login`) требуют JWT-токен в httpOnly cookie `logicrm_token`, который устанавливается при логине.

### Авторизация

| Метод | Путь | Тело запроса | Описание |
|---|---|---|---|
| `POST` | `/auth/login` | `{email, password}` | Вход. Rate limit: 20 req/15min |
| `POST` | `/auth/logout` | — | Выход, очищает cookie |
| `GET` | `/auth/me` | — | Данные текущего пользователя |
| `POST` | `/auth/password` | `{old_password, new_password}` | Смена пароля. Rate limit: 5 req/15min |

### Компании

| Метод | Путь | Параметры | Описание |
|---|---|---|---|
| `GET` | `/companies` | `?owner_id=&segment=&priority=&q=` | Список (manager — только свои) |
| `GET` | `/companies/:id` | — | Одна компания |
| `POST` | `/companies` | CreateCompanySchema | Создать |
| `PUT` | `/companies/:id` | UpdateCompanySchema | Обновить |
| `DELETE` | `/companies/:id` | — | Удалить (admin/head) |
| `POST` | `/companies/bulk` | `{ids[], action, value}` | Массовые действия |

Допустимые `action` для bulk: `segment`, `priority`, `owner` (head/admin), `tag`, `next_action`, `delete` (head/admin).

### Контакты

| Метод | Путь | Параметры | Описание |
|---|---|---|---|
| `GET` | `/contacts` | `?company_id=` (обязателен) | Контакты компании |
| `GET` | `/contacts/:id` | — | Один контакт |
| `POST` | `/contacts` | CreateContactSchema | Создать |
| `PUT` | `/contacts/:id` | UpdateContactSchema | Обновить |
| `DELETE` | `/contacts/:id` | — | Удалить |

### Сделки

| Метод | Путь | Параметры | Описание |
|---|---|---|---|
| `GET` | `/deals` | `?company_id=&owner_id=&stage=&outcome=` | Список |
| `GET` | `/deals/:id` | — | Одна сделка |
| `POST` | `/deals` | CreateDealSchema | Создать |
| `PUT` | `/deals/:id` | UpdateDealSchema | Обновить |
| `PATCH` | `/deals/:id/stage` | `{stage}` | Сменить стадию (10 вариантов) |
| `PATCH` | `/deals/:id/close` | `{outcome, loss_reason}` | Закрыть (won/lost/postponed) |
| `PATCH` | `/deals/:id/reopen` | — | Возобновить (→ in_progress) |
| `DELETE` | `/deals/:id` | — | Удалить (admin/head) |

### Активности

| Метод | Путь | Параметры | Описание |
|---|---|---|---|
| `GET` | `/activities` | `?company_id=&deal_id=&owner_id=` | Список |
| `GET` | `/activities/:id` | — | Одна активность |
| `POST` | `/activities` | CreateActivitySchema | Создать |
| `PUT` | `/activities/:id` | UpdateActivitySchema | Обновить |
| `DELETE` | `/activities/:id` | — | Удалить |

### Логистические заявки

| Метод | Путь | Параметры | Описание |
|---|---|---|---|
| `GET` | `/requests` | `?company_id=&status=&transport_type=&owner_id=&q=` | Список |
| `GET` | `/requests/:id` | — | Одна заявка |
| `POST` | `/requests` | CreateRequestSchema | Создать |
| `PUT` | `/requests/:id` | UpdateRequestSchema | Обновить |
| `PATCH` | `/requests/:id/status` | `{status, loss_reason}` | Сменить статус |
| `DELETE` | `/requests/:id` | — | Удалить (admin/head) |

Статусы: `new` → `calculating` → `quoted` → `won` / `lost` / `cancelled`

### Перевозчики

| Метод | Путь | Параметры | Описание |
|---|---|---|---|
| `GET` | `/carriers` | `?q=&transport_type=&active=all\|true\|false` | Список |
| `GET` | `/carriers/:id` | — | Один перевозчик |
| `POST` | `/carriers` | CreateCarrierSchema | Создать |
| `PUT` | `/carriers/:id` | UpdateCarrierSchema | Обновить |
| `DELETE` | `/carriers/:id` | — | Удалить (admin/head) |

### Планы продаж

| Метод | Путь | Параметры | Описание |
|---|---|---|---|
| `GET` | `/plans` | `?year=&month=` | Планы команды + факт (head/admin) |
| `GET` | `/plans/my` | `?year=&month=` | Мой план + факт + прогресс по 7 показателям |
| `POST` | `/plans` | `{user_id, year, month, target_*}` | Создать/обновить план (head/admin) |
| `POST` | `/plans/copy-month` | `{from_year, from_month, to_year, to_month}` | Копировать все планы команды |
| `DELETE` | `/plans/:id` | — | Удалить план (head/admin) |

### Отчёты

Все отчёты принимают `?from=YYYY-MM-DD&to=YYYY-MM-DD&owner_id=UUID`

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/reports/summary` | Сводка: компании, сделки, активности, заявки |
| `GET` | `/reports/funnel` | Воронка по 10 стадиям (кол-во + pipeline) |
| `GET` | `/reports/team` | Показатели каждого менеджера (head/admin) |
| `GET` | `/reports/activity` | Активности по типам |
| `GET` | `/reports/loss-reasons` | Причины проигрышей сделок |
| `GET` | `/reports/timeline` | Динамика по дням/неделям `?group=day\|week` |

### Push-уведомления

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/notifications/vapid-key` | Публичный VAPID ключ для браузера |
| `GET` | `/notifications/status?endpoint=` | Проверить активна ли подписка |
| `POST` | `/notifications/subscribe` | Сохранить подписку браузера |
| `DELETE` | `/notifications/subscribe` | Удалить подписку (отключить) |
| `POST` | `/notifications/test` | Отправить тестовое уведомление |

### Прочее

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/search?q=текст&limit=20` | Глобальный поиск (мин. 2 символа) |
| `GET` | `/lookup/inn/:inn` | Поиск компании по ИНН (DaData) |
| `GET` | `/users` | Список пользователей |
| `POST` | `/users` | Создать пользователя (admin) |
| `PATCH` | `/users/:id/active` | Заблокировать/активировать (admin) |
| `POST` | `/import/companies` | Массовый импорт из CSV (до 5000 строк) |
| `GET` | `/import/template` | Скачать шаблон CSV |
| `GET` | `/health` | Health check → `{"ok":true,"ts":"..."}` |

---

## 14. Роли и права доступа

Система использует четыре роли. Каждый JWT-токен содержит поле `role`.

| Ресурс | admin | head | manager | ops |
|---|---|---|---|---|
| Пользователи | CRUD | R | R (только имена) | — |
| Компании | все | все | только свои | — |
| Контакты | все | все | только своих компаний | — |
| Сделки | все | все | только свои | — |
| Активности | все | все | только свои | — |
| Заявки | все | все | только свои | свои |
| Перевозчики | CRUD | CRUD | R | R |
| Планы | CRUD | CRUD | R (только свой) | — |
| Отчёты | все | все | только свои данные | — |
| Импорт | ✓ | ✓ | ✓ (owner_id = себе) | — |
| Массовые действия | все | все | только свои | — |
| Назначить owner другому | ✓ | ✓ | — | — |
| Удалять записи | ✓ | ✓ | — | — |

**Технические механизмы:**
- `requireRole('admin', 'head')` — middleware для ограничения по роли
- `ownerScope(req)` — добавляет `WHERE owner_id = userId` для manager в отчётах
- `canModify(record, user)` — проверяет владение в deals/activities/requests
- `assertCompanyAccess(companyId, user)` — IDOR-защита в contacts

---

## 15. База данных

### 8 таблиц и их связи

```
users
  ├── companies         owner_id → SET NULL при удалении пользователя
  │     ├── contacts    company_id → CASCADE DELETE
  │     ├── deals       company_id → CASCADE DELETE
  │     │     ├── activities  deal_id → SET NULL
  │     │     └── requests    deal_id → SET NULL
  │     ├── activities  company_id → CASCADE DELETE
  │     └── requests    company_id → SET NULL
  ├── plans             user_id → CASCADE DELETE
  └── push_subscriptions  user_id → CASCADE DELETE

carriers
  └── requests          carrier_id → SET NULL
```

### Ключевые индексы

```sql
-- GIN-индекс для полнотекстового поиска на русском
CREATE INDEX idx_companies_name ON companies
  USING gin(to_tsvector('russian', name));

-- Частичный индекс только для незавершённых задач
-- (быстрый доступ к активным задачам без сканирования выполненных)
CREATE INDEX idx_activities_next_step_due ON activities(next_step_due)
  WHERE next_step_due IS NOT NULL AND is_done = false;

-- Уникальный составной индекс (один план на пользователя в месяц)
UNIQUE (user_id, year, month) ON plans;

-- Уникальный индекс (один endpoint = одна подписка)
UNIQUE (endpoint) ON push_subscriptions;
```

### Автоматические триггеры

На таблицах `companies`, `contacts`, `deals`, `activities`, `plans` установлен триггер `set_updated_at`, который обновляет поле `updated_at` при любом UPDATE.

### JSONB-поля

| Таблица | Поле | Содержимое |
|---|---|---|
| companies | regions | `["Москва", "Урал"]` |
| companies | cargo_types | `["general", "adr"]` |
| companies | directions | `["road", "sea"]` |
| companies | routes | `[{"from": "Москва", "to": "СПб"}]` |
| companies | tags | `["тендер", "ключевой"]` |
| deals | stage_history | `[{"stage": "new_lead", "from": null, "at": "...", "by_user_id": "..."}]` |
| carriers | transport_types | `["auto", "rail"]` |

---

## 16. Обновление и обслуживание

### Стандартное обновление через git push

```bash
# Редактируем локально, коммитим и пушим
git add .
git commit -m "feat: описание изменения"
git push origin main
# GitHub Actions автоматически задеплоит через ~3-5 минут
```

### Обновление вручную на сервере

```bash
cd /opt/logicrm
git pull

# Если менялся frontend
cd frontend && npm ci && npm run build && cd ..

# Перезапуск backend
docker compose up -d --build --no-deps backend

# Перезапуск nginx (после изменений nginx.conf)
docker compose up -d --force-recreate nginx

# Проверка
docker compose ps
docker exec logicrm_backend wget -qO- http://localhost:3000/api/health
```

### Обновление зависимостей backend

```bash
cd backend

# Проверить устаревшие пакеты
npm outdated

# Обновить всё (minor и patch)
npm update

# Проверить уязвимости
npm audit

# Исправить некритичные
npm audit fix

# Обновить package-lock.json и закоммитить
git add package-lock.json
git commit -m "chore: update npm dependencies"
git push
```

### Обновление Docker-образов

```bash
cd /opt/logicrm

# Скачать новые версии образов
docker compose pull

# Пересобрать с новыми образами
docker compose up -d --build

# Удалить старые образы
docker image prune -f
```

### Мониторинг ресурсов

```bash
# Потребление CPU/RAM контейнерами
docker stats --no-stream

# Место на диске
docker system df

# Свободное место на хосте
df -h /

# Размер volumes
du -sh /var/lib/docker/volumes/logicrm_pgdata
```

---

## 17. Диагностика и решение проблем

### Основные команды

```bash
# Статус контейнеров
docker compose ps

# Health check
docker exec logicrm_backend wget -qO- http://localhost:3000/api/health

# Логи всех контейнеров
docker compose logs --tail 30 --follow

# Логи отдельных контейнеров
docker logs logicrm_backend --tail 50 -f
docker logs logicrm_nginx   --tail 30
docker logs logicrm_db      --tail 20
```

### Проблема: сервер не стартует — "Обязательная переменная не задана"

```bash
# Проверяем .env
grep -v "^#" /opt/logicrm/.env | grep -v "^$"

# Проверяем что переменные попали в контейнер
docker exec logicrm_backend env | grep -E "DB_PASSWORD|JWT_SECRET|ADMIN_PASSWORD"
# Если пусто — переменные не переданы в docker-compose.yml
```

### Проблема: ERR_MODULE_NOT_FOUND при старте

```bash
docker logs logicrm_backend | grep "Cannot find module"
# Пример: Cannot find module '/app/routes/deals.js'

# Причина: файл не скопирован в контейнер
# Решение: пересобрать образ без кеша
docker compose up -d --build --no-cache --no-deps backend
```

### Проблема: nginx не может загрузить SSL-сертификат

```bash
docker logs logicrm_nginx | grep "emerg"
# cannot load certificate "/etc/nginx/ssl/fullchain.pem"

# Проверяем что файлы существуют на хосте (должны быть реальные файлы, не симлинки)
ls -la /opt/logicrm-certs/
file /opt/logicrm-certs/fullchain.pem
# Должно быть: "PEM certificate", а не "symbolic link"

# Если симлинки — копируем реальные файлы
sudo cp /etc/letsencrypt/archive/yourdomain.com/fullchain2.pem /opt/logicrm-certs/fullchain.pem
sudo cp /etc/letsencrypt/archive/yourdomain.com/privkey2.pem   /opt/logicrm-certs/privkey.pem
sudo chmod 644 /opt/logicrm-certs/*.pem
docker compose up -d --force-recreate nginx
```

### Проблема: 502 Bad Gateway

```bash
# Backend не отвечает
docker logs logicrm_backend --tail 20
docker exec logicrm_backend wget -qO- http://localhost:3000/api/health

# PostgreSQL не здоров
docker inspect logicrm_db | python3 -c "import sys,json; data=json.load(sys.stdin); print(data[0]['State']['Health']['Status'])"
docker exec logicrm_db pg_isready -U logicrm
```

### Проблема: YAML error в docker-compose

```bash
# Проверяем синтаксис
docker compose config --quiet
# Ошибка покажет строку

# Общие причины:
# - Вкладки вместо пробелов
# - Неверный отступ после редактирования nano
cat -A docker-compose.yml | grep -n "	"  # ищем символы Tab
```

### Проблема: Push уведомления не приходят

```bash
# 1. Проверяем VAPID ключи в контейнере
docker exec logicrm_backend env | grep VAPID
# Должны быть оба ключа

# 2. Проверяем endpoint API
curl -sk https://yourdomain.com/api/notifications/vapid-key \
  -H "Cookie: logicrm_token=ВАШ_ТОКЕН"

# 3. Проверяем таблицу подписок
docker exec logicrm_db psql -U logicrm logicrm \
  -c "SELECT count(*), user_id FROM push_subscriptions GROUP BY user_id;"

# 4. Тестовое уведомление через API
curl -sk -X POST https://yourdomain.com/api/notifications/test \
  -H "Cookie: logicrm_token=ВАШ_ТОКЕН"
```

### Проблема: Сборка frontend падает

```bash
# top-level await error
grep "target" frontend/vite.config.js
# Должно быть: target: 'esnext'

# Зависимости устарели
cd frontend && npm ci

# Аудит уязвимостей
npm audit
npm audit fix
```

### Проблема: CI/CD падает на security scan

```bash
# npm audit показывает HIGH уязвимости
cd backend && npm audit --audit-level=high

# Исправить
npm audit fix

# Если не помогает — обновить конкретный пакет
npm update имя_пакета
```

### Откат к предыдущей версии

```bash
# Через git на сервере
cd /opt/logicrm
git log --oneline -10

# Откатить конкретный файл
git checkout ХЭШ~1 -- backend/routes/companies.js

# Пересобрать
docker compose up -d --build --no-deps backend
```

---

## 18. Безопасность

### Реализованные меры

| Категория | Мера |
|---|---|
| **Аутентификация** | JWT HS256 с явным algorithm pinning в verify() и sign() |
| **Сессия** | httpOnly + SameSite=strict cookie, срок из JWT_EXPIRES_IN |
| **Пароли** | bcrypt 12 раундов, мин. 12 символов, требования к сложности |
| **Rate limiting** | login: 20/15min, password change: 5/15min |
| **Перебор email** | Одинаковый ответ 401 для неверного пароля и неактивного аккаунта |
| **Temp пароли** | `crypto.randomInt` (не Math.random) |
| **RBAC** | owner-based filtering, requireRole middleware |
| **IDOR** | assertCompanyAccess() для contacts, canModify() для requests |
| **SQL injection** | Parameterized queries через Knex и pg |
| **XSS** | escHtml с полным набором: `& < > " '` |
| **Mass assignment** | Zod `.strip()` убирает лишние поля |
| **Security headers** | helmet: CSP, HSTS, X-Frame-Options, nosniff, referrer |
| **CORS** | Точный origin в production |
| **Supply chain** | npm ci --ignore-scripts в Dockerfile |
| **Container** | USER node (non-root), cap_drop: ALL на backend и nginx |
| **Network** | Backend и DB только expose (недоступны снаружи Docker-сети) |
| **Secrets** | .env исключён из образа через .dockerignore |
| **CI security** | npm audit + Gitleaks перед каждым деплоем |
| **TLS** | TLSv1.2+, ECDHE+GCM+ChaCha20, ssl_prefer_server_ciphers off |
| **Nginx** | server_tokens off, HSTS preload, ssl_stapling |
| **VAPID** | endpoint валидируется как URL перед сохранением в БД |

### Обязательный чеклист при развёртывании

- [ ] Сменить `ADMIN_PASSWORD` сразу после первого входа
- [ ] Убедиться что `nginx/ssl/` пустой (ключи в `/opt/logicrm-certs/`)
- [ ] Проверить что `.env` не попал в git: `git log --all -- .env`
- [ ] Добавить `SSH_HOST_KEY` в GitHub Secrets
- [ ] Настроить certbot deploy-hook для автообновления сертификатов
- [ ] Настроить cron для backup-s3.sh
- [ ] Проверить `npm audit` показывает 0 HIGH уязвимостей

### Roadmap безопасности

- [ ] Redis + JWT denylist (отзыв токенов при logout и смене пароля)
- [ ] audit_log таблица (история всех действий пользователей)
- [ ] Per-email rate limiting через Redis (защита от перебора одного аккаунта)
- [ ] Push-дедупликация через БД вместо in-memory Set (выживает рестарт)
- [ ] Password reset через email (сейчас только через admin)
- [ ] CSP nonces вместо unsafe-inline
- [ ] Trivy image scanning в CI/CD
- [ ] Полная миграция с pool.js на Knex (auth, users, search, import, notifications)
- [ ] Тесты (node:test + supertest): auth flows, RBAC, import, search
- [ ] Обновление Node.js 20 → 22 LTS (Node 20 EOL: апрель 2026)

---

*Документация актуальна для LogiCRM версии, развёрнутой на mankochat.ru*
