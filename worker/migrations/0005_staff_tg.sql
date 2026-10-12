-- Telegram співробітників: хто з персоналу підключив свій кабінет у боті салону.
-- Ідемпотентна: можна виконати двічі, нічого не станеться.
--
-- Рядок з'являється, коли співробітник у CRM (або в кабінеті майстра) натискає «📲 Telegram»:
-- воркер кладе сюди ХЕШ одноразового коду на 15 хвилин і віддає посилання t.me/<бот>?start=st_<код>.
-- Відкрив посилання у своєму особистому чаті з ботом — код згорає, у рядку лишається chat_id.
--
-- Роль і «активний» тут НЕ зберігаються: бот читає їх з users на кожному натисканні. Тому
-- зняти галочку «активний» або видалити акаунт — це те саме, що забрати кабінет у боті, миттєво.
-- Власниці рядок не потрібен: її особистий чат (TELEGRAM_CHAT_ID) бот і так знає.
--
--   npx wrangler d1 execute gavlove-crm --remote --env="" --file migrations/0005_staff_tg.sql

CREATE TABLE IF NOT EXISTS staff_tg (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   INTEGER NOT NULL DEFAULT 1,
  user_id      INTEGER NOT NULL,      -- users.id
  chat_id      INTEGER,               -- NULL, доки посилання не відкрили
  code_hash    TEXT,                  -- sha256 одноразового коду; NULL після використання
  code_expires TEXT,                  -- ISO, UTC
  notify       INTEGER DEFAULT 1,     -- сповіщення про записи в цей чат
  created_at   TEXT,
  linked_at    TEXT
);
-- Один акаунт — один чат, і один чат — один акаунт. NULL в унікальному індексі SQLite не конфліктує.
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_tg_user ON staff_tg (company_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_tg_chat ON staff_tg (company_id, chat_id);
