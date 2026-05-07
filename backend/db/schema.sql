-- ─────────────────────────────────────────────────────────────────────────────
-- LogiCRM — schema.sql
-- Полная схема БД. Запускается один раз через `node db/migrate.js`.
-- Все таблицы идемпотентны (IF NOT EXISTS), индексы — CREATE INDEX IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

-- Включаем расширение для UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Пользователи ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT        UNIQUE NOT NULL,
  password_hash         TEXT        NOT NULL,
  first_name            TEXT        NOT NULL DEFAULT '',
  last_name             TEXT        NOT NULL DEFAULT '',
  role                  TEXT        NOT NULL DEFAULT 'manager'
                          CHECK (role IN ('admin','head','manager','ops')),
  is_active             BOOLEAN     NOT NULL DEFAULT true,
  force_password_change BOOLEAN     NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login            TIMESTAMPTZ
);

-- ─── Компании ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS companies (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  inn               TEXT        NOT NULL DEFAULT '',
  ogrn              TEXT        NOT NULL DEFAULT '',
  website           TEXT        NOT NULL DEFAULT '',
  address_legal     TEXT        NOT NULL DEFAULT '',
  address_actual    TEXT        NOT NULL DEFAULT '',
  regions           JSONB       NOT NULL DEFAULT '[]',
  industry          TEXT        NOT NULL DEFAULT '',
  description       TEXT        NOT NULL DEFAULT '',
  segment           TEXT        NOT NULL DEFAULT 'cold_lead',
  cargo_types       JSONB       NOT NULL DEFAULT '[]',
  directions        JSONB       NOT NULL DEFAULT '[]',
  routes            JSONB       NOT NULL DEFAULT '[]',
  shipment_freq     TEXT        NOT NULL DEFAULT '',
  volume_monthly    TEXT        NOT NULL DEFAULT '',
  potential         TEXT        NOT NULL DEFAULT '',
  current_carrier   TEXT        NOT NULL DEFAULT '',
  switch_reason     TEXT        NOT NULL DEFAULT '',
  owner_id          UUID        REFERENCES users(id) ON DELETE SET NULL,
  source            TEXT        NOT NULL DEFAULT '',
  priority          TEXT        NOT NULL DEFAULT 'medium'
                      CHECK (priority IN ('high','medium','low')),
  tags              JSONB       NOT NULL DEFAULT '[]',
  next_action_at    DATE,
  next_action_type  TEXT        NOT NULL DEFAULT '',
  first_contact_at  DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_companies_owner    ON companies(owner_id);
CREATE INDEX IF NOT EXISTS idx_companies_segment  ON companies(segment);
CREATE INDEX IF NOT EXISTS idx_companies_priority ON companies(priority);
CREATE INDEX IF NOT EXISTS idx_companies_name     ON companies USING gin(to_tsvector('russian', name));

-- ─── Контакты ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contacts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  first_name        TEXT        NOT NULL,
  last_name         TEXT        NOT NULL DEFAULT '',
  position          TEXT        NOT NULL DEFAULT '',
  role              TEXT        NOT NULL DEFAULT 'unknown',
  phone_main        TEXT        NOT NULL DEFAULT '',
  phone_alt         TEXT        NOT NULL DEFAULT '',
  email             TEXT        NOT NULL DEFAULT '',
  telegram          TEXT        NOT NULL DEFAULT '',
  whatsapp          TEXT        NOT NULL DEFAULT '',
  preferred_channel TEXT        NOT NULL DEFAULT '',
  notes             TEXT        NOT NULL DEFAULT '',
  last_contact_at   DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);

