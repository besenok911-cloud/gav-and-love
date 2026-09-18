# Мультитенантная CRM: техническое задание на перевод Worker + D1

Дата: 2026-09-18. Автор ТЗ: Claude (по коду `worker/src/index.js` и живой схеме D1 `gavlove-crm`).
Исполнитель: другая модель / разработчик. Документ самодостаточен, читать код репозитория всё равно обязательно.

## 0. Цель и принципы

Сейчас Worker `gavlove-booking` и база D1 `gavlove-crm` обслуживают один салон (GAV&LOVE).
Нужно превратить их в общую платформу для N салонов (компаний) так, чтобы:

1. **Один код, одна база, один деплой.** Новая компания = строка в таблице `companies` + сид данных, без нового Worker и без нового деплоя.
2. **Полная изоляция данных.** Ни один запрос не может прочитать или изменить строку другой компании. Это главный риск всей работы.
3. **GAV&LOVE продолжает работать без простоя** и без изменений для пользователей: тот же URL Worker, те же эндпоинты, те же логины, тот же Telegram-бот.
4. **Кастомизация данными, а не кодом.** Бренд, услуги, мастера, тексты, часы работы, интеграции хранятся в базе для каждой компании. В коде не должно остаться ни одной строки, привязанной к GAV&LOVE.
5. **Готовность к мобильному клиенту.** iOS-приложение (одно на всех) логинится по тем же эндпоинтам и получает бренд компании с сервера.

Что НЕ делаем в этой итерации: не меняем публичные пути эндпоинтов, не переносим фото в R2, не переписываем фронтенды (`admin.html`, `master.html`, `cabinet.html`, `scripts/main.js`) кроме минимальных правок из раздела 8, не делаем биллинг.

## 1. Текущее состояние (as-is)

### 1.1. Архитектура

- Cloudflare Worker `worker/src/index.js` (~2100 строк, один файл). Роутинг: цепочка `if (url.pathname === ...)` в `fetch()`. Cron в `scheduled()`.
- База: одна D1 `gavlove-crm` (binding `DB`), `database_id = 50b72473-38b0-4908-bcf6-3938dffbf3f2`.
- Файл `worker/schema.sql` устарел (только `bookings`). Актуальная схема есть только в живой базе, см. 1.3.
- Интеграции: Google Calendar через service account (JWT RS256), Telegram Bot API (уведомления салону + бот для клиентов с webhook), сайт на GitHub Pages.
- Фронтенды (статический HTML, ходят в Worker с `Authorization: Bearer <token>`):
  - `admin.html` — CRM для owner/admin (вкладки: записи, клиенты, мастера, услуги/цены, расходы, отзывы, настройки, пользователи, сайт-CMS).
  - `master.html` — кабинет мастера (сессия role=master или legacy `access_code`).
  - `cabinet.html` — кабинет клиента (вход по телефону + код из Telegram).
  - `scripts/main.js` — публичный сайт: форма записи, слоты, каталог цен, отзывы, галерея «до/после», CMS-тексты. Базовый URL: `CONFIG.bookingEndpoint = "https://gavlove-booking.besenok911.workers.dev"`.
  - `review.html` — форма отзыва.

### 1.2. Конфигурация и секреты Worker (wrangler.toml + `wrangler secret`)

| Переменная | Назначение сейчас | Что с ней делать |
|---|---|---|
| `DB` | D1 binding | остаётся, общая база |
| `ALLOW_ORIGIN` | единственный разрешённый Origin для CORS | заменить на список из `companies.site_origin` + origins приложения (раздел 6) |
| `SITE_URL` | ссылка на сайт салона в сообщениях бота | переезжает в `companies.site_url` |
| `ADMIN_TOKEN` | аварийный пароль владельца салона (логин без учётки) | становится паролем **суперадмина платформы**, не даёт доступ к данным компаний напрямую (раздел 7) |
| `TELEGRAM_BOT_TOKEN` | токен бота салона | переезжает в `companies` (зашифрован) |
| `TELEGRAM_CHAT_ID` | чат салона для уведомлений | переезжает в `companies` |
| `CALENDAR_ID` | Google-календарь салона | переезжает в `companies` |
| `SA_EMAIL`, `SA_PRIVATE_KEY` | service account Google | **остаются общими** для платформы. Каждая компания расшаривает свой календарь на этот `SA_EMAIL` (как сейчас описано в `SETUP.md`) |

Новый секрет: `MASTER_KEY` (32 байта, base64) — ключ AES-GCM для шифрования токенов в базе.

### 1.3. Живая схема D1 (снята 2026-09-18 через `wrangler d1 execute --remote`)

