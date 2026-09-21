-- ІСТОРІЯ. Цю міграцію накотили на живу базу 21.09.2026, коли планували тримати кілька
-- салонів в одній базі. Від того задуму відмовилися того ж дня: кожен салон продається як
-- окреме рішення зі своїм воркером і своєю базою. Колонки company_id лишилися (див. schema.sql).
-- ДЛЯ НОВОГО САЛОНУ ЦЕЙ ФАЙЛ НЕ ПОТРІБЕН І НЕ СПРАЦЮЄ: він не ідемпотентний і робить
-- ALTER TABLE по таблицях, яких у порожній базі ще немає. Розгортання — з worker/schema.sql.

-- Multitenancy, step 1: every row learns which salon it belongs to.
--
-- Deliberately backward compatible: company_id defaults to 1 everywhere, and GAV&LOVE IS company 1,
-- so the worker deployed today keeps working unchanged after this runs. Code that reads the column
-- comes later; this file only makes the shape possible.
--
-- Rehearse on gavlove-crm-dev, then take a backup, then run on gavlove-crm.

-- ---------------------------------------------------------------- companies
CREATE TABLE IF NOT EXISTS companies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,          -- used by public requests: /catalog?c=gavlove
  name           TEXT NOT NULL,
  active         INTEGER DEFAULT 1,
  created_at     TEXT,
  site_url       TEXT DEFAULT '',               -- was the SITE_URL var
  site_origin    TEXT DEFAULT '',               -- was ALLOW_ORIGIN
  -- what used to be the BUSINESS constant (30 uses in the worker)
  tz             TEXT DEFAULT 'Europe/Kyiv',
  open_min       INTEGER DEFAULT 600,           -- 10:00
  close_min      INTEGER DEFAULT 1200,          -- 20:00
  slot_step_min  INTEGER DEFAULT 30,
  buffer_min     INTEGER DEFAULT 30,
  min_lead_min   INTEGER DEFAULT 120,
  max_ahead_days INTEGER DEFAULT 30,
  digest_hour    INTEGER DEFAULT 16,            -- UTC hour of the daily cron work
  phone_prefix   TEXT DEFAULT '+38',
  lang           TEXT DEFAULT 'uk',
  -- per-company customization, filled in later steps (JSON, validated server side)
  theme          TEXT DEFAULT '',
  features       TEXT DEFAULT '',
  labels         TEXT DEFAULT '',
  rules          TEXT DEFAULT '',
  plan           TEXT DEFAULT 'standard',
  limits         TEXT DEFAULT '',
  -- per-company credentials arrive in step 3; the columns exist so nothing has to be rebuilt again
  tg_bot         TEXT DEFAULT '',
  tg_bot_token   TEXT DEFAULT '',
  tg_chat_id     TEXT DEFAULT '',
  calendar_id    TEXT DEFAULT '',
  sa_email       TEXT DEFAULT '',
  sa_private_key TEXT DEFAULT ''
);

INSERT INTO companies (id, slug, name, active, created_at, site_url, site_origin)
SELECT 1, 'gavlove', 'GAV&LOVE', 1, '2026-09-15T16:28:15.534Z',
       'https://besenok911-cloud.github.io/gav-and-love', 'https://besenok911-cloud.github.io'
WHERE NOT EXISTS (SELECT 1 FROM companies WHERE id = 1);

-- ------------------------------------------------- the plain ADD COLUMN cases
ALTER TABLE bookings        ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE clients         ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pets            ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pet_photos      ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE expenses        ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reviews         ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE services        ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions        ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE client_sessions ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE client_otp      ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE site_media      ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;

-- --------------------------------------------- the four that must be rebuilt
-- SQLite cannot change a PRIMARY KEY or a UNIQUE column in place, and all four carry a uniqueness
-- rule that has to become per-company: two salons both want a master called «Дар'я», both keep a
-- setting called 'loyalty_every', and both owners want to log in as «vlasnyk».