-- ─── Сделки ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deals (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title                  TEXT        NOT NULL,
  description            TEXT        NOT NULL DEFAULT '',
  service                TEXT        NOT NULL DEFAULT 'transport',
  stage                  TEXT        NOT NULL DEFAULT 'new_lead',
  outcome                TEXT        NOT NULL DEFAULT 'in_progress'
                           CHECK (outcome IN ('in_progress','won','lost','postponed')),
  probability            INTEGER     NOT NULL DEFAULT 5 CHECK (probability BETWEEN 0 AND 100),
  planned_revenue        NUMERIC(15,2) NOT NULL DEFAULT 0,
  planned_margin         NUMERIC(15,2) NOT NULL DEFAULT 0,
  planned_margin_percent NUMERIC(6,2)  NOT NULL DEFAULT 0,
  currency               TEXT        NOT NULL DEFAULT 'RUB',
  planned_close_at       DATE,
  source                 TEXT        NOT NULL DEFAULT '',
  loss_reason            TEXT        NOT NULL DEFAULT '',
  owner_id               UUID        REFERENCES users(id) ON DELETE SET NULL,
  closed_at              TIMESTAMPTZ,
  -- История смен стадий: [{stage, from, at, by_user_id}]
  stage_history          JSONB       NOT NULL DEFAULT '[]',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);