```sql
CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, pet TEXT, service TEXT, breed TEXT, name TEXT, phone TEXT, date TEXT, time TEXT, note TEXT, is_request INTEGER DEFAULT 0, event_link TEXT, status TEXT DEFAULT 'new', source TEXT DEFAULT 'site', event_id TEXT, price REAL, staff TEXT DEFAULT '', weight TEXT DEFAULT '', client_id INTEGER, pet_id INTEGER, pet_name TEXT DEFAULT '', pay_method TEXT, tg_code TEXT, remind_day_sent INTEGER DEFAULT 0, remind_hour_sent INTEGER DEFAULT 0);
CREATE INDEX idx_bookings_created ON bookings (created_at DESC);
CREATE TABLE clients (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, name TEXT, phone TEXT, email TEXT, messenger TEXT, source TEXT DEFAULT 'site', note TEXT, consent INTEGER DEFAULT 0, status TEXT DEFAULT 'active', tg_chat_id INTEGER);
CREATE INDEX idx_clients_phone ON clients (phone);
CREATE TABLE pets (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, created_at TEXT NOT NULL, name TEXT, species TEXT DEFAULT 'dog', breed TEXT, birthdate TEXT, weight TEXT, sex TEXT, color TEXT, allergies TEXT, behavior TEXT, reactions TEXT, prefs TEXT, vet_notes TEXT, warnings TEXT, special INTEGER DEFAULT 0, client_notes TEXT);
CREATE INDEX idx_pets_client ON pets (client_id);
CREATE TABLE pet_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, pet_id INTEGER, client_id INTEGER, booking_id INTEGER, kind TEXT, mime TEXT, data BLOB, token TEXT, created_at TEXT, note TEXT, published INTEGER DEFAULT 0);
CREATE INDEX idx_pet_photos_pet ON pet_photos (pet_id);
CREATE TABLE masters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, active INTEGER DEFAULT 1, work_start TEXT DEFAULT '10:00', work_end TEXT DEFAULT '20:00', days_off TEXT DEFAULT '', vacations TEXT DEFAULT '', sort INTEGER DEFAULT 0, salary_type TEXT, salary_value REAL, break_start TEXT, break_end TEXT, salary_base REAL, access_code TEXT);
CREATE TABLE services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, species TEXT, duration INTEGER DEFAULT 0, is_request INTEGER DEFAULT 0, bookable INTEGER DEFAULT 1, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, price_type TEXT DEFAULT 'flat', price TEXT, unit TEXT DEFAULT '', note TEXT, columns TEXT, rows TEXT);
CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, category TEXT, title TEXT, amount REAL, note TEXT);
CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, name TEXT, phone TEXT, rating INTEGER, text TEXT, master TEXT, client_id INTEGER, published INTEGER DEFAULT 0, reply TEXT);
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, name TEXT, pass_hash TEXT, pass_salt TEXT, role TEXT DEFAULT 'admin', master_id INTEGER, active INTEGER DEFAULT 1, must_change INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER, role TEXT, master_id INTEGER, name TEXT, created_at TEXT, expires_at TEXT);
CREATE TABLE client_sessions (token TEXT PRIMARY KEY, client_id INTEGER, created_at TEXT, expires_at TEXT);
CREATE TABLE client_otp (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, code TEXT, expires_at TEXT, attempts INTEGER DEFAULT 0, ip TEXT);
CREATE INDEX idx_client_otp_client ON client_otp (client_id);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE tg_sessions (chat_id INTEGER PRIMARY KEY, state TEXT, updated_at TEXT);
CREATE TABLE catalog (id INTEGER PRIMARY KEY, data TEXT, updated TEXT);   -- legacy, в коде не используется
```

Ключи `settings` (key/value, строки): `reminders_enabled`, `repeat_weeks`, `note_gift`, `note_big`, `loyalty_enabled`, `loyalty_every`, `loyalty_reward`, `client_reminders_enabled`, `remind_hours_before`, `tg_bot` (username бота), `site_cms` (JSON `{hidden:[], texts:{}}`).

Роли в `users.role` / `sessions.role`: `owner`, `admin`, `master`. Мастер привязан через `users.master_id -> masters.id`. В `bookings.staff` хранится **имя** мастера (строка), не id. В `reviews.master` тоже имя.

### 1.4. Константы и хардкод в коде, которые должны стать данными компании

