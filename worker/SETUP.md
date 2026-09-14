# Онлайн-запис GAV&LOVE — активація (Google Calendar + Telegram)

Разова настройка. Далі сайт сам показує вільні слоти, створює події в календарі та шле сповіщення у Telegram.

> Поки цей крок не зроблено, форма на сайті працює в м'якому режимі: дякує клієнту й пропонує написати в Direct / зателефонувати. Заявки в цей момент **нікуди не надсилаються** автоматично.

## 1. Telegram-бот (сповіщення про заявки) — мінімум для роботи форми
1. У Telegram напишіть **@BotFather** → `/newbot` → отримайте **token**.
2. Напишіть щось своєму боту, потім відкрийте
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → знайдіть `chat.id` — це **TELEGRAM_CHAT_ID**.

## 2. Google Calendar (щоб показувати вільний час і створювати записи) — за бажанням
1. https://console.cloud.google.com → створити проєкт → **APIs & Services → Library** → **Google Calendar API** → **Enable**.
2. **Credentials → Create credentials → Service account** → відкрити його → **Keys → Add key → JSON**. У файлі знадобляться `client_email` і `private_key`.
3. https://calendar.google.com → створити календар «GAV&LOVE записи» → **Settings → Share with specific people** → додати `client_email` з правами **«Make changes to events»**.
4. Там же **Integrate calendar → Calendar ID** — скопіювати.

## 3. Деплой Worker (Cloudflare)
У папці `worker/`:
```bash
npm install
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
# наступні три — лише якщо налаштували календар (крок 2):
npx wrangler secret put SA_EMAIL          # client_email з JSON
npx wrangler secret put SA_PRIVATE_KEY    # private_key з JSON (весь блок BEGIN...END)
npx wrangler secret put CALENDAR_ID       # Calendar ID з кроку 2
npx wrangler deploy
```
Після `deploy` буде URL воркера, напр. `https://gavlove-booking.<акаунт>.workers.dev`.

## 4. Підключити сайт
У `scripts/main.js`, в об'єкті `CONFIG`, вписати цей URL у поле `bookingEndpoint`, закомітити й запушити.
Через ~1 хв форма на сайті почне показувати вільний час і надсилати заявки у Telegram.

## Робочі години / тривалість послуг
Налаштовуються у `worker/src/index.js`: `BUSINESS` (години, кроки слотів) та `SERVICE_DURATIONS`.