CREATE INDEX IF NOT EXISTS idx_deals_owner   ON deals(owner_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage   ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_outcome ON deals(outcome);

-- ─── Активности ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activities (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID        REFERENCES companies(id) ON DELETE CASCADE,
  deal_id       UUID        REFERENCES deals(id) ON DELETE SET NULL,
  contact_id    UUID        REFERENCES contacts(id) ON DELETE SET NULL,
  type          TEXT        NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  description   TEXT        NOT NULL DEFAULT '',
  outcome       TEXT        NOT NULL DEFAULT '',
  next_step     TEXT        NOT NULL DEFAULT '',
  next_step_due DATE,
  is_done       BOOLEAN     NOT NULL DEFAULT false,
  owner_id      UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activities_company      ON activities(company_id);
CREATE INDEX IF NOT EXISTS idx_activities_deal         ON activities(deal_id);
CREATE INDEX IF NOT EXISTS idx_activities_owner        ON activities(owner_id);
CREATE INDEX IF NOT EXISTS idx_activities_next_step_due ON activities(next_step_due)
  WHERE next_step_due IS NOT NULL AND is_done = false;

-- ─── Функция updated_at ───────────────────────────────────────────────────────
-- Автоматически обновляет поле updated_at при любом UPDATE.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies','contacts','deals','activities'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_' || t || '_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_%I_updated_at
         BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        t, t
      );
    END IF;
  END LOOP;
END
$$;

-- ─── База перевозчиков ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS carriers (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  inn               TEXT        NOT NULL DEFAULT '',
  ogrn              TEXT        NOT NULL DEFAULT '',
  contact_person    TEXT        NOT NULL DEFAULT '',
  phone             TEXT        NOT NULL DEFAULT '',
  email             TEXT        NOT NULL DEFAULT '',
  telegram          TEXT        NOT NULL DEFAULT '',

  transport_types   JSONB       NOT NULL DEFAULT '[]',
  directions        JSONB       NOT NULL DEFAULT '[]',
  routes            JSONB       NOT NULL DEFAULT '[]',

  -- Рейтинг
  rating            INTEGER     NOT NULL DEFAULT 3 CHECK (rating BETWEEN 1 AND 5),
  on_time_percent   INTEGER                        CHECK (on_time_percent BETWEEN 0 AND 100),
  total_shipments   INTEGER     NOT NULL DEFAULT 0,

  -- Ставки
  rate_per_km       NUMERIC(10,2),
  rate_per_ton      NUMERIC(10,2),
  min_rate          NUMERIC(12,2),
  currency          TEXT        NOT NULL DEFAULT 'RUB',

  -- Документы / статус
  has_license       BOOLEAN     NOT NULL DEFAULT false,
  license_expires   DATE,
  is_vat            BOOLEAN     NOT NULL DEFAULT false,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  notes             TEXT        NOT NULL DEFAULT '',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_carriers_name   ON carriers(name);
CREATE INDEX IF NOT EXISTS idx_carriers_active ON carriers(is_active);

-- ─── Запросы на перевозку ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS requests (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID        REFERENCES companies(id) ON DELETE SET NULL,
  contact_id          UUID        REFERENCES contacts(id)  ON DELETE SET NULL,
  deal_id             UUID        REFERENCES deals(id)     ON DELETE SET NULL,

  -- Маршрут
  route_from          TEXT        NOT NULL DEFAULT '',
  route_to            TEXT        NOT NULL DEFAULT '',
  route_via           TEXT        NOT NULL DEFAULT '',
  distance_km         INTEGER,

  -- Груз
  cargo_type          TEXT        NOT NULL DEFAULT 'general',
  cargo_description   TEXT        NOT NULL DEFAULT '',
  weight_kg           NUMERIC(12,2),
  volume_m3           NUMERIC(10,3),
  places_count        INTEGER,
  cargo_value         NUMERIC(15,2),
  is_adr              BOOLEAN     NOT NULL DEFAULT false,
  is_oversized        BOOLEAN     NOT NULL DEFAULT false,
  temperature_regime  TEXT        NOT NULL DEFAULT '',

  -- Условия
  transport_type      TEXT        NOT NULL DEFAULT 'auto',
  loading_type        TEXT        NOT NULL DEFAULT '',
  incoterms           TEXT        NOT NULL DEFAULT '',
  loading_date        DATE,
  delivery_date       DATE,
  is_regular          BOOLEAN     NOT NULL DEFAULT false,
  frequency           TEXT        NOT NULL DEFAULT '',

  -- Финансы
  budget              NUMERIC(15,2),
  our_rate            NUMERIC(15,2),
  carrier_rate        NUMERIC(15,2),
  margin              NUMERIC(15,2),
  margin_percent      NUMERIC(6,2),
  currency            TEXT        NOT NULL DEFAULT 'RUB',

  -- Статус и ответственность
  status              TEXT        NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','calculating','quoted','won','lost','cancelled')),
  loss_reason         TEXT        NOT NULL DEFAULT '',
  carrier_id          UUID        REFERENCES carriers(id) ON DELETE SET NULL,
  owner_id            UUID        REFERENCES users(id)    ON DELETE SET NULL,
  notes               TEXT        NOT NULL DEFAULT '',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_requests_company  ON requests(company_id);
CREATE INDEX IF NOT EXISTS idx_requests_owner    ON requests(owner_id);
CREATE INDEX IF NOT EXISTS idx_requests_status   ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_loading  ON requests(loading_date);

-- Добавляем триггеры updated_at для новых таблиц
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['requests','carriers'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || t || '_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END IF;
  END LOOP;
END $$;

-- Уникальный индекс на ИНН (только для непустых значений)
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_inn_unique
  ON companies(inn) WHERE inn != '';

-- ─── Планы продаж ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS plans (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year            INTEGER     NOT NULL,
  month           INTEGER     NOT NULL CHECK (month BETWEEN 1 AND 12),

  -- Цели
  target_revenue    NUMERIC(15,2) NOT NULL DEFAULT 0,
  target_deals_won  INTEGER       NOT NULL DEFAULT 0,
  target_activities INTEGER       NOT NULL DEFAULT 0,
  target_calls      INTEGER       NOT NULL DEFAULT 0,
  target_meetings   INTEGER       NOT NULL DEFAULT 0,
  target_proposals  INTEGER       NOT NULL DEFAULT 0,
  target_new_companies INTEGER    NOT NULL DEFAULT 0,

  notes           TEXT        NOT NULL DEFAULT '',
  created_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_plans_user  ON plans(user_id);
CREATE INDEX IF NOT EXISTS idx_plans_period ON plans(year, month);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plans_updated_at') THEN
    CREATE TRIGGER trg_plans_updated_at BEFORE UPDATE ON plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