| Где | Что | Куда переезжает |
|---|---|---|
| `BUSINESS` (tz, openMin, closeMin, slotStepMin, bufferMin, minLeadMin, maxAheadDays, workingDays) | часы и параметры слотов; `BUSINESS.tz` используется в 36 местах | колонки `companies` (раздел 2.1) |
| `STAFF`, `DEFAULT_MASTERS()` | fallback-состав мастеров, если таблица `masters` пуста | удалить fallback; мастера только из БД. `slotFree`/`pickFreeStaff` используют `STAFF.length` — переписать на список мастеров компании |
| `SERVICE_DURATIONS`, `DEFAULT_DURATION`, `REQUEST_SERVICES` | fallback длительностей | остаются как дефолт **шаблона** при сидировании, из runtime-логики убрать |
| `DEFAULT_PRICES`, `DEFAULT_SERVICES` | сид таблицы `services` (`seedServices`) | сид шаблона «грумінг» при создании компании; `seedServices` при пустой таблице конкретной компании |
| Строки `GAV&amp;LOVE` в Telegram-сообщениях (строки ~1663, 1678, 1726, 1852, 1856) | бренд | `companies.name` |
| `kyivNow()` | «сейчас» в Europe/Kyiv | `nowInTz(company.tz)` |
| `contactLinks()` добавляет `+38` к телефонам | украинский код страны | `companies.phone_prefix` (по умолчанию `+38`) |
| `tgSetup`: `setMyCommands` с украинскими описаниями | язык бота | пока оставить украинский; поле `companies.lang` завести на будущее |
| `siteUrl(env)` | ссылка на сайт | `companies.site_url` |
| CORS `ALLOW_ORIGIN` | один origin | раздел 6 |

### 1.5. Полный список эндпоинтов и как для каждого определяется компания (to-be)

Источники контекста компании (см. раздел 4): **S** = сессия сотрудника (`sessions.company_id`), **C** = сессия клиента (`client_sessions -> clients.company_id`), **P** = публичный запрос с параметром `?c=<slug>` (или заголовок `X-Company: <slug>`), **T** = токен/путь.

| Метод | Путь | Контекст | Примечание |
|---|---|---|---|
| GET | `/slots` | P | |
| POST | `/book` | P | |
| GET | `/masters` | P | |
| GET | `/catalog` | P | кэш 60с, ключ кэша должен включать slug |
| GET | `/site` | P | |
| GET | `/reviews` | P | |
| POST | `/review` | P | |
| GET | `/before-after` | P | |
| GET | `/photo/<id>/<token>` | T | токен 16 hex уже неугадываем; дополнительно ничего не нужно, но `company_id` в `pet_photos` должен быть |
| POST | `/auth/login` | по `users` (раздел 4.1) | ответ дополняется `company` |
| GET | `/auth/me` | S | ответ дополняется `company` |
| POST | `/auth/logout`, `/auth/change-password` | S | |
| GET/POST | `/admin/*` (list, create, update, delete, clients, pets, client-save, client-delete, pet-save, pet-delete, reviews, review-save, review-delete, users, user-save, user-delete, photos, photo-upload, photo-delete, photo-publish, services, service-save, service-delete, expenses, expense-save, expense-delete, masters, master-save, master-delete, settings, settings-save, site-save, send-digest, send-client-reminders, notify-client, notify-broadcast, tg-setup, tg-test) | S | каждый SQL получает `AND company_id=?` |
| GET | `/master/data` | S или `?code=` | legacy `access_code`: искать в `masters` по коду **вместе с** `company_id`; коды должны быть уникальны глобально (см. 2.2) или требовать slug |
| POST | `/master/status` | S или `code` | |
| POST | `/client/otp`, `/client/verify` | P | телефон ищется только среди клиентов этой компании |
| GET/POST | `/client/me`, `/client/booking-cancel`, `/client/booking-move`, `/client/pet-save`, `/client/profile`, `/client/logout` | C | |
| POST | `/tg/webhook` | T | заменить на `/tg/webhook/<company_id>`; старый путь оставить как алиас для `company_id=1` до перерегистрации webhook |
| — | `scheduled()` | цикл по компаниям | раздел 5 |

Новые эндпоинты платформы (раздел 7): `/platform/login`, `/platform/companies`, `/platform/company-save`, `/platform/company-secrets`, `/platform/company-owner`.

## 2. Целевая модель данных

### 2.1. Новая таблица `companies`

```sql
CREATE TABLE companies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,        -- 'gavlove'; [a-z0-9-]{2,32}; используется в публичных URL
  name          TEXT NOT NULL,               -- 'GAV&LOVE' (бренд в сообщениях, шапке приложения)
  active        INTEGER DEFAULT 1,           -- 0 = заблокирована: публичные и сессионные запросы -> 403, cron пропускает
  created_at    TEXT NOT NULL,
  -- бренд для сайта/приложения
  logo_url      TEXT DEFAULT '',
  color_primary TEXT DEFAULT '#4a25c9',
  color_accent  TEXT DEFAULT '#c9a24a',
  site_url      TEXT DEFAULT '',             -- было env.SITE_URL
  site_origin   TEXT DEFAULT '',             -- было env.ALLOW_ORIGIN; через запятую можно несколько
  phone_prefix  TEXT DEFAULT '+38',
  lang          TEXT DEFAULT 'uk',
  -- расписание (было BUSINESS)
  tz            TEXT DEFAULT 'Europe/Kyiv',
  slot_step_min INTEGER DEFAULT 30,
  buffer_min    INTEGER DEFAULT 30,
  min_lead_min  INTEGER DEFAULT 120,
  max_ahead_days INTEGER DEFAULT 30,
  digest_hour   INTEGER DEFAULT 19,          -- локальный час ежедневного дайджеста (раньше cron 16:00 UTC)
  -- интеграции (были секретами Worker)
  calendar_id   TEXT DEFAULT '',
  tg_bot_token_enc TEXT DEFAULT '',          -- AES-GCM(base64: iv||ciphertext), ключ env.MASTER_KEY
  tg_chat_id    TEXT DEFAULT '',             -- чат салона для уведомлений
  tg_bot        TEXT DEFAULT '',             -- username бота (было settings.tg_bot)
  tg_webhook_secret TEXT DEFAULT ''          -- случайный, генерируется при tg-setup; раньше = sha256(токен)
);
```

