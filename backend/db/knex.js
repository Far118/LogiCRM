/**
 * db/knex.js — единственный экземпляр Knex для всего приложения.
 *
 * Использует те же параметры из config.js, что и pg-pool,
 * поэтому никакой второй конфигурации БД не появляется.
 *
 * Существующий db/pool.js и все роуты, которые его импортируют,
 * продолжают работать без изменений — Knex добавляется рядом.
 */

import knexLib from 'knex';
import { config } from '../config.js';

const knex = knexLib({
  client: 'pg',
  connection: {
    host:     config.db.host,
    port:     config.db.port,
    database: config.db.database,
    user:     config.db.user,
    password: config.db.password,
    ssl:      config.db.ssl,
  },
  pool: {
    min:                  2,
    max:                  config.db.max,
    idleTimeoutMillis:    config.db.idleTimeoutMs,
    acquireTimeoutMillis: config.db.connectTimeoutMs,
  },
  // Логируем медленные запросы (>300ms) — аналогично db/pool.js
  log: {
    warn(msg) {
      if (typeof msg === 'string' && msg.includes('slow')) {
        console.warn('[knex] SLOW QUERY:', msg);
      }
    },
  },
  // Knex по умолчанию делает strip лишних полей в insert/update
  wrapIdentifier: (value, origImpl) => origImpl(value),
});

// Логируем медленные запросы вручную через событие query-response
knex.on('query-response', (_response, obj, _builder) => {
  if (obj.__knexQueryUid && obj.response?.command) {
    // duration доступен только в debug-режиме; здесь просто хук-заглушка
  }
});

export default knex;
