-- Журнал випусків (оновлень коду). Ідемпотентна: можна виконати двічі.
--
-- Тут живе те, чого роль підтримки дати не може: ДОЗВІЛ власниці на кожне оновлення, ЗАПИС
-- що і коли поїхало, і вказівник на попередній коміт для ВІДКАТУ. Кнопки — у чаті салону,
-- викочує GitHub Actions (.github/workflows/release.yml), воркер лише відповідає «дозволено».
--
--   npx wrangler d1 execute gavlove-crm --remote --env="" --file migrations/0004_releases.sql

CREATE TABLE IF NOT EXISTS releases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL DEFAULT 1,
  n             INTEGER NOT NULL,      -- номер випуску = номер прогону в GitHub Actions
  sha           TEXT NOT NULL,         -- коміт, який їде
  prev_sha      TEXT,                  -- коміт попереднього випуску: сюди повертає «↩️ як було»
  build         TEXT,                  -- штамп, який має зʼявитися в /health після викочування
  note          TEXT NOT NULL,         -- одне речення для власниці, не заголовок коміта
  who           TEXT,                  -- хто попросив
  run_url       TEXT,                  -- прогін у GitHub, щоб було куди подивитись
  had_migration INTEGER DEFAULT 0,     -- чи змінювалась сама база: відкат коду її не поверне
  state         TEXT NOT NULL,         -- pending | ok | no | expired | live | rollback | rolled_back | failed
  at            TEXT NOT NULL,
  decided_by    TEXT,                  -- хто натиснув кнопку в чаті салону
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_releases_n ON releases(n);