`open_min`/`close_min`/`working_days` из `BUSINESS` **не переносим**: код уже считает окно дня по расписанию мастеров (`getSlots` берёт min/max из `masters.work_start/work_end`), а `workingDays` нигде не проверяется. Если в коде остались обращения к этим полям, заменить на расчёт из мастеров.

### 2.2. Колонка `company_id` во всех таблицах

Во **все** существующие таблицы (кроме `catalog`, которую удалить) добавляется `company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id)`. Значение по умолчанию `1` = GAV&LOVE, поэтому существующие строки автоматически становятся её данными.

Таблицы: `bookings`, `clients`, `pets`, `pet_photos`, `masters`, `services`, `expenses`, `reviews`, `users`, `sessions`, `client_sessions`, `client_otp`, `settings`, `tg_sessions`.

Индексы (все запросы фильтруют по компании, индекс должен начинаться с неё):

```sql
CREATE INDEX idx_bookings_company_date ON bookings (company_id, date, time);
CREATE INDEX idx_bookings_company_created ON bookings (company_id, created_at DESC);
CREATE INDEX idx_bookings_company_client ON bookings (company_id, client_id);
CREATE INDEX idx_clients_company_phone ON clients (company_id, phone);
CREATE INDEX idx_clients_company_tg ON clients (company_id, tg_chat_id);
CREATE INDEX idx_pets_company_client ON pets (company_id, client_id);
CREATE INDEX idx_pet_photos_company_pet ON pet_photos (company_id, pet_id);
CREATE INDEX idx_masters_company ON masters (company_id, sort);
CREATE INDEX idx_services_company ON services (company_id, sort);
CREATE INDEX idx_expenses_company_date ON expenses (company_id, date);
CREATE INDEX idx_reviews_company ON reviews (company_id, created_at DESC);
CREATE INDEX idx_users_company ON users (company_id);
CREATE INDEX idx_client_otp_company_client ON client_otp (company_id, client_id);
```

Изменение уникальности и первичных ключей (SQLite не умеет `ALTER ... DROP CONSTRAINT`, эти таблицы пересоздаются через `_new` + копирование + `DROP` + `RENAME`, см. раздел 9, шаг 2):

| Таблица | Было | Стало |
|---|---|---|
| `masters` | `name TEXT UNIQUE` | `UNIQUE(company_id, name)` |
| `settings` | `key TEXT PRIMARY KEY` | `PRIMARY KEY(company_id, key)` |
| `tg_sessions` | `chat_id INTEGER PRIMARY KEY` | `PRIMARY KEY(company_id, chat_id)` |
| `users` | `username TEXT UNIQUE` | **оставить глобально уникальным** (решение в 4.1) |
| `masters.access_code` | без ограничений | добавить `UNIQUE(access_code)` глобально (NULL допускается), чтобы legacy-вход мастера по коду без slug оставался однозначным |

`sessions` и `client_sessions`: `token` остаётся PK (токены случайные 48 hex, глобально уникальны), но `company_id` в них обязателен и берётся из него контекст.

### 2.3. Что переезжает из `settings` в `companies`

Только `tg_bot`. Остальные ключи (`loyalty_*`, `reminders_*`, `remind_hours_before`, `repeat_weeks`, `note_gift`, `note_big`, `site_cms`) остаются в `settings` с `company_id`. `loadSettings(env)` -> `loadSettings(env, companyId)`; дефолты те же.

### 2.4. Шифрование токенов

```js
// env.MASTER_KEY: base64 32 байта. Хранение: base64(iv[12] || ciphertext).
async function encryptSecret(env, plain)  // AES-GCM, случайный iv
async function decryptSecret(env, enc)    // '' -> ''
```

Расшифрованный токен никогда не отдаётся в API. `/platform/company-secrets` принимает новый токен и пишет зашифрованный; в ответах только `tg_bot_token_set: true/false`.

## 3. Контекст компании в коде

Ввести один объект и передавать его во все функции вместо голого `env`:

