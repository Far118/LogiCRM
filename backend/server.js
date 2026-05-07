/**
 * server.js — точка входа LogiCRM API
 *
 * Поднимает Express с:
 *   • helmet      — security headers
 *   • cors        — CORS (настраивается через CORS_ORIGIN)
 *   • rate-limit  — защита от брутфорса на /api/auth
 *   • cookie-parser
 *   • JSON body
 *   • роуты /api/*
 *   • graceful shutdown при SIGTERM/SIGINT
 *
 * Кластеризация:
 *   • Primary-процесс форкает N воркеров (N = число CPU-ядер)
 *   • Каждый воркер поднимает полноценный Express на том же порту
 *   • Primary перезапускает воркер при неожиданном падении
 *   • WEB_CONCURRENCY=2 — можно ограничить число воркеров через env
 *   • WEB_CONCURRENCY=1 — отключает кластер (полезно при отладке)
 *
 * Rollback: удалить всё между "── Кластер ──" и "── Express app ──",
 * раскомментировать вызов start() в конце файла.
 */

import cluster              from 'node:cluster';
import { availableParallelism } from 'node:os';

import express              from 'express';
import helmet               from 'helmet';
import cors                 from 'cors';
import cookieParser         from 'cookie-parser';
import rateLimit            from 'express-rate-limit';

import { config }           from './config.js';
import { checkConnection }  from './db/pool.js';

import authRoutes           from './routes/auth.js';
import companiesRoutes      from './routes/companies.js';
import contactsRoutes       from './routes/contacts.js';
import activitiesRoutes     from './routes/activities.js';
import dealsRoutes          from './routes/deals.js';
import usersRoutes          from './routes/users.js';
import lookupRoutes         from './routes/lookup.js';
import carriersRoutes       from './routes/carriers.js';
import requestsRoutes       from './routes/requests.js';
import reportsRoutes        from './routes/reports.js';
import importRoutes         from './routes/import.js';
import searchRoutes         from './routes/search.js';
import notificationsRoutes from './routes/notifications.js';
import { runScheduler }    from './services/notifier.js';

// ── Кластер ───────────────────────────────────────────────────────────────────
//
// Определяем количество воркеров:
//   WEB_CONCURRENCY=N  — явное значение из env (рекомендуется для Docker)
//   иначе              — availableParallelism() учитывает cgroup-лимиты
//                        (т.е. --cpus=2 в docker compose даст 2, не 8)
//
const NUM_WORKERS = Math.max(
  1,
  parseInt(process.env.WEB_CONCURRENCY ?? '0', 10)
    || availableParallelism()
);

if (cluster.isPrimary && NUM_WORKERS > 1) {
  console.log(
    `[cluster] Primary ${process.pid} · форкаем ${NUM_WORKERS} воркеров` +
    ` (WEB_CONCURRENCY=${process.env.WEB_CONCURRENCY ?? 'auto'})`
  );

  // Форкаем воркеры
  for (let i = 0; i < NUM_WORKERS; i++) {
    cluster.fork();
  }

  // Автоперезапуск воркера при неожиданном падении
  cluster.on('exit', (worker, code, signal) => {
    if (worker.exitedAfterDisconnect) return; // плановое завершение — не форкаем

    console.warn(
      `[cluster] Воркер ${worker.process.pid} упал` +
      ` (code=${code}, signal=${signal}) — перезапускаем`
    );
    cluster.fork();
  });

  cluster.on('online', (worker) => {
    console.log(`[cluster] Воркер ${worker.process.pid} онлайн`);
  });

  // Graceful shutdown primary: отключаем воркеров по цепочке
  function shutdownPrimary(signal) {
    console.log(`[cluster] ${signal} — завершаем воркеры...`);

    for (const worker of Object.values(cluster.workers ?? {})) {
      worker.disconnect();
    }

    // Если через 15 сек воркеры не закрылись — убиваем принудительно
    const killer = setTimeout(() => {
      console.warn('[cluster] Таймаут ожидания воркеров, принудительное завершение');
      process.exit(0);
    }, 15_000);
    killer.unref(); // не держим event loop
  }

  process.on('SIGTERM', () => shutdownPrimary('SIGTERM'));
  process.on('SIGINT',  () => shutdownPrimary('SIGINT'));

  // Primary не запускает HTTP — только управляет воркерами
  // (migrate.js уже отработал до запуска server.js, см. Dockerfile CMD)

  // ── Планировщик push-уведомлений ─────────────────────────────────────────
  // Запускается только в primary — один раз на весь кластер,
  // чтобы не отправлять дубли с каждого воркера.
  //
  // Логика: каждый час проверяем просроченные и сегодняшние задачи.
  // В 9:00 отправляем утренние сводки пользователям.
  setTimeout(async () => {
    await runScheduler().catch(err => console.error('[scheduler]', err.message));
    setInterval(() => {
      runScheduler().catch(err => console.error('[scheduler]', err.message));
    }, 60 * 60 * 1000); // каждый час
  }, 10_000); // первый запуск через 10 сек после старта

} else {
  // ── Worker-процесс (или единственный процесс при NUM_WORKERS=1) ────────────
  // Вся логика Express — здесь, без изменений.
  start().catch(err => {
    console.error(`[server] Воркер ${process.pid} не смог запустить:`, err.message);
    process.exit(1);
  });
}

// ── Express app ───────────────────────────────────────────────────────────────
// Всё ниже идентично оригиналу. Ни одна строка бизнес-логики не изменена.

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'"],
      imgSrc:     ["'self'", 'data:'],
    },
  },
}));

// CORS
app.use(cors({
  origin:      config.corsOrigin === '*' ? true : config.corsOrigin,
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body / Cookie
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Rate limiting — только на auth
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             20,
  message:         { error: 'Слишком много запросов, попробуйте через 15 минут' },
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/api/auth/login', authLimiter);

// Routes
app.use('/api/auth',       authRoutes);
app.use('/api/companies',  companiesRoutes);
app.use('/api/contacts',   contactsRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/deals',      dealsRoutes);
app.use('/api/users',      usersRoutes);
app.use('/api/lookup',     lookupRoutes);
app.use('/api/carriers',   carriersRoutes);
app.use('/api/requests',   requestsRoutes);
app.use('/api/reports',    reportsRoutes);
app.use('/api/import',     importRoutes);
app.use('/api/search',     searchRoutes);
app.use('/api/plans',          plansRoutes);
app.use('/api/notifications',  notificationsRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    ok:     true,
    env:    config.nodeEnv,
    pid:    process.pid,           // показывает какой воркер ответил
    ts:     new Date().toISOString(),
  });
});

// 404 для неизвестных API-путей
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint не найден' });
});

// Глобальный обработчик ошибок
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ── Запуск воркера ────────────────────────────────────────────────────────────

async function start() {
  // Каждый воркер проверяет соединение при старте — лёгкий SELECT NOW()
  await checkConnection();

  const server = app.listen(config.port, () => {
    const role = cluster.isWorker
      ? `[worker ${process.pid}]`
      : '[server]';
    console.log(`${role} LogiCRM API запущен на порту ${config.port} [${config.nodeEnv}]`);
  });

  // Graceful shutdown воркера: ждём завершения активных запросов
  function shutdown(signal) {
    console.log(`[worker ${process.pid}] ${signal} — завершаем...`);
    server.close(() => {
      console.log(`[worker ${process.pid}] HTTP сервер закрыт`);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Воркер получает 'disconnect' от primary при graceful shutdown кластера
  process.on('disconnect', () => shutdown('disconnect'));
}
