-- Журнал дій підтримки. Ідемпотентна: можна виконати двічі, нічого не станеться.
--
-- Вимикач доступу (support_until / support_prices) окремої таблиці не потребує — він живе
-- ключами в settings, а settingsSave має закритий список ключів і цих двох у ньому немає.
-- Тут тільки журнал, і він обов'язковий: supportGate пише рядок ПЕРЕД кожною дією підтримки
-- і помилку не ковтає. Немає таблиці — немає й дії. Це навмисно: доступ підтримки без запису
-- в журналі — це рівно те, від чого ця роль і захищає.
--
--   npx wrangler d1 execute gavlove-crm --remote --env="" --file migrations/0003_support_log.sql

CREATE TABLE IF NOT EXISTS support_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  at         TEXT NOT NULL,          -- ISO, UTC
  who        TEXT NOT NULL,          -- ім'я з акаунта, а не «підтримка»: у журналі має стояти людина
  act        TEXT NOT NULL           -- людськими словами: «змінив тексти або розділи сайту»
);
CREATE INDEX IF NOT EXISTS idx_support_log_at ON support_log(at);