```js
/** @typedef {{ id:number, slug:string, name:string, tz:string, slot_step_min:number, buffer_min:number,
 *   min_lead_min:number, max_ahead_days:number, calendar_id:string, tg_chat_id:string, tg_bot:string,
 *   tg_webhook_secret:string, site_url:string, site_origin:string, phone_prefix:string, active:number,
 *   tgToken: () => Promise<string> }} Company */

async function loadCompanyById(env, id)       // SELECT * FROM companies WHERE id=?
async function loadCompanyBySlug(env, slug)   // SELECT * FROM companies WHERE slug=?
```

`tgToken()` ленивo расшифровывает `tg_bot_token_enc` и кэширует на время запроса.

Правило для исполнителя: **каждая** функция, которая делает `env.DB.prepare(...)`, получает `co` (Company) первым или вторым аргументом и включает `company_id=?` в `WHERE`/`INSERT`. Исключения: `sessionUser`, `clientSession` (ищут по токену и **возвращают** company_id), `loadCompany*`, платформенные функции раздела 7.

Замены точечно:

- `BUSINESS.tz` -> `co.tz`; `BUSINESS.bufferMin` -> `co.buffer_min`; и т. д. `kyivNow()` -> `nowInTz(co.tz)`.
- `env.CALENDAR_ID` -> `co.calendar_id` (`calUrl(co, id)`, `freeBusy`, `listEvents`, `syncCalendar`). Если `calendar_id` пуст: `/slots` считает занятость только по `bookings` этой компании (сейчас код падает без календаря; это можно вынести в отдельную задачу, но минимум: вернуть понятную ошибку `calendar not configured`).
- `env.TELEGRAM_BOT_TOKEN` -> `await co.tgToken()`; `env.TELEGRAM_CHAT_ID` -> `co.tg_chat_id`. Функции `tgApi`, `tgSendTo`, `sendTelegram`, `notifyTelegram` принимают `co`.
- `tgWebhookSecret(env)` -> `co.tg_webhook_secret` (генерируется в `tgSetup` как `randHex(20)` и сохраняется).
- `siteUrl(env)` -> `co.site_url`.
- Все `GAV&amp;LOVE` -> `tgEsc(co.name)`.
- `slotFree`, `pickFreeStaff`, `freeBusy` — мёртвый код (проверено: вызовов нет). Удалить вместе с константой `STAFF`.
- `DEFAULT_MASTERS()` fallback в `loadMasters` -> вернуть `[]`.

## 4. Аутентификация и определение компании

### 4.1. Сотрудники (`/auth/login`)

Решение: `users.username` остаётся **глобально уникальным**, компания определяется из строки `users`. Плюс: экран входа в приложении не меняется (логин + пароль), нет выбора салона. Минус: два салона не могут иметь пользователя `admin`; при создании компании сидировать владельца как `<slug>-owner` (например `gavlove-owner`), а существующих пользователей GAV&LOVE не трогать.

Альтернатива на будущее (не делать сейчас): поле `company` на экране входа и `UNIQUE(company_id, username)`.

- `authLogin`: убрать ветку `password === env.ADMIN_TOKEN` (аварийный вход владельца). Вместо неё раздел 7.
- `issueSession`: писать `company_id` из `users.company_id`.
- Ответ `/auth/login` и `/auth/me` дополнить объектом `company: { id, slug, name, logo_url, color_primary, color_accent, tz, site_url }` — это то, что iOS-приложение использует для брендирования.
- `requireAdmin` / `requireOwner` / `masterFromReq` возвращают сессию с `company_id`; вызывающий код загружает `co = await loadCompanyById(env, s.company_id)` и проверяет `co.active`.
- `userSave` (создание пользователя владельцем): `company_id` берётся из сессии владельца, **никогда** из тела запроса. `master_id` проверяется на принадлежность той же компании.

### 4.2. Клиенты (`/client/*`)

- `/client/otp`, `/client/verify` публичные: требуют `?c=<slug>` (или `X-Company`). `clientByPhone(env, co, phone)` ищет только `WHERE company_id=?`.
- `client_sessions.company_id` заполняется при `issueClientSession`; `requireClient` возвращает клиента и его компанию.
- Один и тот же человек в двух салонах = две независимые строки `clients`. Это нормально.

### 4.3. Мастера (`/master/*`)

- По сессии role=master: `company_id` из сессии.
- По legacy `?code=`: `SELECT * FROM masters WHERE access_code=?` — код глобально уникален (2.2), компания = `masters.company_id`.

### 4.4. Публичные запросы

Функция `companyFromPublicRequest(request, url, env)`: slug из `url.searchParams.get("c")` или заголовка `X-Company`. Нет slug -> **временно** (до обновления сайта GAV&LOVE, шаг 4 миграции) fallback на `company_id=1`, затем `400 company required`. Fallback реализовать через env-переменную `DEFAULT_COMPANY_ID`, чтобы выключить одним `wrangler` без правки кода.