CREATE TABLE settings_new (
  company_id INTEGER NOT NULL DEFAULT 1,
  key        TEXT NOT NULL,
  value      TEXT,
  PRIMARY KEY (company_id, key)
);
INSERT INTO settings_new (company_id, key, value) SELECT 1, key, value FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

CREATE TABLE tg_sessions_new (
  company_id INTEGER NOT NULL DEFAULT 1,
  chat_id    INTEGER NOT NULL,
  state      TEXT,
  updated_at TEXT,
  PRIMARY KEY (company_id, chat_id)
);
INSERT INTO tg_sessions_new (company_id, chat_id, state, updated_at)
  SELECT 1, chat_id, state, updated_at FROM tg_sessions;
DROP TABLE tg_sessions;
ALTER TABLE tg_sessions_new RENAME TO tg_sessions;

CREATE TABLE masters_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  name TEXT, active INTEGER DEFAULT 1,
  work_start TEXT DEFAULT '10:00', work_end TEXT DEFAULT '20:00',
  days_off TEXT DEFAULT '', vacations TEXT DEFAULT '', sort INTEGER DEFAULT 0,
  salary_type TEXT, salary_value REAL, break_start TEXT, break_end TEXT,
  salary_base REAL, access_code TEXT,
  UNIQUE (company_id, name)
);
INSERT INTO masters_new (id, company_id, name, active, work_start, work_end, days_off, vacations,
                         sort, salary_type, salary_value, break_start, break_end, salary_base, access_code)
  SELECT id, 1, name, active, work_start, work_end, days_off, vacations,
         sort, salary_type, salary_value, break_start, break_end, salary_base, access_code FROM masters;
DROP TABLE masters;
ALTER TABLE masters_new RENAME TO masters;

CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  username TEXT, name TEXT, pass_hash TEXT, pass_salt TEXT,
  role TEXT DEFAULT 'admin', master_id INTEGER,
  active INTEGER DEFAULT 1, must_change INTEGER DEFAULT 0, created_at TEXT,
  UNIQUE (company_id, username)
);
INSERT INTO users_new (id, company_id, username, name, pass_hash, pass_salt, role, master_id,
                       active, must_change, created_at)
  SELECT id, 1, username, name, pass_hash, pass_salt, role, master_id,
         active, must_change, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- ------------------------------------------------------------------- cleanup
-- `catalog` was replaced by the unified `services` table long ago; nothing reads it.
DROP TABLE IF EXISTS catalog;

-- ------------------------------------------------------------------- indexes
CREATE INDEX IF NOT EXISTS idx_bookings_company_date    ON bookings   (company_id, date, time);
CREATE INDEX IF NOT EXISTS idx_bookings_company_created ON bookings   (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_company_client  ON bookings   (company_id, client_id);
CREATE INDEX IF NOT EXISTS idx_clients_company_phone    ON clients    (company_id, phone);
CREATE INDEX IF NOT EXISTS idx_clients_company_tg       ON clients    (company_id, tg_chat_id);
CREATE INDEX IF NOT EXISTS idx_pets_company_client      ON pets       (company_id, client_id);
CREATE INDEX IF NOT EXISTS idx_pet_photos_company_pet   ON pet_photos (company_id, pet_id);
CREATE INDEX IF NOT EXISTS idx_masters_company          ON masters    (company_id, sort);
CREATE INDEX IF NOT EXISTS idx_services_company         ON services   (company_id, sort);
CREATE INDEX IF NOT EXISTS idx_expenses_company_date    ON expenses   (company_id, date);
CREATE INDEX IF NOT EXISTS idx_reviews_company          ON reviews    (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_company            ON users      (company_id);
CREATE INDEX IF NOT EXISTS idx_sessions_company         ON sessions   (company_id);
CREATE INDEX IF NOT EXISTS idx_site_media_company       ON site_media (company_id, cms_key);
