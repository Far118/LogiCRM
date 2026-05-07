/**
 * migrate.js — создаёт схему и seed-данные.
 * Запуск: node db/migrate.js
 * Идемпотентен: можно запускать повторно без потери данных.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const pool = new pg.Pool({
    host:     config.db.host,
    port:     config.db.port,
    database: config.db.database,
    user:     config.db.user,
    password: config.db.password,
    ssl:      config.db.ssl,
  });

  const client = await pool.connect();
  console.log('[migrate] Подключено к БД:', config.db.database);

  try {
    // ── Применяем схему ────────────────────────────────────────────
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('[migrate] Схема применена');

    // ── Seed: первый admin ─────────────────────────────────────────
    const { rows } = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [config.adminEmail]
    );

    if (rows.length === 0) {
      const hash = await bcrypt.hash(config.adminPassword, config.bcryptRounds);
      await client.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active)
         VALUES ($1, $2, $3, $4, 'admin', true)`,
        [config.adminEmail, hash, 'Администратор', '']
      );
      console.log(`[migrate] Создан admin: ${config.adminEmail}`);
      console.log(`[migrate] Пароль: ${config.adminPassword}  ← СМЕНИТЕ ПОСЛЕ ВХОДА`);
    } else {
      console.log('[migrate] Admin уже существует, пропускаем seed');
    }

    console.log('[migrate] Готово ✓');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('[migrate] Ошибка:', err.message);
  process.exit(1);
});