### 4.5. Telegram webhook

- Новый путь `/tg/webhook/<company_id>`. Компания из пути, секрет сверяется с `co.tg_webhook_secret`.
- Старый `/tg/webhook` = алиас на `company_id = DEFAULT_COMPANY_ID`, секрет проверять старым способом (`sha256("tg-webhook:" + token).slice(0,40)`) до перерегистрации, потом удалить.
- `tgSetup` регистрирует новый путь и генерирует `tg_webhook_secret`.
- `tg_sessions` (состояние диалога бота) — ключ `(company_id, chat_id)`. `clientByChat(env, co, chat)` ищет `clients WHERE company_id=? AND tg_chat_id=?`.

## 5. Cron

Сейчас: `0 16 * * *` (дайджест + напоминания «завтра») и `*/30 * * * *` («скоро»). `scheduled()` работает с одной компанией.

Стало:

```
crons = ["0 * * * *", "*/30 * * * *"]
```

- Ежечасный: для каждой `companies WHERE active=1` вычислить локальный час в `co.tz`; если он равен `co.digest_hour` — `runDailyDigest(env, co)` и `runClientReminders(env, co, "day")`. Чтобы не отправить дважды при повторном запуске, хранить в `settings(company_id, 'digest_last_date')` дату последней отправки.
- Каждые 30 минут: для каждой активной компании `runClientReminders(env, co, "soon")`.
- Ошибка одной компании не должна останавливать остальные (`Promise.allSettled`, лог через `console.error` с `co.slug`).
- Cloudflare-лимит: одна инвокация cron ограничена по CPU и сабреквестам (1000 сабреквестов на платном плане, 50 на бесплатном). При росте числа компаний перейти на очередь (Cloudflare Queues) — вне этой итерации, но в коде цикл выделить в отдельную функцию `forEachActiveCompany(env, fn)`.

## 6. CORS

`ALLOW_ORIGIN` как единственный origin убрать. Логика:

```js
const APP_ORIGINS = ["capacitor://localhost", "ionic://localhost", "http://localhost", "https://localhost"]; // iOS/Android wrapper + dev
function corsFor(request, co) {
  const origin = request.headers.get("Origin") || "";
  const allowed = new Set([...APP_ORIGINS, ...(env.PLATFORM_ORIGINS || "").split(","), ...String(co && co.site_origin || "").split(",")].map(s => s.trim()).filter(Boolean));
  return allowed.has(origin) ? origin : (co ? "" : "null");
}
```

Нюанс: для запросов без компании в контексте (`/auth/login` до определения пользователя, `/platform/*`) origin проверяется по `APP_ORIGINS` + `PLATFORM_ORIGINS` (env, через запятую: домен, где хостится общий `admin.html`). Ответ должен содержать `Vary: Origin`. Нативное iOS-приложение (URLSession) CORS не использует, но Capacitor/WebView использует.

## 7. Платформенный суперадмин и онбординг компании

Роль `superadmin` **не** хранится в `users`. Вход: `POST /platform/login {password}` сверяет с `env.ADMIN_TOKEN`, выдаёт сессию в `sessions` с `role='superadmin'`, `company_id=0`, `user_id=0`. `requireSuperadmin(request, env)`.

Эндпоинты (все требуют superadmin):

| Метод | Путь | Тело / ответ |
|---|---|---|
| GET | `/platform/companies` | список компаний без секретов + счётчики (bookings, clients, users) |
| POST | `/platform/company-save` | `{id?, slug, name, active, tz, site_url, site_origin, colors..., calendar_id, tg_chat_id, digest_hour, ...}`; при создании (`id` пуст) выполняется `seedCompany(env, co, template)` |
| POST | `/platform/company-secrets` | `{id, tg_bot_token}` -> шифрует и сохраняет; ответ `{tg_bot_token_set:true}` |
| POST | `/platform/company-owner` | `{id, username, password, name}` -> создаёт `users(role='owner', company_id=id, must_change=1)` |
| POST | `/platform/impersonate` | `{id}` -> выдаёт обычную owner-сессию для компании (для поддержки). Логировать в `settings(company_id,'last_impersonate')` |

`seedCompany(env, co, template='grooming')`: вставляет `services` из `DEFAULT_SERVICES` (сейчас это делает `seedServices` при пустой таблице — переписать на явный вызов с `company_id`), дефолтные `settings`, одного мастера-плейсхолдера не создаём (мастера заводит владелец).

UI для этого в этой итерации не нужен: суперадмин работает через `curl`/скрипт `worker/scripts/new-company.mjs` (написать: принимает slug, name, tz, owner login, выводит webhook-URL и инструкцию для владельца).

## 8. Минимальные правки фронтендов

