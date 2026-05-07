-- push_subscriptions: хранит Web Push подписки пользователей
-- Каждый браузер/устройство — отдельная строка (один юзер может иметь несколько)
-- CASCADE DELETE: при удалении пользователя подписки удаляются автоматически

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT        NOT NULL UNIQUE,    -- URL endpoint от браузера
  p256dh      TEXT        NOT NULL,           -- публичный ключ для шифрования
  auth        TEXT        NOT NULL,           -- auth secret
  user_agent  TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
