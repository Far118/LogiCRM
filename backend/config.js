/**
 * config.js — единая точка конфигурации.
 * Все значения берутся из переменных окружения (.env).
 * При запуске приложение явно завершается, если обязательные
 * переменные отсутствуют — это лучше, чем молчаливые ошибки в runtime.
 */

import 'dotenv/config';

function require_env(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[config] Обязательная переменная окружения ${name} не задана`);
    process.exit(1);
  }
  return val;
}

export const config = {
  // ── Сервер ──────────────────────────────────────────────────────────
  port:     parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv:  process.env.NODE_ENV ?? 'development',
  isProd:   process.env.NODE_ENV === 'production',

  // ── PostgreSQL ───────────────────────────────────────────────────────
  db: {
    host:     process.env.DB_HOST     ?? 'localhost',
    port:     parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME     ?? 'logicrm',
    user:     process.env.DB_USER     ?? 'logicrm',
    password: require_env('DB_PASSWORD'),
    ssl:      process.env.DB_SSL === 'true'
              ? { rejectUnauthorized: false }
              : false,
    // Размер пула подключений
    max:             parseInt(process.env.DB_POOL_MAX ?? '10', 10),
    idleTimeoutMs:   30_000,
    connectTimeoutMs: 5_000,
  },

  // ── JWT ──────────────────────────────────────────────────────────────
  jwt: {
    secret:     require_env('JWT_SECRET'),
    expiresIn:  process.env.JWT_EXPIRES_IN ?? '8h',
    cookieName: 'logicrm_token',
  },

  // ── CORS ─────────────────────────────────────────────────────────────
  // В production укажи точный origin. В development разрешаем всё.
  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  // ── Bcrypt ───────────────────────────────────────────────────────────
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10),

  // ── Admin seed ───────────────────────────────────────────────────────
  adminEmail:    process.env.ADMIN_EMAIL    ?? 'admin@logicrm.local',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'ChangeMe123!',

  // Dadata API (поиск по ИНН): https://dadata.ru/profile/#info
  dadataApiKey: process.env.DADATA_API_KEY ?? '',
vapidPublicKey:  process.env.VAPID_PUBLIC_KEY  || '',
vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
};