- `scripts/main.js`: `CONFIG.company = "gavlove"`; все `fetch(bookingEndpoint + path)` добавляют `?c=${CONFIG.company}` (или заголовок). Затронуто: `/site`, `/before-after`, `/masters`, `/slots`, `/catalog`, `/book`, `/reviews`.
- `review.html`, `cabinet.html`: то же для `/review`, `/client/otp`, `/client/verify`. Для `cabinet.html` slug можно взять из `<meta name="company" content="gavlove">`.
- `admin.html`, `master.html`: логин без изменений. После `/auth/me` показывать `company.name` в шапке вместо захардкоженного «GAV&LOVE · CRM» и брать логотип из `company.logo_url` (если пусто — текущий). Это делает один и тот же `admin.html` пригодным для всех компаний.
- Фронтенды остаются в репозитории gav.and.love на этом этапе; вынос общего `admin.html` на отдельный домен платформы — следующая итерация.

## 9. План миграции без простоя

Каждый шаг обратно совместим с предыдущим. Между шагами можно останавливаться.

**Шаг 0. Бэкап.**
```bash
cd worker && npx wrangler d1 export gavlove-crm --remote --output ../backup-$(date +%F).sql
```
Файл не коммитить (в нём персональные данные и фото). Проверить, что он открывается.

**Шаг 1. Аддитивная схема** (файл `worker/migrations/0001_companies.sql`, применить `wrangler d1 execute gavlove-crm --remote --file`):
1. `CREATE TABLE companies (...)` по 2.1.
2. `INSERT INTO companies (id, slug, name, created_at, site_url, site_origin, tz) VALUES (1, 'gavlove', 'GAV&LOVE', <now>, 'https://besenok911-cloud.github.io/gav-and-love', 'https://besenok911-cloud.github.io', 'Europe/Kyiv');`
3. `ALTER TABLE <t> ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;` для всех таблиц из 2.2, кроме `settings`, `tg_sessions`, `masters` (они пересоздаются в шаге 2).
4. Индексы из 2.2 для изменённых таблиц.
5. `UPDATE companies SET tg_bot = (SELECT value FROM settings WHERE key='tg_bot') WHERE id=1;`

Код после этого шага работает как раньше: он не знает о `company_id`, а дефолт 1 всё заполняет.

**Шаг 2. Пересоздание таблиц с составными ключами** (`0002_composite_keys.sql`, одна транзакция):
```sql
CREATE TABLE settings_new (company_id INTEGER NOT NULL DEFAULT 1, key TEXT NOT NULL, value TEXT, PRIMARY KEY (company_id, key));
INSERT INTO settings_new (company_id, key, value) SELECT 1, key, value FROM settings;
DROP TABLE settings; ALTER TABLE settings_new RENAME TO settings;
-- аналогично tg_sessions (PK company_id, chat_id) и masters (UNIQUE(company_id,name), UNIQUE(access_code))
```
Внимание: старый код здесь **сломается**. В нём три `INSERT ... ON CONFLICT(key)` для `settings` и один `ON CONFLICT(chat_id)` для `tg_sessions`; после смены PK эти конструкции перестанут соответствовать ограничению и SQLite вернёт ошибку. Поэтому либо применять шаг 2 сразу перед деплоем шага 3 (окно несколько секунд), либо временно оставить в новых таблицах дополнительные `UNIQUE(key)` / `UNIQUE(chat_id)` и снять их отдельной миграцией после деплоя. Рекомендуется второе. В новом коде upsert пишется как `ON CONFLICT(company_id, key)` и `ON CONFLICT(company_id, chat_id)`.

**Шаг 3. Код Worker.** Вся работа разделов 3–7. Секреты компании читать так: `co.calendar_id || env.CALENDAR_ID`, `tgToken: () => decrypt(co.tg_bot_token_enc) || env.TELEGRAM_BOT_TOKEN`, `co.tg_chat_id || env.TELEGRAM_CHAT_ID` — fallback на env оставить **только на время** шагов 3–5. `DEFAULT_COMPANY_ID=1` в `[vars]`. Деплой. Проверить чеклист раздела 10 на GAV&LOVE.

**Шаг 4. Перенос секретов в базу.** Через `/platform/company-secrets` записать токен бота, через `/platform/company-save` — `calendar_id`, `tg_chat_id`. Вызвать `/admin/tg-setup` владельцем GAV&LOVE, чтобы webhook переехал на `/tg/webhook/1` с новым секретом. Проверить: запись с сайта -> уведомление в чат салона, `/book` в боте, напоминание «скоро» (через `/admin/send-client-reminders`).

**Шаг 5. Фронтенды** (раздел 8): задеплоить сайт с `?c=gavlove`. Через сутки убрать `DEFAULT_COMPANY_ID`, удалить env-fallback из кода, `wrangler secret delete TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID CALENDAR_ID`, удалить алиас `/tg/webhook`, `DROP TABLE catalog`.

