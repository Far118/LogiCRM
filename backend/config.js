/**
 * config.js — единая точка конфигурации.
 *
 * Исправления (аудит):
 *   1.1  ADMIN_PASSWORD теперь обязателен через require_env (нет дефолта ChangeMe123!)
 *   3.3  CORS_ORIGIN обязателен в production; в development разрешаем '*' явно
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

const isProd = process.env.NODE_ENV === 'production';

// В production CORS_ORIGIN обязателен — '*' + credentials не работает в браузере,
// но его отсутствие в dev неудобно. Поэтому: в production — require, иначе — '*'.
function getCorsOrigin() {
  const v = process.env.CORS_ORIGIN;
  if (!v && isProd) {
    console.error('[config] CORS_ORIGIN обязателен в production');
    process.exit(1);
  }
  return v ?? '*';
}

export const config = {
  port:    parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd,

  db: {
    host:     process.env.DB_HOST     ?? 'localhost',
    port:     parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME     ?? 'logicrm',
    user:     process.env.DB_USER     ?? 'logicrm',
    password: require_env('DB_PASSWORD'),
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max:              parseInt(process.env.DB_POOL_MAX ?? '10', 10),
    idleTimeoutMs:    30_000,
    connectTimeoutMs:  5_000,
  },

  jwt: {
    secret:     require_env('JWT_SECRET'),
    expiresIn:  process.env.JWT_EXPIRES_IN ?? '8h',
    cookieName: 'logicrm_token',
  },

  corsOrigin: getCorsOrigin(),

  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10),

  // Аудит 1.1: ADMIN_PASSWORD без дефолта — сервер не стартует без явного значения
  adminEmail:    process.env.ADMIN_EMAIL    ?? 'admin@logicrm.local',
  adminPassword: require_env('ADMIN_PASSWORD'),

  dadataApiKey:    process.env.DADATA_API_KEY    ?? '',
  vapidPublicKey:  process.env.VAPID_PUBLIC_KEY  ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
};
