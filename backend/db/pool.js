/**
 * db/pool.js — синглтон pg.Pool.
 * Экспортирует:
 *   pool  — pg.Pool для прямых запросов
 *   query — обёртка pool.query с логированием медленных запросов
 *   tx    — хелпер для транзакций: tx(async client => { ... })
 */

import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({
  host:              config.db.host,
  port:              config.db.port,
  database:          config.db.database,
  user:              config.db.user,
  password:          config.db.password,
  ssl:               config.db.ssl,
  max:               config.db.max,
  idleTimeoutMillis: config.db.idleTimeoutMs,
  connectionTimeoutMillis: config.db.connectTimeoutMs,
});

pool.on('error', (err) => {
  console.error('[db] Неожиданная ошибка клиента пула:', err.message);
});

/**
 * Выполнить SQL-запрос. Логирует запросы дольше 300мс.
 */
export async function query(sql, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(sql, params);
    const ms = Date.now() - start;
    if (ms > 300) {
      console.warn(`[db] SLOW QUERY (${ms}ms):`, sql.slice(0, 120));
    }
    return result;
  } catch (err) {
    console.error('[db] Query error:', err.message, '\nSQL:', sql.slice(0, 200));
    throw err;
  }
}

/**
 * Транзакция. Автоматически делает ROLLBACK при исключении.
 * Пример:
 *   const result = await tx(async (client) => {
 *     await client.query('INSERT ...');
 *     await client.query('UPDATE ...');
 *     return { ok: true };
 *   });
 */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Проверить соединение с БД при старте сервера.
 */
export async function checkConnection() {
  const client = await pool.connect();
  const { rows } = await client.query('SELECT NOW() AS now, current_database() AS db');
  client.release();
  console.log(`[db] Подключено: ${rows[0].db} @ ${new Date(rows[0].now).toISOString()}`);
}
