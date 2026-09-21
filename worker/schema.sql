-- Схема бази CRM. Знята з живої gavlove-crm 21.09.2026 і є ЄДИНИМ джерелом правди.
--
-- Навіщо цей файл. Це перший крок розгортання нового салону:
--
--   npx wrangler d1 create <ім'я>
--   npx wrangler d1 execute <ім'я> --remote --file worker/schema.sql
--
-- Відновлення з бекапу цього файлу не потребує: ночний дамп від 21.09.2026 самодостатній —
-- він починається з власних CREATE TABLE. Старіші дампи (до 21.09) містять лише дані,
-- тож для них спершу накотіть цю схему.
--
-- ПРО ПРАЙС. Колонка services.col_roles описує, що означає кожна колонка таблиці цін
-- (label / weight / price / price:<рівень> / duration / info). Порожня — читається як раніше:
-- ціна в останній комірці, вага в другій. masters.tier зберігає ключ цінового рівня майстра,
-- bookings.duration — фактичні хвилини візиту. Деталі — worker/migrations/0002_column_roles.sql.
--
-- ПРО company_id. Колонка лишилася в усіх 15 таблицях із даними салону і завжди дорівнює 1:
-- один воркер обслуговує один салон. Раніше значення підставляла обгортка запитів, тепер її
-- немає — його дає `NOT NULL DEFAULT 1` у самих визначеннях таблиць. ЦЕЙ DEFAULT ПРИБИРАТИ НЕ МОЖНА:
-- жоден INSERT у воркері company_id не називає, і перший же запис клієнта впаде на NOT NULL.

-- ============================== таблиці ==============================

CREATE TABLE IF NOT EXISTS companies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,          -- короткое имя салона; ни на что не влияет
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

CREATE TABLE IF NOT EXISTS "users" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  username TEXT, name TEXT, pass_hash TEXT, pass_salt TEXT,
  role TEXT DEFAULT 'admin', master_id INTEGER,
  active INTEGER DEFAULT 1, must_change INTEGER DEFAULT 0, created_at TEXT,
  UNIQUE (company_id, username)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  role TEXT,
  master_id INTEGER,
  name TEXT,
  created_at TEXT,
  expires_at TEXT
, company_id INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS "masters" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  name TEXT, active INTEGER DEFAULT 1,
  work_start TEXT DEFAULT '10:00', work_end TEXT DEFAULT '20:00',
  days_off TEXT DEFAULT '', vacations TEXT DEFAULT '', sort INTEGER DEFAULT 0,
  salary_type TEXT, salary_value REAL, break_start TEXT, break_end TEXT,
  salary_base REAL, access_code TEXT, tier TEXT,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, species TEXT, duration INTEGER DEFAULT 0, is_request INTEGER DEFAULT 0, bookable INTEGER DEFAULT 1, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, price_type TEXT DEFAULT 'flat', price TEXT, unit TEXT DEFAULT '', note TEXT, columns TEXT, rows TEXT, company_id INTEGER NOT NULL DEFAULT 1, col_roles TEXT);

CREATE TABLE IF NOT EXISTS "settings" (
  company_id INTEGER NOT NULL DEFAULT 1,
  key        TEXT NOT NULL,
  value      TEXT,
  PRIMARY KEY (company_id, key)
);

CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, name TEXT, phone TEXT, email TEXT, messenger TEXT, source TEXT DEFAULT 'site', note TEXT, consent INTEGER DEFAULT 0, status TEXT DEFAULT 'active', tg_chat_id INTEGER, company_id INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS client_sessions (
  token TEXT PRIMARY KEY,
  client_id INTEGER,
  created_at TEXT,
  expires_at TEXT
, company_id INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS client_otp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER,
  code TEXT,
  expires_at TEXT,
  attempts INTEGER DEFAULT 0
, ip TEXT, company_id INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS pets (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, created_at TEXT NOT NULL, name TEXT, species TEXT DEFAULT 'dog', breed TEXT, birthdate TEXT, weight TEXT, sex TEXT, color TEXT, allergies TEXT, behavior TEXT, reactions TEXT, prefs TEXT, vet_notes TEXT, warnings TEXT, special INTEGER DEFAULT 0, client_notes TEXT, company_id INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS pet_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id INTEGER,
  client_id INTEGER,
  booking_id INTEGER,
  kind TEXT,
  mime TEXT,
  data BLOB,
  token TEXT,
  created_at TEXT,
  note TEXT
, published INTEGER DEFAULT 0, r2_key TEXT, size INTEGER, thumb_key TEXT, thumb_size INTEGER, company_id INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  pet TEXT,
  service TEXT,
  breed TEXT,
  name TEXT,
  phone TEXT,
  date TEXT,
  time TEXT,
  note TEXT,
  is_request INTEGER DEFAULT 0,
  event_link TEXT,
  status TEXT DEFAULT 'new'
, source TEXT DEFAULT 'site', event_id TEXT, price REAL, staff TEXT DEFAULT '', weight TEXT DEFAULT '', client_id INTEGER, pet_id INTEGER, pet_name TEXT DEFAULT '', pay_method TEXT, tg_code TEXT, remind_day_sent INTEGER DEFAULT 0, remind_hour_sent INTEGER DEFAULT 0, company_id INTEGER NOT NULL DEFAULT 1, duration INTEGER);

CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, category TEXT, title TEXT, amount REAL, note TEXT, company_id INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, name TEXT, phone TEXT, rating INTEGER, text TEXT, master TEXT, client_id INTEGER, published INTEGER DEFAULT 0, reply TEXT, company_id INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS site_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cms_key TEXT,
  mime TEXT,
  r2_key TEXT,
  size INTEGER,
  thumb_key TEXT,
  thumb_size INTEGER,
  w INTEGER,
  h INTEGER,
  tw INTEGER,
  th INTEGER,
  token TEXT,
  created_at TEXT,
  unref_at TEXT
, company_id INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS "tg_sessions" (
  company_id INTEGER NOT NULL DEFAULT 1,
  chat_id    INTEGER NOT NULL,
  state      TEXT,
  updated_at TEXT,
  PRIMARY KEY (company_id, chat_id)
);

-- Журнал дій підтримки. Порожній у нового салону і заповнюється, лише коли власниця
-- відкриває доступ розробнику.
CREATE TABLE IF NOT EXISTS support_log (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL DEFAULT 1, at TEXT NOT NULL, who TEXT NOT NULL, act TEXT NOT NULL);

-- Журнал випусків коду: дозвіл власниці, запис і вказівник для відкату. Див. release.yml.
CREATE TABLE IF NOT EXISTS releases (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL DEFAULT 1, n INTEGER NOT NULL, sha TEXT NOT NULL, prev_sha TEXT, build TEXT, note TEXT NOT NULL, who TEXT, run_url TEXT, had_migration INTEGER DEFAULT 0, state TEXT NOT NULL, at TEXT NOT NULL, decided_by TEXT, decided_at TEXT);

-- ============================== індекси ==============================

CREATE INDEX IF NOT EXISTS idx_bookings_company_client  ON bookings   (company_id, client_id);
CREATE INDEX IF NOT EXISTS idx_bookings_company_created ON bookings   (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_company_date    ON bookings   (company_id, date, time);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_otp_client ON client_otp (client_id);
CREATE INDEX IF NOT EXISTS idx_clients_company_phone    ON clients    (company_id, phone);
CREATE INDEX IF NOT EXISTS idx_clients_company_tg       ON clients    (company_id, tg_chat_id);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients (phone);
CREATE INDEX IF NOT EXISTS idx_expenses_company_date    ON expenses   (company_id, date);
CREATE INDEX IF NOT EXISTS idx_masters_company          ON masters    (company_id, sort);
CREATE INDEX IF NOT EXISTS idx_pet_photos_company_pet   ON pet_photos (company_id, pet_id);
CREATE INDEX IF NOT EXISTS idx_pet_photos_pet ON pet_photos (pet_id);
CREATE INDEX IF NOT EXISTS idx_pets_client ON pets (client_id);
CREATE INDEX IF NOT EXISTS idx_pets_company_client      ON pets       (company_id, client_id);
CREATE INDEX IF NOT EXISTS idx_reviews_company          ON reviews    (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_services_company         ON services   (company_id, sort);
CREATE INDEX IF NOT EXISTS idx_sessions_company         ON sessions   (company_id);
CREATE INDEX IF NOT EXISTS idx_site_media_company       ON site_media (company_id, cms_key);
CREATE INDEX IF NOT EXISTS idx_site_media_unref ON site_media(unref_at);
CREATE INDEX IF NOT EXISTS idx_support_log_at ON support_log(at);
CREATE INDEX IF NOT EXISTS idx_releases_n ON releases(n);
CREATE INDEX IF NOT EXISTS idx_users_company            ON users      (company_id);

-- ============================== перший рядок ==============================
-- Один салон на екземпляр, і він завжди id=1. Назву поміняти під конкретний салон;
-- адреси сайту воркер бере з ALLOW_ORIGIN і SITE_URL у wrangler.toml, а не звідси.
INSERT OR IGNORE INTO companies (id, slug, name, active, created_at, site_url, site_origin)
VALUES (1, 'salon', 'Салон', 1, datetime('now'), '', '');