**Шаг 6. Вторая компания.** Создать тестовую компанию `demo` скриптом из раздела 7, прогнать раздел 10 на двух компаниях одновременно. Только после этого считать работу принятой.

## 10. Приёмочный чеклист (обязателен)

Изоляция (выполнять с двумя компаниями A=gavlove, B=demo, у каждой свой owner):
- [ ] `/admin/list` под сессией B не содержит ни одной строки A (и наоборот) — проверить по `COUNT(*)` в D1.
- [ ] `/admin/update {id: <id записи A>}` под сессией B -> 404/403, строка A не изменилась. Повторить для `delete`, `client-save`, `pet-save`, `photo-upload {pet_id A}`, `photo-delete`, `review-save`, `master-save`, `service-save`, `expense-save`, `user-save {id A}`, `notify-client {booking_id A}`.
- [ ] `/master/status` мастером B с `id` записи A -> 403.
- [ ] `/client/me` клиентом B не показывает записи A, даже если телефон совпадает.
- [ ] `/client/otp?c=demo` с телефоном клиента, существующего только в A -> «не найден/не подключён», код не отправлен.
- [ ] `/tg/webhook/2` с секретом компании 1 -> 403.
- [ ] Кнопки бота (`ok:/cancel:/mv:<id>`) с `id` записи другой компании игнорируются.
- [ ] `/slots?c=demo` не учитывает календарь A.
- [ ] `/catalog?c=A` и `/catalog?c=B` отдают разные данные и не залипают в кэше (`Cache-Control` / ключ).
- [ ] Компания с `active=0`: все её эндпоинты -> 403, cron её пропускает.

Регресс GAV&LOVE (после каждого деплоя шагов 3–5):
- [ ] Вход owner/admin/master, смена пароля, выход.
- [ ] Запись с сайта с выбором мастера и без; событие в календаре; Telegram-уведомление салону; deep-link клиенту.
- [ ] Перенос и отмена из кабинета клиента и из бота.
- [ ] Дайджест `/admin/send-digest`, напоминания `/admin/send-client-reminders {kind: day|soon}`.
- [ ] Фото «до/после»: загрузка, публикация, `/before-after`, `/photo/<id>/<token>`.
- [ ] Сайт-CMS `/site` и `/admin/site-save`.
- [ ] Отзывы: публичная отправка, модерация, `/reviews`.
- [ ] Расходы, услуги/цены, мастера (график, отпуска, перерыв), пользователи.

Код-ревью:
- [ ] `grep -n "env.DB.prepare" worker/src/index.js` — каждое вхождение либо содержит `company_id`, либо находится в явном списке исключений (раздел 3).
- [ ] `grep -n "GAV\|Kyiv\|besenok911\|STAFF\|BUSINESS\." worker/src/index.js` — пусто (кроме дефолтов в `companies` и шаблона сида).
- [ ] `grep -n "env\.\(TELEGRAM\|CALENDAR\|SITE_URL\|ALLOW_ORIGIN\)" worker/src/index.js` — пусто после шага 5.

## 11. Открытые решения и риски

- **Фото в D1 (BLOB).** Лимит базы D1 10 ГБ. При 5+ активных салонах нужно переносить `pet_photos.data` в R2 (ключ `company_id/pet_id/photo_id`). Не в этой итерации, но `company_id` в `pet_photos` уже готовит путь.
- **Один Google service account на всех.** Владелец каждой компании расшаривает календарь на общий `SA_EMAIL`. Это проще и безопаснее, чем хранить приватные ключи компаний в базе. Минус: все календари доступны платформе, что нужно отразить в договоре с клиентом.
- **Один бот на компанию.** Каждый салон создаёт своего бота через BotFather (как сейчас). Общий бот платформы с выбором салона возможен, но ломает существующих клиентов GAV&LOVE, поэтому нет.
- **Передача GAV&LOVE владельцу.** Раньше план был отдать Worker и базу владельцу салона. В мультитенанте инфраструктура остаётся у платформы, владелец получает роль owner. Это нужно согласовать с ним до шага 3.
- **Часовые пояса.** Пока все компании в Europe/Kyiv; код должен работать и с другими `tz`, но тестировать это на второй компании с `tz='Europe/Warsaw'`.
- **Лимиты cron.** См. раздел 5.
- **`users.username` глобальный.** См. 4.1; при первых конфликтах переходить к варианту с полем компании на входе.

## 12. Что получит iOS-приложение после этой работы

- `POST /auth/login {username, password}` -> `{token, role, name, company:{slug,name,logo_url,color_primary,color_accent,tz,site_url}}`.
- Все `/admin/*`, `/master/*` с `Authorization: Bearer <token>`; компания определяется сервером, приложение её не передаёт.
- Клиентское приложение: `/client/otp?c=<slug>` и далее `/client/*` по токену.
- Ни один эндпоинт не меняет путь, поэтому веб-CRM и приложение работают против одного API.
