/**
 * GAV&LOVE — booking Worker
 * Two-way Google Calendar sync via a Google service account.
 *
 *  GET  /slots?date=YYYY-MM-DD&service=<name>  -> { slots: ["10:00","10:30",...] }
 *  POST /book   { pet, service, breed, name, phone, date, time, note }
 *               -> creates a Calendar event (grooming) or a request, notifies Telegram
 *
 * Secrets (wrangler secret put ...):
 *   SA_EMAIL            service account email
 *   SA_PRIVATE_KEY      service account private key (PEM, with \n newlines)
 *   CALENDAR_ID         target Google Calendar id (e.g. xxx@group.calendar.google.com)
 *   TELEGRAM_BOT_TOKEN  bot token
 *   TELEGRAM_CHAT_ID    chat id to notify
 *   ALLOW_ORIGIN        allowed site origin (e.g. https://besenok911-cloud.github.io)
 *   ADMIN_TOKEN         emergency owner password for the CRM (a password, not a bearer token)
 *   PLATFORM_TOKEN      operator-only: download the nightly dumps (/admin/backup-*)
 *
 * One worker serves one salon: its own D1, its own buckets, its own secrets. SECRETS_KEY is gone
 * with the per-company credential store it used to encrypt.
 */

/* Which build is running. Bump it with any change that goes out to a salon: when a salon someone
   else now owns misbehaves, the first question is which version it is on, and there is no other way
   to ask. Reported by GET /health. */
const VERSION = "2026-10-12";
/* Штамп конкретної збірки. Рядок нижче переписує release.yml перед викочуванням — sed-ом по
   ЦЬОМУ файлу, а не через змінну оточення: VERSION живе в модульній області, де env ще не існує,
   і спроба прочитати env тут поклала б воркер на кожному запиті (node --check такого не бачить).
   По ньому ж workflow перевіряє, що поїхав саме той код, який мав. "dev" = зібрано з ноутбука. */
const BUILD = "dev";

const BUSINESS = {
  tz: "Europe/Kyiv",
  openMin: 10 * 60,          // 10:00
  closeMin: 20 * 60,         // 20:00
  slotStepMin: 30,
  bufferMin: 30,
  minLeadMin: 120,           // earliest bookable = now + 2h
  maxAheadDays: 30,
  workingDays: [0, 1, 2, 3, 4, 5, 6], // 0=Sun ... 6=Sat (all days)
};

const SERVICE_DURATIONS = {
  "Гігієнічний комплекс": 120,
  "Повний комплекс (зі стрижкою)": 150,
  "Стрижка": 90,
  "Вичісування / експрес-линька": 90,
  "Догляд для котиків": 120,
};
const DEFAULT_DURATION = 120;
// services that are NOT fixed time slots — sent as a request instead
const REQUEST_SERVICES = new Set(["Міні-готель", "Денний садочок"]);
// DEFAULT_SERVICES (unified: booking + price) is defined at the bottom of the
// file, built from DEFAULT_PRICES so the seed data lives in one place.

/* ----------------------------- HTTP entry ----------------------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // CORS is built before anything can fail, so that an error below still reaches the browser as
    // an error rather than as "network failure" with no body.
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      // Before anything touches the database. Yesterday's dump lives in R2, and the moment you
      // most want it is the moment D1 is not answering.
      // The dump holds every client's name and phone, password hashes and live session tokens.
      // That is the operator's business, not the salon's, so it sits behind its own secret and
      // has no button anywhere in the CRM.
      if (url.pathname === "/admin/backup-run" && request.method === "POST") {
        requirePlatform(request, env);
        let body = {}; try { body = await request.json(); } catch (e) { }
        return json(await runBackup(env, !!(body && body.monthly)), cors);
      }
      if (url.pathname === "/admin/backup-list" && request.method === "GET") {
        requirePlatform(request, env);
        return json(await backupList(env), cors);
      }
      if (url.pathname === "/admin/backup-get" && request.method === "GET") {
        requirePlatform(request, env);
        const obj = await backupFetch(env, url.searchParams.get("key"));
        if (!obj) return json({ ok: false, error: "not found" }, cors, 404);
        return new Response(obj.body, { headers: { ...cors, "Content-Type": "application/sql; charset=utf-8", "Cache-Control": "no-store" } });
      }
      // Without the operator's token: the build and nothing else, and it does not touch the
      // database — an uptime monitor hitting this every minute should cost nothing.
      if (url.pathname === "/health" && request.method === "GET") {
        if (!env.PLATFORM_TOKEN || bearer(request) !== env.PLATFORM_TOKEN) {
          return json({ ok: true, version: VERSION, build: BUILD }, cors);
        }
        return json(await health(env, url.origin), cors);
      }
      if (env.DB) {
        const salon = await loadSalon(env);          // throws rather than guessing which salon this is
        env = Object.assign({}, env, { CID: salon.id, SALON: salon.name, DBRAW: env.DB });
      }
      if (url.pathname === "/slots" && request.method === "GET") {
        return json(await getSlots(url, env), cors);
      }
      if (url.pathname === "/book" && request.method === "POST") {
        return json(await book(await request.json(), env), cors);
      }
      // ---- Admin (CRM) — all require ADMIN_TOKEN ----
      if (url.pathname === "/admin/list" && request.method === "GET") {
        return json(await adminList(request, env), cors);
      }
      if (url.pathname === "/admin/create" && request.method === "POST") {
        return json(await adminCreate(request, env), cors);
      }
      if (url.pathname === "/admin/update" && request.method === "POST") {
        return json(await adminUpdate(request, env), cors);
      }
      if (url.pathname === "/admin/delete" && request.method === "POST") {
        return json(await adminDelete(request, env), cors);
      }
      if (url.pathname === "/admin/clients" && request.method === "GET") {
        return json(await adminClients(request, env), cors);
      }
      if (url.pathname === "/admin/pets" && request.method === "GET") {
        return json(await adminPets(request, env), cors);
      }
      if (url.pathname === "/admin/client-save" && request.method === "POST") {
        return json(await clientSave(request, env), cors);
      }
      if (url.pathname === "/admin/client-delete" && request.method === "POST") {
        return json(await clientDelete(request, env), cors);
      }
      if (url.pathname === "/admin/pet-save" && request.method === "POST") {
        return json(await petSave(request, env), cors);
      }
      if (url.pathname === "/admin/pet-delete" && request.method === "POST") {
        return json(await petDelete(request, env), cors);
      }
      if (url.pathname === "/masters" && request.method === "GET") {
        return json(await publicMasters(env), cors);   // public: for the booking form
      }
      // ---- Master cabinet (per-master access code, no ADMIN_TOKEN) ----
      if (url.pathname === "/client/otp" && request.method === "POST") return json(await clientOtp(await request.json(), env, request), cors);
      if (url.pathname === "/client/verify" && request.method === "POST") return json(await clientVerify(await request.json(), env), cors);
      if (url.pathname === "/client/me" && request.method === "GET") return json(await clientMe(request, url, env), cors);
      if (url.pathname === "/client/booking-cancel" && request.method === "POST") return json(await clientCancel(request, env), cors);
      if (url.pathname === "/client/booking-move" && request.method === "POST") return json(await clientMove(request, env), cors);
      if (url.pathname === "/client/pet-save" && request.method === "POST") return json(await clientPetSave(request, env), cors);
      if (url.pathname === "/client/photo" && request.method === "POST") return json(await clientPhotoUpload(request, env), cors);
      if (url.pathname === "/client/photo-delete" && request.method === "POST") return json(await clientPhotoDelete(request, env), cors);
      if (url.pathname === "/client/profile" && request.method === "POST") return json(await clientProfile(request, env), cors);
      if (url.pathname === "/client/logout" && request.method === "POST") return json(await clientLogout(request, env), cors);
      if (url.pathname === "/master/data" && request.method === "GET") {
        return json(await masterData(request, url, env), cors);
      }
      if (url.pathname === "/master/status" && request.method === "POST") {
        return json(await masterStatus(request, await request.json(), env), cors);
      }
      if (url.pathname === "/master/photo" && request.method === "POST") return json(await masterPhotoUpload(request, env), cors);
      if (url.pathname === "/master/photos" && request.method === "GET") return json(await masterPhotos(request, url, env), cors);
      if (url.pathname === "/master/photo-delete" && request.method === "POST") return json(await masterPhotoDelete(request, env), cors);
      // ---- Reviews ----
      if (url.pathname === "/review" && request.method === "POST") {
        return json(await reviewCreate(await request.json(), env), cors);   // public: client submits
      }
      if (url.pathname === "/reviews" && request.method === "GET") {
        return json(await publicReviews(env), { ...cors, "Cache-Control": "public, max-age=60" });
      }
      if (url.pathname === "/admin/reviews" && request.method === "GET") {
        return json(await adminReviews(request, env), cors);
      }
      if (url.pathname === "/admin/review-save" && request.method === "POST") {
        return json(await reviewSave(request, env), cors);
      }
      if (url.pathname === "/admin/review-delete" && request.method === "POST") {
        return json(await reviewDelete(request, env), cors);
      }
      // ---- Auth / accounts ----
      if (url.pathname === "/auth/login" && request.method === "POST") {
        return json(await authLogin(await request.json(), env), cors);
      }
      if (url.pathname === "/auth/me" && request.method === "GET") {
        return json(await authMe(request, env), cors);
      }
      if (url.pathname === "/auth/change-password" && request.method === "POST") {
        return json(await authChangePassword(request, env), cors);
      }
      if (url.pathname === "/auth/logout" && request.method === "POST") {
        return json(await authLogout(request, env), cors);
      }
      // «Забули пароль?» — публічні, як і сам вхід. Код отримує лише власниця, у свій особистий чат з ботом.
      if (url.pathname === "/auth/reset-request" && request.method === "POST") {
        return json(await authResetRequest(await request.json().catch(() => ({})), env, request), cors);
      }
      if (url.pathname === "/auth/reset-confirm" && request.method === "POST") {
        return json(await authResetConfirm(await request.json().catch(() => ({})), env), cors);
      }
      if (url.pathname === "/admin/users" && request.method === "GET") {
        return json(await adminUsers(request, env), cors);
      }
      if (url.pathname === "/admin/user-save" && request.method === "POST") {
        return json(await userSave(request, env), cors);
      }
      if (url.pathname === "/admin/user-delete" && request.method === "POST") {
        return json(await userDelete(request, env), cors);
      }
      // ---- Client reminders via Telegram ----
      if ((url.pathname === "/tg/webhook" || /^\/tg\/webhook\/\d+$/.test(url.pathname)) && request.method === "POST") {
        return json(await tgWebhook(request, env), cors);        // called by Telegram (secret header checked inside)
      }
      // Кабінет у боті для персоналу: одноразове посилання, стан і відключення. Сесія CRM будь-якої
      // ролі, крім підтримки; власниця відключає будь-кого з «Доступи».
      if (url.pathname === "/staff/tg" && request.method === "GET") return json(await staffTgStatus(request, env), cors);
      if (url.pathname === "/staff/tg-link" && request.method === "POST") return json(await staffTgLink(request, env), cors);
      if (url.pathname === "/staff/tg-unlink" && request.method === "POST") return json(await staffTgUnlinkSelf(request, env), cors);
      if (url.pathname === "/admin/user-tg-unlink" && request.method === "POST") return json(await adminUserTgUnlink(request, env), cors);
      if (url.pathname === "/admin/tg-setup" && request.method === "POST") {
        return json(await tgSetup(request, env), cors);          // owner: register webhook, remember bot username
      }
      if (url.pathname === "/admin/notify-client" && request.method === "POST") return json(await notifyClientManual(request, env), cors);
      if (url.pathname === "/admin/notify-broadcast" && request.method === "POST") return json(await notifyBroadcast(request, env), cors);
      if (url.pathname === "/admin/send-client-reminders" && request.method === "POST") {
        await requireAdmin(request, env);
        const b = await request.json().catch(() => ({}));
        return json(await runClientReminders(env, b && b.kind === "soon" ? "soon" : "day", true), cors);
      }
      if (url.pathname.startsWith("/photo/") && request.method === "GET") return photoServe(url, env, cors);
      if (url.pathname.startsWith("/img/") && request.method === "GET") return siteImageServe(url, env, cors);   // photos of the site itself
      if (url.pathname === "/admin/photos" && request.method === "GET") return json(await adminPhotos(request, url, env), cors);
      if (url.pathname === "/admin/photo-upload" && request.method === "POST") return json(await photoUpload(request, env), cors);
      if (url.pathname === "/admin/photo-delete" && request.method === "POST") return json(await photoDelete(request, env), cors);
      if (url.pathname === "/admin/photos-to-r2" && request.method === "POST") return json(await photosToR2(request, env), cors);
      if (url.pathname === "/catalog" && request.method === "GET") {
        return json(await publicCatalog(env), { ...cors, "Cache-Control": "public, max-age=60" });
      }
      if (url.pathname === "/before-after" && request.method === "GET") {   // published «До / після» pairs for the site gallery
        return json(await publicBeforeAfter(url, env), { ...cors, "Cache-Control": "public, max-age=60" });
      }
      if (url.pathname === "/admin/photo-publish" && request.method === "POST") return json(await photoPublish(request, env), cors);
      if (url.pathname === "/admin/services" && request.method === "GET") {
        return json(await adminServices(request, env), cors);
      }
      if (url.pathname === "/admin/service-save" && request.method === "POST") {
        return json(await serviceSave(request, env), cors);
      }
      if (url.pathname === "/admin/service-delete" && request.method === "POST") {
        return json(await serviceDelete(request, env), cors);
      }
      if (url.pathname === "/admin/expenses" && request.method === "GET") {
        return json(await adminExpenses(request, env), cors);
      }
      if (url.pathname === "/admin/expense-save" && request.method === "POST") {
        return json(await expenseSave(request, env), cors);
      }
      if (url.pathname === "/admin/expense-delete" && request.method === "POST") {
        return json(await expenseDelete(request, env), cors);
      }
      if (url.pathname === "/admin/masters" && request.method === "GET") {
        return json(await adminMasters(request, env), cors);
      }
      if (url.pathname === "/admin/master-save" && request.method === "POST") {
        return json(await masterSave(request, env), cors);
      }
      if (url.pathname === "/admin/master-delete" && request.method === "POST") {
        return json(await masterDelete(request, env), cors);
      }
      // Те саме, що /health під ключем оператора, але під звичайним логіном CRM. Монітор аптайму
      // стукає в /health і бази не чіпає — сюди ходить людина, і тільки залогінена.
      if (url.pathname === "/admin/health" && request.method === "GET") {
        await requireAdmin(request, env);
        return json(await health(env, url.origin), cors);
      }
      // Машинні ручки для release.yml. Окремий секрет DEPLOY_TOKEN, а не PLATFORM_TOKEN:
      // той відкриває нічні дампи з телефонами і хешами паролів, і в GitHub йому не місце.
      // Анкета власниці салону — вона заповнює її на сторінці системи, відповіді приходять
      // розробнику в телеграм. Ручка публічна: анкету заповнюють ДО того, як з'явився акаунт.
      if (url.pathname === "/brief" && request.method === "POST") {
        return json(await briefSubmit(request, env), cors);
      }
      if (url.pathname === "/release/ask" && request.method === "POST") {
        return json(await releaseAsk(request, env), cors);
      }
      if (url.pathname === "/release/state" && request.method === "GET") {
        return json(await releaseState(request, url, env), cors);
      }
      if (url.pathname === "/release/last" && request.method === "GET") {
        return json(await releaseLast(request, env), cors);
      }
      if (url.pathname === "/release/done" && request.method === "POST") {
        return json(await releaseDone(request, env), cors);
      }
      // Історія випусків для CRM. НЕ поле в supportState(): /admin/support стоїть у білому
      // списку підтримки, і все, що там лежить, підтримка бачить.
      if (url.pathname === "/admin/releases" && request.method === "GET") {
        await requireAdmin(request, env);
        return json(await releaseList(env), cors);
      }
      if (url.pathname === "/admin/support" && request.method === "GET") {
        await requireAdmin(request, env);
        return json(await supportState(env), cors);
      }
      if (url.pathname === "/admin/support-open" && request.method === "POST") {
        return json(await supportOpen(request, env), cors);
      }
      if (url.pathname === "/admin/support-close" && request.method === "POST") {
        return json(await supportClose(request, env), cors);
      }
      if (url.pathname === "/admin/settings" && request.method === "GET") {
        return json(await adminSettings(request, env), cors);
      }
      if (url.pathname === "/admin/settings-save" && request.method === "POST") {
        return json(await settingsSave(request, env), cors);
      }
      // ---- Site CMS (CRM «Сайт» tab): hidden sections + text overrides for index.html ----
      if (url.pathname === "/site" && request.method === "GET") {
        return json(await publicSite(env, url.origin), { ...cors, "Cache-Control": "public, max-age=60" });   // public: read by the site
      }
      if (url.pathname === "/admin/site-save" && request.method === "POST") {
        return json(await siteSave(request, env), cors);
      }
      if (url.pathname === "/admin/site-image" && request.method === "POST") {
        return json(await siteImageUpload(request, env), cors);
      }
      if (url.pathname === "/admin/send-digest" && request.method === "POST") {
        await requireAdmin(request, env);
        return json(await runDailyDigest(env, true), cors);
      }
      return json({ ok: false, error: "not found" }, cors, 404);
    } catch (e) {
      // 4xx — це відповідь людині («невірний пароль», «немає доступу»), а не поломка. У лог іде
      // те, що впало саме: без цього wrangler tail показував лише «POST … - Ok».
      const status = e && e.status || 500;
      // Токен фото в шляху — це вічне посилання на фото улюбленця, у лог його не пишемо.
      if (status >= 500) console.error(`${request.method} ${url.pathname.replace(/^(\/photo\/\d+\/)[^/]+/, "$1…")}: ${errText(e)}`);
      return json({ ok: false, error: String(e && e.message || e) }, cors, status);
    }
  },

  // Cloudflare Cron Triggers: daily → salon digest + day-before client reminders; every 30 min → "starting soon" client reminders.
  async scheduled(event, env, ctx) {
    const cron = (event && event.cron) || "";
    ctx.waitUntil((async () => {
      const salon = await loadSalon(env).catch(() => ({ id: DEFAULT_COMPANY_ID, name: "" }));
      const e = Object.assign({}, env, { CID: salon.id, SALON: salon.name, DBRAW: env.DB });
      const logged = what => err => console.error(`cron ${what}: ${errText(err)}`);
      if (cron.startsWith("*/30")) { await runClientReminders(e, "soon").catch(logged("нагадування «скоро»")); return; }
      await runDailyDigest(e).catch(logged("зведення"));
      await runClientReminders(e, "day").catch(logged("нагадування напередодні"));
      await siteMediaSweep(e).catch(logged("прибирання фото сайту"));
      await runBackup(e).catch(logged("бекап"));
    })());
  },
};

/* ---------- The salon ------------------------------------------------------------------------
   One installation, one salon. The company row survives as the salon's own card — its name, the
   address of its site, its working hours — and its id still stamps every row, so a database can be
   read by a tool that expects it and nothing had to be rebuilt to get here. What is gone is the
   machinery that served SEVERAL salons from one worker: choosing which one a request belongs to,
   keeping their credentials apart, and the guard that rewrote every query to name company_id.
   With one salon that guard protected nobody while refusing any query it could not parse. */
const DEFAULT_COMPANY_ID = 1;
/* The salon this installation belongs to. Today it answers one question — which id stamps the
   rows — and the companies row exists mostly so the database stays readable by anything that
   expects it. The row also holds a name and working hours, but nothing reads those yet: the hours
   are still the BUSINESS constant at the top of this file.
   A missing row is a salon that has not filled it in, which is fine. A database that cannot be
   read is not fine, and used to be answered by quietly carrying on as company 1 — with company 1's
   secrets. */
async function loadSalon(env) {
  try {
    const co = await env.DB.prepare(`SELECT id, name FROM companies WHERE id=?`).bind(DEFAULT_COMPANY_ID).first();
    return { id: DEFAULT_COMPANY_ID, name: (co && co.name) || "" };
  } catch (e) {
    const err = new Error("Не вдалося прочитати дані салону"); err.status = 503; throw err;
  }
}
/* The operator's key. It guards the nightly dumps, which cover the whole database — every client's
   name and phone, password hashes, live session tokens. It is deliberately NOT the salon owner's
   password: when the salon is handed over, the owner gets the CRM, and whoever keeps the backups
   keeps this secret. Credentials themselves are ordinary worker secrets again (wrangler secret put),
   because one worker now serves one salon. */
function requirePlatform(request, env) {
  const tok = bearer(request);
  if (!env.PLATFORM_TOKEN || tok !== env.PLATFORM_TOKEN) {
    const e = new Error("Доступ лише для платформи"); e.status = 401; throw e;
  }
  return true;
}
const json = (obj, cors, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });

/* ----------------------------- Timezone ----------------------------- */
// Offset (minutes) of a timezone at a given UTC instant — handles DST.
function tzOffsetMin(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}
// Local wall time (Y-M-D H:M in tz) -> UTC Date
function wallToUTC(y, m, d, min, tz) {
  const guess = new Date(Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60));
  const off = tzOffsetMin(guess, tz);
  return new Date(guess.getTime() - off * 60000);
}
const pad = n => String(n).padStart(2, "0");
const hhmm = min => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
// RFC3339 with the tz offset for a wall time (for Calendar event start/end)
function wallToRFC(y, m, d, min, tz) {
  const utc = wallToUTC(y, m, d, min, tz);
  const off = tzOffsetMin(utc, tz);
  const sign = off >= 0 ? "+" : "-";
  const ao = Math.abs(off);
  return `${y}-${pad(m)}-${pad(d)}T${hhmm(min)}:00${sign}${pad(Math.floor(ao / 60))}:${pad(ao % 60)}`;
}

/* Whether this installation keeps its schedule in Google. A salon that does is read from there;
   one that does not is read from its own bookings table (dbBusy below). Both answers are real —
   what used to be unsafe was the third case, "no calendar, therefore nothing is booked". */
const calOn = env => !!(env && env.CALENDAR_ID && env.SA_EMAIL && env.SA_PRIVATE_KEY);
async function calEvents(env, timeMin, timeMax) {
  if (!calOn(env)) return [];
  return await listEvents(env, await getAccessToken(env), timeMin, timeMax);
}
/* Busy time taken from our own bookings, in the shape listEvents returns.
   Used ONLY where no calendar is configured. A salon that has one keeps it as the single source,
   so nothing changes for an installation that works today; one without a calendar stops handing
   out slots it has already sold. Requests are left out on purpose: they are the rows that never
   reach the calendar either, so both sources describe the same set of appointments. */
async function dbBusy(env, iso, exclude) {
  if (!env.DB) return [];
  // Anything with a real time on the clock counts, request or not: a request that the salon has
  // since confirmed keeps is_request=1 forever, and skipping those would hand the hour out twice.
  // no_show is excluded because the calendar drops its event too, so both sources say the same.
  // No try/catch on purpose: a swallowed error here would answer "the whole day is free", which is
  // the one answer that must never be a guess.
  const dur = new Map((await loadServices(env)).map(x => [x.name, x.duration]));
  const { results } = await env.DB.prepare(
    `SELECT id, time, service, staff, duration FROM bookings
      WHERE date=? AND time<>'' AND COALESCE(status,'new') NOT IN ('cancelled', 'no_show')`
  ).bind(iso).all();
  const { y, m, d } = parseDate(iso);
  return (results || []).map(b => {
    if (exclude && b.id === exclude) return null;
    const t = /^(\d{1,2}):(\d{2})$/.exec(b.time || "");
    if (!t) return null;
    // Записанные минуты важнее сегодняшнего прайса: строку могли удалить, цену поправить
    // задним числом, а сколько длился прошлый визит — это факт, а не вычисление.
    const mins = b.duration || dur.get(b.service) || SERVICE_DURATIONS[b.service] || DEFAULT_DURATION;
    const start = wallToUTC(y, m, d, (+t[1]) * 60 + (+t[2]), BUSINESS.tz).getTime();
    // A booking nobody is assigned to still occupies the salon, so it blocks every master rather
    // than none. Calendar events never carry this flag, so a salon on Google is unaffected.
    return { id: "db:" + b.id, start, end: start + mins * 60000, staff: b.staff || "", blockAll: !b.staff };
  }).filter(Boolean);
}
// The single answer to "what is already taken that day".
async function busyEvents(env, iso, timeMin, timeMax, exclude) {
  return calOn(env) ? await calEvents(env, timeMin, timeMax) : await dbBusy(env, iso, exclude);
}
/* ----------------------------- Google auth ----------------------------- */
async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: env.SA_EMAIL,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  };
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc(header)}.${enc(claim)}`;
  const key = await importPrivateKey(env.SA_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("google auth failed: " + JSON.stringify(data));
  return data.access_token;
}

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function importPrivateKey(pem) {
  const body = pem.replace(/\\n/g, "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const bin = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", bin.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]);
}

/* ----------------------------- Calendar ----------------------------- */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) throw new Error("bad date");
  return { y: +m[1], m: +m[2], d: +m[3] };
}

// List timed events in [timeMin,timeMax] with their assigned staff (from extendedProperties).
async function listEvents(env, token, timeMin, timeMax) {
  const u = calUrl(env) +
    `?singleEvents=true&maxResults=250&orderBy=startTime` +
    `&timeMin=${encodeURIComponent(timeMin.toISOString())}` +
    `&timeMax=${encodeURIComponent(timeMax.toISOString())}`;
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const d = await res.json();
  return (d.items || []).filter(e => e.start && e.start.dateTime).map(e => ({
    id: e.id,
    start: new Date(e.start.dateTime).getTime(),
    end: new Date(e.end.dateTime).getTime(),
    staff: (e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.staff) || "",
  }));
}

// Events overlapping [start,end] (with buffer on both sides).
function overlappingAt(events, start, end) {
  const buf = BUSINESS.bufferMin * 60000;
  return events.filter(ev => start < ev.end + buf && end + buf > ev.start);
}

/* ----------------------------- Masters & schedule ----------------------------- */
function hmToMin(t) { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function parseVac(s) { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
/* An empty roster used to fall back to a hard-coded one. For a salon that is not GAV&LOVE that
   meant strangers in its booking form and, worse, three times its real capacity. Empty now means
   empty: no masters, no slots, and the salon fills its own list before it opens. */
async function loadMasters(env) {
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(`SELECT * FROM masters ORDER BY sort, id`).all();
    if (!results || !results.length) return [];
    return results.map(r => ({
      name: r.name, active: r.active ? 1 : 0,
      startMin: hmToMin(r.work_start) || 600, endMin: hmToMin(r.work_end) || 1200,
      breakStart: hmToMin(r.break_start), breakEnd: hmToMin(r.break_end),
      daysOff: String(r.days_off || "").split(",").map(x => x.trim()).filter(x => x !== "").map(Number),
      vacations: parseVac(r.vacations),
      tier: r.tier || "",
    }));
  } catch (e) {
    // An empty roster and an unreachable database are different facts. Returning [] for both made
    // a D1 blip look like "no free times today": the visitor is told a lie and leaves.
    const err = new Error("Не вдалося прочитати список майстрів");
    err.status = 503; throw err;
  }
}
// Does this master work on the given date? dow = JS getDay() (0=Sun..6=Sat).
function masterWorks(mst, iso, dow) {
  if (!mst.active) return false;
  if (mst.daysOff.includes(dow)) return false;
  for (const v of mst.vacations) if (v && v.from && v.to && iso >= v.from && iso <= v.to) return false;
  return true;
}
// Does [sMin,eMin] overlap the master's lunch break?
function inBreak(mst, sMin, eMin) {
  return mst.breakStart != null && mst.breakEnd != null && mst.breakStart < mst.breakEnd && sMin < mst.breakEnd && eMin > mst.breakStart;
}

async function getSlots(url, env) {
  const iso = url.searchParams.get("date");
  const { y, m, d } = parseDate(iso);
  const service = url.searchParams.get("service") || "";
  const reqStaff = url.searchParams.get("staff") || "";     // "" = будь-який майстер
  let breed = url.searchParams.get("breed") || "";
  let weight = url.searchParams.get("weight") || "";
  const excl = Number(url.searchParams.get("exclude"));   // booking being rescheduled: its own time must not block the picker
  const exclId = (Number.isInteger(excl) && excl > 0) ? excl : 0;
  // On a reschedule the booking itself knows the breed, so the client cabinet and the bot do not
  // have to send it — and there is deliberately no "how many minutes" parameter for anyone to send.
  if (exclId && !breed && env.DB) {
    try {
      const r = await env.DB.prepare(`SELECT breed, weight FROM bookings WHERE id=?`).bind(exclId).first();
      if (r) { breed = r.breed || ""; weight = weight || r.weight || ""; }
    } catch (e) { }
  }
  const duration = await bookingDuration(env, { service, breed, weight });
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  const masters = await loadMasters(env);
  let working = masters.filter(mst => masterWorks(mst, iso, dow));
  if (reqStaff) working = working.filter(mst => mst.name === reqStaff);
  if (!working.length) return { ok: true, slots: [] };      // day off / vacation / inactive

  const dayStart = wallToUTC(y, m, d, 0, BUSINESS.tz);
  const dayEnd = wallToUTC(y, m, d, 24 * 60, BUSINESS.tz);
  let events = await busyEvents(env, iso, dayStart, dayEnd, exclId);
  if (exclId && env.DB && calOn(env)) {
    const row = await env.DB.prepare(`SELECT event_id FROM bookings WHERE id=?`).bind(exclId).first();
    if (row && row.event_id) events = events.filter(ev => ev.id !== row.event_id);
  }

  const earliest = Date.now() + BUSINESS.minLeadMin * 60000;
  const maxTime = Date.now() + BUSINESS.maxAheadDays * 86400000;
  const openMin = Math.min(...working.map(mst => mst.startMin));
  const closeMin = Math.max(...working.map(mst => mst.endMin));
  const slots = [];
  for (let t = openMin; t + duration <= closeMin; t += BUSINESS.slotStepMin) {
    const start = wallToUTC(y, m, d, t, BUSINESS.tz).getTime();
    const end = start + duration * 60000;
    if (start < earliest || start > maxTime) continue;
    // available if some working master's window covers [t,t+dur] and they're free
    const avail = working.some(mst =>
      t >= mst.startMin && t + duration <= mst.endMin && !inBreak(mst, t, t + duration) &&
      !overlappingAt(events, start, end).some(ev => ev.blockAll || ev.staff === mst.name));
    if (avail) slots.push(hhmm(t));
  }
  return { ok: true, slots };
}

async function book(body, env, source) {
  source = source || "site";   // "site" (booking form) or "telegram" (bot conversation)
  const { pet, pet_name, service, breed, name, date, time, note, weight } = body || {};
  const phone = stdPhone(body && body.phone);   // one stored format, whatever was typed
  let staff = (body && body.staff) || "";
  const waitlist = !!(body && body.waitlist);
  if (!name || !phone) return { ok: false, error: "Вкажіть ім'я і телефон" };

  const masters = await loadMasters(env);
  if (staff && !masters.some(mst => mst.name === staff)) staff = "";  // ignore unknown master

  const isRequest = (await serviceIsRequest(env, service)) || !time || waitlist;
  let eventLink = null, eventId = null, visitMin = null;

  if (!isRequest) {
    const { y, m, d } = parseDate(date);
    const tm = /^(\d{2}):(\d{2})$/.exec(time);
    if (!tm) return { ok: false, error: "bad time" };
    const startMin = (+tm[1]) * 60 + (+tm[2]);
    const duration = await bookingDuration(env, { service, breed, weight });
    visitMin = duration;
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

    const start = wallToUTC(y, m, d, startMin, BUSINESS.tz);
    const end = new Date(start.getTime() + duration * 60000);
    const events = await busyEvents(env, date,
      new Date(start.getTime() - BUSINESS.bufferMin * 60000),
      new Date(end.getTime() + BUSINESS.bufferMin * 60000), 0);
    const isFree = mst => startMin >= mst.startMin && startMin + duration <= mst.endMin &&
      !inBreak(mst, startMin, startMin + duration) && masterWorks(mst, date, dow) &&
      !overlappingAt(events, start.getTime(), end.getTime()).some(ev => ev.blockAll || ev.staff === mst.name);
    if (staff) {
      const mst = masters.find(x => x.name === staff);
      if (!mst || !isFree(mst)) return { ok: false, error: "На жаль, цей час уже зайнятий у майстра. Оберіть інший." };
    } else {
      const freeM = masters.find(isFree);
      if (!freeM) return { ok: false, error: "На жаль, цей час щойно зайняли. Оберіть інший, будь ласка." };
      staff = freeM.name;
    }

    if (calOn(env)) {          // the token is fetched here, not above: busy time no longer needs one
      const ev = await calCreate(env, await getAccessToken(env),
        { pet, pet_name, service, breed, weight, name, phone, note, date, time, staff, source });
      eventLink = ev.htmlLink;
      eventId = ev.id;
    }
  }

  const saved = (await saveBooking(env, { pet, pet_name, service, breed, weight, name, phone, date, time, note, isRequest, eventLink, eventId, staff, source, waitlist, duration: visitMin, addons: (body && body.addons) })) || {};
  // Після saveBooking, а не до: так у сповіщенні є номер запису і кнопки «Підтвердити / Відкрити».
  // saveBooking і notifyTelegram обидва не кидають, тож запис клієнта від Telegram не залежить.
  await notifyTelegram(env, { pet, pet_name, service, breed, name, phone, date, time, note, isRequest, staff, waitlist, source, id: saved.id || null });
  let tgLink = "";
  try {
    tgLink = await tgDeepLink(env, saved.tg_code);                       // "" until the bot is connected in the CRM
    if (saved.id && !isRequest) await tgNotifyClient(env, saved.id, "created"); // only if this client already linked Telegram
  } catch (e) { }
  let first = false, linked = false, loyalty = null, bot = "";
  try {
    const st = await loadSettings(env);
    bot = st.tg_bot || "";
    if (st.loyalty_enabled === "1") loyalty = { every: Math.max(2, parseInt(st.loyalty_every, 10) || 6), reward: st.loyalty_reward || "" };
    if (saved.client_id) {   // first visit = this booking is the only one on the card
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE client_id=? AND service<>'Блокування'`).bind(saved.client_id).first();
      const c = await env.DB.prepare(`SELECT tg_chat_id FROM clients WHERE id=?`).bind(saved.client_id).first();
      first = !!(n && n.n <= 1);
      linked = !!(c && c.tg_chat_id);   // already in Telegram → reminders and bonuses are already on
    }
  } catch (e) { }
  return { ok: true, request: isRequest, staff, waitlist, id: saved.id || null, tg_link: tgLink, first, linked, loyalty, bot };
}

/* ----------------------------- Calendar events ----------------------------- */
function calEventBody(b, dur) {
  const { y, m, d } = parseDate(b.date);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(b.time || "");
  const startMin = (+tm[1]) * 60 + (+tm[2]);
  const duration = dur || SERVICE_DURATIONS[b.service] || DEFAULT_DURATION;
  const src = { site: "сайт", phone: "телефон", instagram: "Instagram", manual: "вручну", other: "вручну" }[b.source] || b.source || "—";
  const price = (b.price != null && b.price !== "") ? `\nСума: ${b.price} ₴` : "";
  const petLine = [b.breed, b.weight].filter(Boolean).join(", ") || "—";
  return {
    summary: `${b.pet || "🐾"}${b.pet_name ? " " + b.pet_name : ""} · ${b.service || "грумінг"} — ${b.name || ""}${b.staff ? " · " + b.staff : ""}`,
    description: `Тварина: ${b.pet || "—"}\nПорода/вага: ${petLine}\nПослуга: ${b.service || "—"}\nМайстер: ${b.staff || "—"}\nТелефон: ${b.phone || "—"}${price}\nКоментар: ${b.note || "—"}\n\n(джерело: ${src})`,
    start: { dateTime: wallToRFC(y, m, d, startMin, BUSINESS.tz), timeZone: BUSINESS.tz },
    end: { dateTime: wallToRFC(y, m, d, startMin + duration, BUSINESS.tz), timeZone: BUSINESS.tz },
    extendedProperties: { private: { staff: b.staff || "" } },
  };
}
const calUrl = (env, id) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events` +
  (id ? "/" + encodeURIComponent(id) : "");
async function calCreate(env, token, b) {
  const dur = await visitMinutes(env, b);
  const res = await fetch(calUrl(env), { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(calEventBody(b, dur)) });
  const ev = await res.json();
  if (!ev.id) throw new Error("event insert failed: " + JSON.stringify(ev));
  return ev;
}
async function calPatch(env, token, id, b) {
  const dur = await visitMinutes(env, b);
  const res = await fetch(calUrl(env, id), { method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(calEventBody(b, dur)) });
  const ev = await res.json();
  if (!ev.id) throw new Error("event patch failed: " + JSON.stringify(ev));
  return ev;
}
async function calDelete(env, token, id) {
  await fetch(calUrl(env, id), { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
}

/* ----------------------------- CRM (D1) ----------------------------- */
async function saveBooking(env, b) {
  if (!env.DB) return;
  try {
    await applyPricing(env, b);
    const link = await linkClientPet(env, b);
    const tgCode = randHex(6);   // one-time deep-link code: t.me/<bot>?start=<code> links this client's Telegram
    const r = await env.DB.prepare(
      `INSERT INTO bookings (created_at,pet,service,breed,name,phone,date,time,note,is_request,event_link,status,source,event_id,price,staff,weight,client_id,pet_id,pet_name,tg_code,duration)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      new Date().toISOString(), b.pet || "", b.service || "", b.breed || "",
      b.name || "", b.phone || "", b.date || "", b.time || "", b.note || "",
      b.isRequest ? 1 : 0, b.eventLink || null, b.waitlist ? "waitlist" : "new", b.source || "site", b.eventId || null,
      (b.price != null && b.price !== "") ? b.price : null, b.staff || "", b.weight || "",
      link.client_id, link.pet_id, b.pet_name || "", tgCode, (b.duration > 0 ? b.duration : null)
    ).run();
    return { id: r.meta && r.meta.last_row_id, tg_code: tgCode, client_id: link.client_id || null };
  } catch (e) { /* CRM logging must never break a booking */ }
}

/* ----------------------------- Auth: accounts, roles, sessions ----------------------------- */
function bearer(request) { return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim(); }
// Для console.*: повідомлення і перші рядки стеку, щоб у wrangler tail було видно, де саме впало.
function errText(e) { return String(e && (e.stack || e.message) || e).split("\n").slice(0, 4).join(" | ").slice(0, 600); }
function bufToHex(buf) { return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function hexToBuf(hex) { const a = new Uint8Array((hex || "").length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a.buffer; }
function randHex(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return bufToHex(b.buffer); }
async function pbkdf2(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: hexToBuf(saltHex), iterations: 100000, hash: "SHA-256" }, key, 256);
  return bufToHex(bits);
}
async function sessionUser(env, token) {
  if (!token || !env.DB) return null;
  const s = await env.DB.prepare(`SELECT * FROM sessions WHERE token=?`).bind(token).first();
  if (!s) return null;
  if (s.expires_at && s.expires_at < new Date().toISOString()) { try { await env.DB.prepare(`DELETE FROM sessions WHERE token=?`).bind(token).run(); } catch (e) { } return null; }
  return s;
}
// Owner or admin (CRM staff). ADMIN_TOKEN is the emergency owner login.
/* ADMIN_TOKEN is the emergency owner PASSWORD (authLogin below) and nothing else. It used to be
   accepted as a bearer here too, which made it a key that issues no session, appears in no list
   and cannot be revoked by logging out — only by rotating the secret. */
async function requireAdmin(request, env) {
  const s = await sessionUser(env, bearer(request));
  if (!s) { const e = new Error("unauthorized"); e.status = 401; throw e; }
  if (s.role === "support") return await supportGate(request, env, s);
  if (s.role !== "owner" && s.role !== "admin") { const e = new Error("unauthorized"); e.status = 401; throw e; }
  return s;
}
/* ------------------------------- Підтримка (розробник) -------------------------------
   Розробник після передачі має ІМЕННИЙ акаунт з роллю "support" — у журналі стоїть його
   ім'я, а не «підтримка». Акаунт мертвий доти, доки власниця не відкриє доступ кнопкою в
   CRM; строк зберігається в settings.support_until і перевіряється на КОЖНОМУ запиті, бо
   sessionUser читає базу щоразу і кешу немає. Тому «забрати доступ» діє миттєво, а строк
   сесії (30 діб) тут ні на що не впливає.

   Рішення приймається в ОДНОМУ місці — тут, усередині requireAdmin. Це білий список: усе,
   чого в ньому немає, для підтримки закрите, включно з тим, що допишуть у воркер через рік.
   Гілки owner/admin не змінені жодним символом.

   Чого в списку свідомо немає:
   - записи, клієнти, улюбленці — тридцять з гаком імен і телефонів, і для роботи вони не
     потрібні жодного разу;
   - розсилки клієнтам — надіслане не відкликається;
   - фото улюбленців — посилання /photo/<id>/<token> публічні, кешуються на рік і не
     ротуються: побачене один раз працює вічно;
   - відгуки — adminReviews робить SELECT *, а в таблиці reviews є телефон;
   - master-save — разом з ним зникає ціла купа проблем: access_code (код кабінету майстра,
     по якому /master/data віддає імена й телефони за 120 днів і сесію не питає), tier
     (фактично ціна майстра) і правка графіка наосліп, без списку записів на цей день;
   - service-delete — незворотно, відкату для прайсу немає. */
const SUPPORT_PATHS = {
  "GET /admin/support": 1,
  "GET /admin/health": 1,
  "GET /admin/settings": 1,
  "POST /admin/settings-save": 1,
  "GET /admin/services": 1,
  "GET /admin/masters": 1,          // тільки читання, і без access_code — див. adminMasters
  "POST /admin/site-save": 1,
  "POST /admin/site-image": 1,
};
// Прайс — це гроші, тому окремим прапорцем при видачі, а не назавжди.
const SUPPORT_PATHS_PRICES = { "POST /admin/service-save": 1 };
const SUPPORT_ACT = {
  "POST /admin/settings-save": "змінив налаштування салону",
  "POST /admin/site-save": "змінив тексти або розділи сайту",
  "POST /admin/site-image": "замінив фото на сайті",
  "POST /admin/service-save": "змінив послугу або ціну",
};
async function supportGate(request, env, s) {
  const st = await loadSettings(env);
  const until = st.support_until || "";
  if (!until || until <= new Date().toISOString()) {
    const e = new Error("Доступ для підтримки закритий. Власниця відкриває його кнопкою в CRM."); e.status = 403; throw e;
  }
  const key = request.method + " " + new URL(request.url).pathname;
  if (!(SUPPORT_PATHS[key] || (st.support_prices === "1" && SUPPORT_PATHS_PRICES[key]))) {
    const e = new Error("Підтримка не має права на цю дію"); e.status = 403; throw e;
  }
  // Журнал пишеться ДО дії і без try/catch: доступ підтримки без запису — це те, від чого
  // ми й ідемо. Немає куди писати — немає й дії.
  if (request.method === "POST") {
    const head = SUPPORT_ACT[key] || key;
    let act = head;
    // А от «що саме» — лише прикраса до запису: зламався підрахунок — лишається заголовок,
    // і дія йде далі. Тіло читаємо з копії, оригінал обробник прочитає сам.
    if (SUPPORT_DETAIL[key]) {
      try { act = await SUPPORT_DETAIL[key](env, await request.clone().json(), st, head); } catch (e) { act = head; }
    }
    await supportLog(env, s.name || "підтримка", act);
  }
  return s;
}
async function supportLog(env, who, act) {
  await env.DB.prepare(`INSERT INTO support_log (company_id,at,who,act) VALUES (${env.CID},?,?,?)`)
    .bind(new Date().toISOString(), String(who).slice(0, 60), String(act).slice(0, SUPPORT_ACT_MAX)).run();
}
/* Що саме змінила підтримка: розділ або поле і, де можна, «було → стало». Рахує СЕРВЕР — з тіла
   запиту проти того, що зараз лежить у базі. Опис від клієнта тут не годиться: клієнт і є та
   людина, чию роботу журнал записує. Наступний стан рахує ТОЙ САМИЙ код, яким його запише
   обробник (siteCmsNext і siteCmsRefusal, svcStore, svcNew): копія колись почала б розповідати
   не те, що лежить у базі. Формат один: "<заголовок>: <що>; <що>; …", до 1000 знаків.
   /admin/site-image свідомо не розбираємо: там мегабайти base64, а на Workers Free ~10 мс CPU.
   Новий слот однаково з'являється в наступному site-save — як «замінив фото <слот>».
   Персональних даних ці ручки не несуть; tg_bot, токени фото і id у запис не потрапляють. */
const SUPPORT_ACT_MAX = 1000, SUPPORT_VAL_MAX = 70, SUPPORT_CTX = 20, SUPPORT_CELLS = 5, SUPPORT_TABLE_MAX = 20000;
const SUPPORT_DETAIL = {
  "POST /admin/settings-save": supDetailSettings,
  "POST /admin/site-save": supDetailSite,
  "POST /admin/service-save": supDetailService,
};
// Підписи — ті самі, що бачить власниця у вікні «Нагадування» і на вкладці «Послуги» CRM.
const SUP_SETTING_L = {
  reminders_enabled: "Автоматичні нагадування", repeat_weeks: "Нагадувати про повторний візит через (тижнів)",
  loyalty_enabled: "Програма лояльності", loyalty_every: "Винагорода кожен N-й візит", loyalty_reward: "Опис винагороди",
  client_reminders_enabled: "Нагадування клієнтам", remind_hours_before: "Нагадати за (годин до візиту)",
  note_gift: "Примітка про подарунок", note_big: "Примітка (виводиться після *)",
};
const SUP_SETTING_FLAGS = { reminders_enabled: 1, loyalty_enabled: 1, client_reminders_enabled: 1 };   // воркер читає їх як === "1"
const SUP_SVC_L = { name: "назва", species: "вид", duration: "тривалість, хв", is_request: "заявка (без слоту)",
  bookable: "у формі запису", active: "активна (на сайті)", sort: "порядок", price_type: "тип ціни", price: "ціна",
  unit: "одиниця", note: "опис / примітка" };
const SUP_SPECIES_L = { both: "Всі", dog: "Собаки", cat: "Коти" };
const SUP_PTYPE_L = { flat: "Фіксована", breed: "За породою + вага", addon: "Допи", options: "Список варіантів", table: "Таблиця" };
const SUP_ROLE_L = { "": "—", info: "довідкова", label: "назва / порода", weight: "вага", price: "ціна",
  "price:base": "ціна: базовий рівень", "price:top": "ціна: вищий рівень", duration: "час" };
const supNorm = v => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
// Значення — в один рядок і обрізане. «» і [] — знаки самого журналу: у тексті, який набрала
// підтримка, вони склали б у CRM ще один «запис», якого не було. Тому всередині значень — ‹› і ［］.
function supShort(v, max) {
  const s = supNorm(v).replace(/«/g, "‹").replace(/»/g, "›").replace(/\[/g, "［").replace(/\]/g, "］");
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);   // не розрізати емодзі навпіл
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut) + "…";
}
function supVal(v) { const s = supShort(v, SUPPORT_VAL_MAX); return s ? "«" + s + "»" : "порожньо"; }
// «було» → «стало». Довге значення показуємо з того місця, де воно розходиться: інакше правка після
// 70-го знака дала б «однакове…» → «однакове…», і що саме змінено, не побачив би ніхто.
function supPair(a, z) {
  const A = supNorm(a), Z = supNorm(z);
  let f = 0;
  if (A.length > SUPPORT_VAL_MAX || Z.length > SUPPORT_VAL_MAX) {
    let p = 0; while (p < A.length && p < Z.length && A[p] === Z[p]) p++;
    if (p > SUPPORT_CTX) { f = p - SUPPORT_CTX; if (/[\uDC00-\uDFFF]/.test(A[f])) f--; }
  }
  const v = S => { const s = supShort(S.slice(f), SUPPORT_VAL_MAX - (f ? 1 : 0)); return s ? "«" + (f ? "…" : "") + s + "»" : "порожньо"; };
  return v(A) + " → " + v(Z);
}
function supMany(n, one, few, many) {
  const t = n % 10, h = n % 100;
  return n + " " + (t === 1 && h !== 11 ? one : t >= 2 && t <= 4 && (h < 12 || h > 14) ? few : many);
}
/* Частина запису: { t: "що → як", w: "де" (поле, ключ, клітинка), ws: правка лише в пробілах }.
   t === null — лише місце, без «було → стало» (клітинки таблиці після п'ятої).
   "<заголовок>: <lead><t>; <t>; …" — ніколи не довше за SUPPORT_ACT_MAX. Правки лише в пробілах ідуть
   у кінець. Що не вмістилося повністю, не зникає в «і ще N»: його місце однаково назване. Порядок
   правок задає той, чию роботу записуємо, — без цього десяток дрібних правок попереду сховав би
   одну справжню. */
function supJoin(head, parts, lead) {
  const pre = head + ": " + (lead || "");
  if (!parts.length) return pre + "(без змін)";
  const ps = parts.filter(p => !p.ws).concat(parts.filter(p => p.ws)), n = ps.length;
  if (ps.every(p => p.t != null)) { const all = pre + ps.map(p => p.t).join("; "); if (all.length <= SUPPORT_ACT_MAX) return all; }
  const sufW = new Array(n + 1).fill(0);   // довжина списку місць від i-ї частини до кінця, з ", "
  for (let i = n - 1; i >= 0; i--) sufW[i] = sufW[i + 1] + ps[i].w.length + 2;
  const more = k => "і ще " + supMany(n - k, "зміна", "зміни", "змін") + ": ";
  let k = 0, len = pre.length;
  while (k < n - 1 && ps[k].t != null && len + ps[k].t.length + 2 + more(k + 1).length + sufW[k + 1] - 2 <= SUPPORT_ACT_MAX) { len += ps[k].t.length + 2; k++; }
  let out = pre + ps.slice(0, k).map(p => p.t + "; ").join("") + more(k);
  for (let i = k; i < n; i++) {
    const add = (i > k ? ", " : "") + ps[i].w;
    if (out.length + add.length + (i < n - 1 ? 3 : 0) > SUPPORT_ACT_MAX) return out + (i > k ? ", …" : "…");
    out += add;
  }
  return out;
}
// Тільки ключі зі списку settingsSave, які є в тілі й справді відрізняються від збереженого.
function supDetailSettings(env, b, st, head) {
  if (!b || typeof b !== "object") return head;
  const parts = [];
  for (const k of SETTINGS_SAVE_KEYS) {
    if (b[k] == null) continue;
    const L = SUP_SETTING_L[k] || k, a = st[k] == null ? "" : String(st[k]), z = String(b[k]);
    if (a === z) continue;
    if (SUP_SETTING_FLAGS[k]) {
      const fa = a === "1" ? "увімкнено" : "вимкнено", fz = z === "1" ? "увімкнено" : "вимкнено";
      if (fa !== fz) parts.push({ t: L + ": " + fa + " → " + fz, w: L });
    } else if (supNorm(a) === supNorm(z)) parts.push({ t: L + ": змінено лише пробіли", w: L, ws: true });
    else parts.push({ t: L + ": " + supPair(a, z), w: L });
  }
  return supJoin(head, parts);
}
// Наступний стан рахує siteCmsNext — той самий код, яким його запише siteSave. Ключі сайту
// пишемо в [дужках]: CRM, коли вже прочитала розмітку сайту, показує замість них назви.
async function supDetailSite(env, b, st, head) {
  if (!b || typeof b !== "object") return head;
  const cur = await loadSiteCms(env), next = siteCmsNext(b, cur);
  // Збереження, яке siteSave однаково відхилить, — не «було → стало», а спроба. І рахувати
  // різницю для стану понад 64 КБ немає сенсу: це лише спалило б CPU запиту.
  const why = siteCmsRefusal(next, cur);
  if (why) return head + ": не збережено — " + why;
  const parts = [], own = (o, k) => Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
  const flip = (was, now, what) => {
    const W = new Set(was), N = new Set(now);
    now.forEach(x => { if (!W.has(x)) parts.push({ t: "приховав " + what + " [" + x + "]", w: "[" + x + "]" }); });
    was.forEach(x => { if (!N.has(x)) parts.push({ t: "показав " + what + " [" + x + "]", w: "[" + x + "]" }); });
  };
  flip(cur.hidden, next.hidden, "розділ");
  flip(cur.hiddenText, next.hiddenText, "рядок");
  const union = (a, z) => { const ks = Object.keys(a), seen = new Set(ks); Object.keys(z).forEach(k => { if (!seen.has(k)) ks.push(k); }); return ks; };
  for (const k of union(cur.texts, next.texts)) {
    const a = own(cur.texts, k), z = own(next.texts, k), w = "[" + k + "]";
    if (a === z) continue;
    if (a == null) parts.push({ t: "текст " + w + ": стандартний текст → " + supVal(z), w });
    else if (z == null) parts.push({ t: "текст " + w + ": повернуто стандартний текст (було " + supVal(a) + ")", w });
    else if (supNorm(a) === supNorm(z)) parts.push({ t: "текст " + w + ": змінено лише пробіли", w, ws: true });
    else parts.push({ t: "текст " + w + ": " + supPair(a, z), w });
  }
  for (const k of union(cur.images, next.images)) {
    const a = own(cur.images, k), z = own(next.images, k), w = "фото [" + k + "]";
    if (!a) { parts.push({ t: "замінив фото [" + k + "] (було стандартне)", w }); continue; }
    if (!z) { parts.push({ t: "прибрав фото [" + k + "] — повернуто стандартне", w }); continue; }
    if (a.id !== z.id || a.token !== z.token) parts.push({ t: "замінив фото [" + k + "]", w });
    else if (["pos", "w", "h", "tw", "th"].some(f => (a[f] || "") !== (z[f] || ""))) parts.push({ t: "змінив кадрування фото [" + k + "]", w });
    if ((a.alt || "") !== (z.alt || "")) parts.push({ t: "підпис фото [" + k + "]: " + supPair(a.alt, z.alt), w });
  }
  return supJoin(head, parts);
}
const supYN = v => v ? "так" : "ні";
async function supDetailService(env, b, st, head) {
  if (!b || typeof b !== "object") return head;
  // Запит, який serviceSave відхилить (таблиця не того вигляду), так і записуємо: не збережено.
  const refused = e => { if (e && e.status === 400) return head + ": не збережено — " + e.message; throw e; };
  // Дві послуги з однією назвою — не дрібниця: запис і ціну бере та, що вище в списку (serviceInfo).
  const twin = async (name, id) => !!(await env.DB.prepare(`SELECT 1 AS x FROM services WHERE name=? AND id IS NOT ?`).bind(String(name), id == null ? null : id).first());
  if (!b.id) {
    if (!b.name) return head + ": не збережено — немає назви";
    let s; try { s = migrateBreedService(svcRow(svcZip(svcBind(svcNew(b))))); } catch (e) { return refused(e); }
    const L = SUP_SVC_L, parts = [{ t: "додав послугу " + supVal(s.name) + (await twin(s.name, null) ? " (послуга з такою назвою вже є)" : ""), w: "нова послуга" }];
    const f = (k, v) => parts.push({ t: L[k] + ": " + v, w: L[k] });
    f("species", supVal(SUP_SPECIES_L[s.species] || s.species)); f("duration", supVal(s.duration));
    f("price_type", supVal(SUP_PTYPE_L[s.price_type] || s.price_type));
    if (s.price !== "") f("price", supVal(s.price));
    if (s.unit !== "₴") f("unit", supVal(s.unit));
    f("active", supYN(s.active)); f("bookable", supYN(s.bookable)); f("is_request", supYN(s.is_request)); f("sort", supVal(s.sort));
    if (s.note) f("note", supVal(s.note));
    if (s.rows.length || s.columns.length) parts.push({ t: "таблиця цін: " + supMany(s.rows.length, "рядок", "рядки", "рядків") +
      ", колонки " + supVal(s.columns.map(x => x == null ? "" : String(x)).join(" | ")), w: "таблиця цін" });
    return supJoin(head, parts);
  }
  const row = await env.DB.prepare(`SELECT * FROM services WHERE id=?`).bind(b.id).first();
  if (!row) return head + ": послуга №" + supShort(b.id, 12) + " (не знайдена)";
  const upd = {};
  try { for (const k of SVC_COLS) if (b[k] != null) upd[k] = svcStore(k, b[k]); } catch (e) { return refused(e); }
  // Обидві сторони — як їх прочитає loadServices (svcRow + migrateBreedService), тобто як побачать
  // CRM, сайт і розрахунок ціни. Стара дво-колонкова порода так не дає «змін» без жодної правки,
  // а "0x0" в прапорці — не «без змін», бо svcStore запише саме те, що тут описано.
  const s = migrateBreedService(svcRow(row)), t = migrateBreedService(svcRow(Object.assign({}, row, upd))), parts = [];
  for (const k of SVC_COLS) {
    if (SVC_TABLE[k]) continue;
    const L = SUP_SVC_L[k];
    if (SVC_FLAGS[k]) { if (s[k] !== t[k]) parts.push({ t: L + ": " + supYN(s[k]) + " → " + supYN(t[k]), w: L }); continue; }
    let a = s[k] == null ? "" : String(s[k]), z = t[k] == null ? "" : String(t[k]);
    if (a === z) continue;
    if (k === "species") { a = SUP_SPECIES_L[a] || a; z = SUP_SPECIES_L[z] || z; }
    if (k === "price_type") { a = SUP_PTYPE_L[a] || a; z = SUP_PTYPE_L[z] || z; }
    const ws = supNorm(a) === supNorm(z);
    let txt = L + ": " + (ws ? "змінено лише пробіли" : supPair(a, z));
    if (k === "name" && await twin(t.name, row.id)) txt += " (послуга з такою назвою вже є)";
    parts.push({ t: txt, w: L, ws });
  }
  // Таблиця: перші п'ять правок повністю, решта — лише місцем (клітинкою), але кожна названа.
  const cells = supTableDiff(s, t), ordered = cells.filter(c => !c.ws).concat(cells.filter(c => c.ws));
  ordered.forEach((c, i) => { if (i >= SUPPORT_CELLS) c.t = null; });
  return supJoin(head, parts.concat(ordered), supVal(s.name) + " — ");
}
/* Таблиця цін — по клітинках: «рядок / колонка»: було → стало. s і t — як було і як стане, обидва
   так, як їх читає loadServices. Колонки зіставляємо за назвою (якщо вона унікальна), інакше за
   місцем. Рядки — в чотири проходи:
   1) рядок, у якому нічого не змінилося, — до свого двійника: вставка, видалення і перестановка
      не породжують фальшивих правок;
   2) назва + вага: у породному прайсі одна порода стоїть кількома рядками, по рядку на вагу;
   3) сама назва;  4) те саме місце і хоч одна інша клітинка та сама — рядок, якому змінили назву.
   Решта — «прибрав рядок» і «додав рядок», так воно й було.
   Порядок теж має вагу: без ролей ціну код бере з ОСТАННЬОЇ клітинки, породу — з першої, а з двох
   однакових рядків — перший. Тож перестановка колонок чи рядків — теж запис, хоч цифри ті самі.
   Клітинки поза заголовками (рядок довший за колонки) теж порівнюємо: остання з них — це ціна. */
function supTableDiff(s, t) {
  const str = x => String(x == null ? "" : x), arr = v => Array.isArray(v) ? v : [];
  const ca = arr(s.columns).map(str), cz = arr(t.columns).map(str), qa = arr(s.col_roles).map(str), qz = arr(t.col_roles).map(str);
  const ra = arr(s.rows).map(arr), rz = arr(t.rows).map(arr), out = [];
  const add = (txt, w, ws) => { out.push({ t: txt, w, ws: !!ws }); };
  const count = l => l.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map()), na = count(ca), nz = count(cz), first = new Map();
  ca.forEach((c, i) => { if (!first.has(c)) first.set(c, i); });
  const cmap = cz.map(c => (c && na.get(c) === 1 && nz.get(c) === 1) ? first.get(c) : -1), usedC = new Set(cmap.filter(i => i >= 0));
  cmap.forEach((i, j) => { if (i < 0 && j < ca.length && !usedC.has(j)) { cmap[j] = j; usedC.add(j); } });
  // Ширина: колонки плюс клітинки (і ролі) поза ними — ті зіставляються за місцем від кінця заголовків.
  const beyond = (rows, cols, q) => rows.reduce((m, r) => Math.max(m, r.length), q.length) - cols.length;
  const W = cz.length + Math.max(0, beyond(ra, ca, qa), beyond(rz, cz, qz));
  const jm = j => j < cz.length ? cmap[j] : ca.length + j - cz.length;
  const colName = j => supShort(j < cz.length && cz[j] ? cz[j] : "клітинка " + (j + 1), 30);
  const role = r => SUP_ROLE_L[r] || supVal(r);
  for (let j = 0; j < W; j++) {
    const i = jm(j);
    if (j < cz.length && i < 0) add("додав колонку " + supVal(cz[j]), "колонки");
    else if (j < cz.length && ca[i] !== cz[j]) add("колонка " + (supNorm(ca[i]) === supNorm(cz[j]) ? supVal(cz[j]) + ": змінено лише пробіли" : supPair(ca[i], cz[j])), "колонки", supNorm(ca[i]) === supNorm(cz[j]));
    const ro = i < 0 ? "" : (qa[i] || ""), rn = qz[j] || "";
    if (ro !== rn) add("роль колонки «" + colName(j) + "»: " + role(ro) + " → " + role(rn), "ролі колонок");
  }
  ca.forEach((c, i) => { if (!usedC.has(i)) add("прибрав колонку " + supVal(c), "колонки"); });
  const kept = cmap.filter(i => i >= 0);
  if (kept.some((i, k) => k && i < kept[k - 1])) add("змінив порядок колонок: " + supVal(ca.join(" | ")) + " → " + supVal(cz.join(" | ")), "порядок колонок");
  if (t.price_type === "breed" || t.price_type === "addon") {
    // допи (loadAddonItems) беруть останню клітинку завжди, порода — коли колонок ціни ролі не названо
    const last = (svc, q, cols) => (svc.price_type === "addon" || !priceColumns(q).length) ? cols.length - 1 : -1;
    const pa = last(s, qa, ca), pz = last(t, qz, cz);
    if (pa >= 0 && pz >= 0 && cmap[pz] !== pa) add("ціну тепер бере з колонки " + supVal(cz[pz]) + ", а не " + supVal(ca[pa]), "колонка ціни");
    if (ca.length && cz.length && cmap[0] !== 0) add("породу / назву рядка тепер бере з колонки " + supVal(cz[0]) + ", а не " + supVal(ca[0]), "перша колонка");
  }
  // Таблиця на десятки тисяч клітинок — це не прайс салону, і порівнювати її по клітинках — спалити
  // весь CPU запиту. Пишемо, що вона така, — це вже помітно.
  if ((ra.length + rz.length) * Math.max(W, 1) > SUPPORT_TABLE_MAX) {
    add("таблиця цін: було " + supMany(ra.length, "рядок", "рядки", "рядків") + ", стане " + supMany(rz.length, "рядок", "рядки", "рядків") +
      " — завелика, щоб порівняти по клітинках", "таблиця цін");
    return out;
  }
  const nk = x => supNorm(x).toLowerCase();
  const lA = Math.max(0, roleAt(qa, "label")), lZ = Math.max(0, roleAt(qz, "label"));
  const wA = s.price_type === "breed" ? weightIdx(s) : -1, wZ = t.price_type === "breed" ? weightIdx(t) : -1;
  const oldCell = (o, j) => { const i = jm(j); return i < 0 ? "" : str(o[i]); };
  const sig = get => { const c = []; for (let j = 0; j < W; j++) c.push(get(j)); while (c.length && c[c.length - 1] === "") c.pop(); return JSON.stringify(c); };
  const rmap = rz.map(() => -1), usedR = new Set();
  const pass = (keyA, keyZ) => {   // вільні рядки з однаковим ключем — попарно, по порядку
    const m = new Map();
    ra.forEach((o, i) => { if (!usedR.has(i)) { const k = keyA(o), e = m.get(k); e ? e.q.push(i) : m.set(k, { q: [i], p: 0 }); } });
    rz.forEach((r, j) => { if (rmap[j] < 0) { const e = m.get(keyZ(r)); if (e && e.p < e.q.length) { rmap[j] = e.q[e.p++]; usedR.add(rmap[j]); } } });
  };
  pass(o => sig(j => oldCell(o, j)), r => sig(j => str(r[j])));
  if (wA >= 0 && wZ >= 0) pass(o => nk(o[lA]) + "\u0000" + nk(o[wA]), r => nk(r[lZ]) + "\u0000" + nk(r[wZ]));
  pass(o => nk(o[lA]), r => nk(r[lZ]));
  const kin = (o, r) => cmap.some((i, j) => i >= 0 && j !== lZ && str(o[i]).trim() !== "" && str(o[i]) === str(r[j]));
  rz.forEach((r, j) => { if (rmap[j] < 0 && j < ra.length && !usedR.has(j) && kin(ra[j], r)) { rmap[j] = j; usedR.add(j); } });
  const rowName = (r, li, wi) => supShort([r[li], wi >= 0 ? r[wi] : ""].map(str).filter(x => x.trim()).join(" "), 40);
  const whole = r => r.map(str).filter(x => x.trim()).join(" / ");
  rz.forEach((r, j) => {
    const i = rmap[j];
    if (i < 0) { add("додав рядок " + supVal(whole(r)), "рядок " + supVal(rowName(r, lZ, wZ) || whole(r))); return; }
    const o = ra[i], name = rowName(r, lZ, wZ) || rowName(o, lA, wA) || "рядок " + (j + 1);
    for (let c = 0; c < W; c++) {
      const was = oldCell(o, c), now = str(r[c]);
      if (was === now) continue;
      const where = "«" + name + " / " + colName(c) + "»", ws = supNorm(was) === supNorm(now);
      add(where + ": " + (ws ? "змінено лише пробіли" : supPair(was, now)), where, ws);
    }
  });
  ra.forEach((o, i) => { if (!usedR.has(i)) add("прибрав рядок " + supVal(whole(o)), "рядок " + supVal(rowName(o, lA, wA) || whole(o))); });
  const keptR = rmap.filter(i => i >= 0);
  if (keptR.some((i, k) => k && i < keptR[k - 1])) add("змінив порядок рядків", "порядок рядків");
  return out;
}
async function setSetting(env, key, value) {
  await env.DB.prepare(`INSERT INTO settings (company_id,key,value) VALUES (${env.CID},?,?) ON CONFLICT(company_id,key) DO UPDATE SET value=?`)
    .bind(key, String(value), String(value)).run();
}
async function supportState(env) {
  const st = await loadSettings(env);
  const until = st.support_until || "";
  let log = [];
  try { const { results } = await env.DB.prepare(`SELECT at,who,act FROM support_log ORDER BY id DESC LIMIT 50`).all(); log = results || []; } catch (e) { }
  return { ok: true, open: !!until && until > new Date().toISOString(), until, prices: st.support_prices === "1", log };
}
function fmtKyiv(iso) {
  try { return new Date(iso).toLocaleString("uk-UA", { timeZone: BUSINESS.tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return iso; }
}
async function supportOpen(request, env) {
  await requireOwner(request, env);
  const b = await request.json().catch(() => ({}));
  return await supportOpenDo(env, b && b.hours, !!(b && b.prices));
}
// Одна дія для двох кнопок — у CRM і в боті власниці: строк, журнал і повідомлення не можуть розійтися.
async function supportOpenDo(env, h, prices) {
  const hours = Math.max(1, Math.min(72, Number(h) || 8));
  const until = new Date(Date.now() + hours * 3600e3).toISOString();
  await setSetting(env, "support_until", until);
  await setSetting(env, "support_prices", prices ? "1" : "0");
  await supportLog(env, "власниця", "відкрила доступ до " + fmtKyiv(until) + (prices ? ", з правом правити послуги і ціни" : ""));
  await sendTelegram(env, `🔧 <b>Доступ для підтримки відкрито</b> до ${fmtKyiv(until)}.${prices ? "\nДозволено правити послуги і ціни." : ""}\nЗакрити можна будь-коли кнопкою в CRM або в боті: /menu → 🔧 Підтримка.`).catch(() => { });
  return await supportState(env);
}
async function supportClose(request, env) {
  await requireOwner(request, env);
  return await supportCloseDo(env);
}
async function supportCloseDo(env) {
  await setSetting(env, "support_until", "");
  await setSetting(env, "support_prices", "0");
  // Строк уже перевіряється на кожному запиті, тож це не для відкликання, а щоб наступного
  // разу підтримка заходила паролем, а не старою вкладкою.
  try { await env.DB.prepare(`DELETE FROM sessions WHERE role='support'`).run(); } catch (e) { }
  try { await supportLog(env, "власниця", "закрила доступ"); } catch (e) { }
  await sendTelegram(env, "🔒 <b>Доступ для підтримки закрито.</b>").catch(() => { });
  return await supportState(env);
}
/* ------------------------------- Бриф ------------------------------------------------
   Публічна ручка без пароля: анкету заповнює власниця, у якої акаунта ще може не бути.
   Через це — три запобіжники, бо інакше це безкоштовний спамер у чужий телеграм:
   пастка для ботів (приховане поле, яке людина не заповнює), жорсткі обмеження довжини,
   і пауза між надсиланнями, яка живе в settings. Ключ brief_at у списку settingsSave
   відсутній, тож ніхто зсередини CRM його не зрушить. */
const BRIEF_GAP_SEC = 40;
const BRIEF_MAX_FIELD = 700;
const BRIEF_MAX_TOTAL = 3600;
async function briefSubmit(request, env) {
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") return { ok: false, error: "Порожня анкета" };
  // Пастка: справжня людина цього поля не бачить і не заповнює. Ботам відповідаємо «добре»,
  // щоб вони не шукали обхід, але нікуди нічого не шлемо.
  if (String(b.site || "").trim()) return { ok: true };

  const items = Array.isArray(b.items) ? b.items.slice(0, 40) : [];
  const clean = v => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, BRIEF_MAX_FIELD);
  const rows = items
    .map(it => ({ q: clean(it && it.q), a: clean(it && it.a) }))
    .filter(it => it.q && it.a);
  if (!rows.length) return { ok: false, error: "Анкета порожня — заповніть хоча б одне поле" };

  const who = clean(b.who) || "власниця салону";
  const contact = clean(b.contact);
  const kind = clean(b.kind) || "бриф";

  const st = await loadSettings(env);
  const last = Date.parse(st.brief_at || "") || 0;
  if (Date.now() - last < BRIEF_GAP_SEC * 1000) {
    return { ok: false, error: "Зачекайте хвилину — попередня анкета ще надсилається" };
  }

  // Позначку ставимо ДО надсилання: інакше кожна невдала спроба не рахувалась би, і бот
  // міг би молотити в Telegram API без обмежень.
  try { await setSetting(env, "brief_at", new Date().toISOString()); } catch (e) { }

  let text = `📝 <b>${tgEsc(kind)}</b>\nВід: ${tgEsc(who)}${contact ? " · " + tgEsc(contact) : ""}\n`;
  for (const r of rows) {
    const line = `\n<b>${tgEsc(r.q)}</b>\n${tgEsc(r.a)}\n`;
    if (text.length + line.length > BRIEF_MAX_TOTAL) { text += "\n… далі обрізано\n"; break; }
    text += line;
  }

  // Окремий чат розробника. Якщо він не заданий — анкета йде в чат салону: краще так,
  // ніж мовчки нікуди.
  const chat = env.BRIEF_CHAT_ID || env.TELEGRAM_CHAT_ID;
  if (!chat) return { ok: false, error: "Надсилання не налаштоване — напишіть нам у месенджер" };
  const sent = await tgSendTo(env, chat, text);
  if (!sent || sent.ok === false) return { ok: false, error: "Не вдалося надіслати. Спробуйте ще раз або напишіть у месенджер" };

  return { ok: true };
}

/* ------------------------------- Випуски (оновлення коду) -------------------------------
   Роль support НЕ вміє викочувати код і не навчиться: якби сесія, якій ми свідомо не дали
   телефонів клієнтів, могла замінити код, що ці телефони віддає, білий список скасовувався б
   одним запитом. Тому викочує GitHub Actions, а власниця тримає три речі, які роль дати не може:
   ДОЗВІЛ (кнопка в чаті салону), ЗАПИС (таблиця releases) і ВІДКАТ (кнопка «повернути як було»).

   Напрямок довіри односторонній: GitHub стукає сюди, воркер у GitHub — ніколи. Тому тут немає
   і не буде токена GitHub чи Cloudflare: воркер уміє лише відповісти «дозволено» або «ні».

   Канал — телеграм, а не CRM. По-перше, власниця вже тисне ✅/❌ на бронях у тому самому чаті.
   По-друге, кнопка в CRM жила б у admin.html — тобто у файлі, який оновлення і замінює: рівно
   тоді, коли треба відкотитись, кнопки б не було. */
const REL_ASK_MIN = 60;     // скільки живе запит без відповіді
const REL_BACK_MIN = 45;    // скільки світиться кнопка «повернути як було», якщо release.yml не сказав інакше
/* ↩️ лише ставить прапорець, а відкочує job watch у GitHub. Тож кнопка чесна, тільки доки той
   job живий: після вікна, після скасованого прогону чи коли вікно вимкнено (BACK_MIN=0) натиск
   переводив випуск у 'rollback', якого вже ніхто не виконає, а /release/last після цього брав за
   «попередній» не той код. Тому watch, опитуючи /release/state, лишає тут пульс «n|час», і ↩️
   приймається лише при свіжому пульсі саме цього випуску. Ключа rel_watch у списку settingsSave
   немає: з CRM його не зрушити. */
const REL_PULSE_SEC = 90;
function requireDeploy(request, env) {
  // Секрет заводить людина руками у ДВОХ місцях — у GitHub і у воркері, — і у Windows на
  // кінці легко приїжджає невидимий перенос рядка. bearer() вхідне значення вже підрізає, тож підрізаємо і збережене — інакше два
  // однакові на вигляд рядки не збігаються, і причину видно тільки посимвольно.
  const want = String(env.DEPLOY_TOKEN || "").trim();
  if (!want || bearer(request) !== want) {
    const e = new Error("Доступ лише для викочування"); e.status = 401; throw e;
  }
  return true;
}
// Опис від розробника йде в HTML-повідомлення, тому екранується наявною tgEsc (нижче у файлі):
// одна кутова дужка в тексті інакше зламала б усе повідомлення разом із кнопками.
const relRow = (env, nn) => env.DB.prepare(`SELECT * FROM releases WHERE n=? ORDER BY id DESC LIMIT 1`).bind(nn).first();
async function releaseAsk(request, env) {
  requireDeploy(request, env);
  const b = await request.json();
  const nn = +b.n, note = String(b.note || "").trim();
  if (!nn || note.length < 10) return { ok: false, error: "потрібні n і note (мін. 10 символів)" };
  const now = new Date().toISOString();
  await env.DB.prepare(`DELETE FROM releases WHERE n=?`).bind(nn).run();
  await env.DB.prepare(
    `INSERT INTO releases (company_id,n,sha,prev_sha,note,who,run_url,had_migration,state,at) VALUES (${env.CID},?,?,?,?,?,?,?,?,?)`
  ).bind(nn, String(b.sha || ""), String(b.prev_sha || ""), note, String(b.who || ""), String(b.run_url || ""), b.had_migration ? 1 : 0, b.auto ? "ok" : "pending", now).run();
  if (b.auto) return { ok: true, n: nn, state: "ok" };
  await tgSendTo(env, env.TELEGRAM_CHAT_ID,
    `🔔 <b>Оновлення №${nn}</b>\n${tgEsc(b.who || "Підтримка")} просить дозволу випустити.\n\n<b>Що зміниться:</b> ${tgEsc(note)}\n` +
    (b.had_migration ? "\n⚠️ У цьому оновленні змінюється сама база.\n" : "") +
    `\nЯкщо зараз незручно — тисніть «Не зараз», нічого не поїде.`,
    kb([[{ text: "✅ Випустити", callback_data: `rel:ok:${nn}` }, { text: "🕘 Не зараз", callback_data: `rel:no:${nn}` }]]));
  return { ok: true, n: nn, state: "pending" };
}
async function releaseState(request, url, env) {
  requireDeploy(request, env);
  const nn = +url.searchParams.get("n");
  const r = await relRow(env, nn);
  if (!r) return { ok: false, error: "not found" };
  // Мовчання означає «ні». Автосхвалення через N хвилин перетворило б дозвіл на таймер.
  if (r.state === "pending" && new Date(r.at).getTime() + REL_ASK_MIN * 60e3 < Date.now()) {
    await env.DB.prepare(`UPDATE releases SET state='expired' WHERE id=?`).bind(r.id).run();
    await tgSendTo(env, env.TELEGRAM_CHAT_ID, `🕘 Запит на оновлення №${nn} згас — нічого не поїхало.`);
    return { ok: true, state: "expired" };
  }
  if (r.state === "live") await setSetting(env, "rel_watch", nn + "|" + new Date().toISOString());
  return { ok: true, state: r.state, prev_sha: r.prev_sha || "", decided_by: r.decided_by || "" };
}
async function releaseLast(request, env) {
  requireDeploy(request, env);
  const r = await env.DB.prepare(`SELECT n,sha,prev_sha,state,build FROM releases WHERE state IN ('live','rolled_back') ORDER BY id DESC LIMIT 1`).first();
  if (!r) return { ok: true, last: null };
  // Після відкату на стенді працює prev_sha цього випуску, а не його sha. Інакше наступний випуск
  // брав за «попередній» саме відкинутий код: і «що змінилось» рахувалось від нього, і ↩️ повертав його.
  if (r.state === "rolled_back") return { ok: true, last: { n: r.n, sha: r.prev_sha || "", build: "", rolled_back: true } };
  return { ok: true, last: { n: r.n, sha: r.sha, build: r.build } };
}
async function releaseDone(request, env) {
  requireDeploy(request, env);
  const b = await request.json();
  const nn = +b.n, r = await relRow(env, nn);
  if (!r) return { ok: false, error: "not found" };
  if (b.rolled_back) {
    await env.DB.prepare(`UPDATE releases SET state='rolled_back' WHERE id=?`).bind(r.id).run();
    await tgSendTo(env, env.TELEGRAM_CHAT_ID, `↩️ <b>Повернули як було.</b>\nЯкщо CRM відкрита — перезавантажте сторінку (Ctrl+Shift+R).`);
    return { ok: true, state: "rolled_back" };
  }
  if (!b.ok) {
    await env.DB.prepare(`UPDATE releases SET state='failed' WHERE id=?`).bind(r.id).run();
    await tgSendTo(env, env.TELEGRAM_CHAT_ID, `⚠️ Оновлення №${nn} не встановилось — усе лишилось як було.\n${tgEsc(b.problem || "")}`);
    return { ok: true, state: "failed" };
  }
  await env.DB.prepare(`UPDATE releases SET state='live', build=? WHERE id=?`).bind(String(b.build || ""), r.id).run();
  // Довжину вікна каже release.yml (змінна репозиторію BACK_MIN); 0 — вікна немає, і кнопки теж.
  const backMin = b.back_min == null || b.back_min === "" ? REL_BACK_MIN : Math.max(0, Math.min(50, Math.floor(+b.back_min) || 0));
  const back = !!r.prev_sha && backMin > 0;
  // Пульс одразу, а не з першим опитуванням watch: job стартує на кілька секунд пізніше за це повідомлення.
  if (back) await setSetting(env, "rel_watch", nn + "|" + new Date().toISOString());
  await tgSendTo(env, env.TELEGRAM_CHAT_ID,
    `✅ <b>Оновлення №${nn} встановлено.</b>\n${tgEsc(r.note)}\n` +
    (r.had_migration ? `\n⚠️ У цьому оновленні змінювалась сама база. Кнопка поверне програму, але записи й клієнтів, що зʼявилися після цієї хвилини, це не чіпає.\n` : "") +
    (back ? `\nЯкщо щось поводиться не так — натисніть, і повернемо як було. Кнопка діє ${backMin} хвилин.` :
      r.prev_sha ? `\nКнопки «Повернути як було» цього разу немає: вікно відкату вимкнено.` : ""),
    back ? kb([[{ text: "↩️ Повернути як було", callback_data: `rel:back:${nn}` }]]) : undefined);
  return { ok: true, state: "live" };
}
async function releaseList(env) {
  try {
    const { results } = await env.DB.prepare(`SELECT n,note,who,state,at,decided_by,decided_at,had_migration FROM releases ORDER BY id DESC LIMIT 30`).all();
    return { ok: true, releases: results || [] };
  } catch (e) { return { ok: true, releases: [] }; }
}
/* Кнопки випуску в чаті салону. Повертає true, якщо це була саме така кнопка. */
async function releaseButton(env, cq, chat) {
  const m = /^rel:(ok|no|back):(\d+)$/.exec(cq.data || "");
  if (!m) return false;
  const ans = (text) => tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id, text });
  // Кнопки випуску живуть тільки в чаті салону. У приватному чаті клієнта їм робити нічого.
  if (String(chat) !== String(env.TELEGRAM_CHAT_ID || "")) { await ans("Ця кнопка не для цього чату"); return true; }
  // Перевіряємо людину, а не лише чат: у групі кнопку натиснув би будь-хто з учасників. Для
  // особистого чату from.id збігається з chat id, для групи (від'ємний id) ніколи не збіжиться.
  if (!cq.from || String(cq.from.id) !== String(env.TELEGRAM_CHAT_ID || "")) { await ans("Кнопка працює лише в особистому чаті власниці з ботом"); return true; }
  const nn = +m[2], r = await relRow(env, nn);
  if (!r) { await ans("Оновлення не знайдено"); return true; }
  const who = [cq.from && cq.from.first_name, cq.from && cq.from.last_name].filter(Boolean).join(" ") || (cq.from && cq.from.username) || "у чаті салону";
  const clear = () => tgApi(env, "editMessageReplyMarkup", { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
  const now = new Date().toISOString();
  if (m[1] === "back") {
    if (r.state !== "live") { await ans("Це оновлення вже не можна повернути"); await clear(); return true; }
    const pulse = String((await loadSettings(env)).rel_watch || "").split("|");
    if (+pulse[0] !== nn || !(Date.now() - Date.parse(pulse[1] || "") < REL_PULSE_SEC * 1e3)) {
      await ans("Час для повернення минув — кнопка вже не діє"); await clear(); return true;
    }
    // Кнопка сама нічого не викочує — вона лише ставить прапорець. Викочує GitHub, який усі
    // ці хвилини чекає й дивиться сюди. Воркер не має і не матиме доступу до Cloudflare.
    await env.DB.prepare(`UPDATE releases SET state='rollback', decided_by=?, decided_at=? WHERE id=?`).bind(who, now, r.id).run();
    await clear();
    await ans("Повертаємо…");
    await tgSendTo(env, env.TELEGRAM_CHAT_ID, `↩️ <b>Повертаємо оновлення №${nn}.</b> Програма — приблизно за хвилину.`);
    return true;
  }
  if (r.state !== "pending") { await ans("Цей запит уже не активний"); await clear(); return true; }
  const st = m[1] === "ok" ? "ok" : "no";
  await env.DB.prepare(`UPDATE releases SET state=?, decided_by=?, decided_at=? WHERE id=?`).bind(st, who, now, r.id).run();
  await clear();
  await ans(st === "ok" ? "Дякую, встановлюємо…" : "Гаразд, не зараз");
  if (st === "no") await tgSendTo(env, env.TELEGRAM_CHAT_ID, `🕘 Оновлення №${nn} відкладено — нічого не поїхало.`);
  return true;
}
async function requireOwner(request, env) {
  const s = await requireAdmin(request, env);
  if (s.role !== "owner") { const e = new Error("Доступ лише для власника"); e.status = 403; throw e; }
  return s;
}
async function authLogin(body, env) {
  const username = String(body && body.username || "").trim().toLowerCase();
  const password = String(body && body.password || "");
  if (env.ADMIN_TOKEN && password === env.ADMIN_TOKEN) return issueSession(env, { id: 0, role: "owner", name: "Власник", username: "owner", must_change: 0 }, 2 * 36e5);
  if (!username || !password) { const e = new Error("Вкажіть логін і пароль"); e.status = 400; throw e; }
  const u = await env.DB.prepare(`SELECT * FROM users WHERE lower(username)=? AND active=1`).bind(username).first();
  if (!u || !u.pass_hash) { const e = new Error("Невірний логін або пароль"); e.status = 401; throw e; }
  const hash = await pbkdf2(password, u.pass_salt || "");
  if (hash !== u.pass_hash) { const e = new Error("Невірний логін або пароль"); e.status = 401; throw e; }
  return issueSession(env, u);
}
// Аварійний вхід по ADMIN_TOKEN видає сесію на 2 години: зміна токена не вбиває вже видані сесії,
// тож довга сесія з тимчасовим паролем пережила б передачу.
async function issueSession(env, u, ttlMs) {
  const token = randHex(24);
  const now = new Date();
  const name = u.name || u.username || "";
  const exp = new Date(now.getTime() + (ttlMs || 30 * 864e5)).toISOString();
  await env.DB.prepare(`INSERT INTO sessions (token,user_id,role,master_id,name,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(token, u.id || 0, u.role, u.master_id || null, name, now.toISOString(), exp).run();
  return { ok: true, token, role: u.role, name, username: u.username || "", must_change: u.must_change ? 1 : 0 };
}
async function authMe(request, env) {
  const s = await sessionUser(env, bearer(request));
  if (!s) { const e = new Error("unauthorized"); e.status = 401; throw e; }
  let mc = 0; if (s.user_id) { const u = await env.DB.prepare(`SELECT must_change,username FROM users WHERE id=?`).bind(s.user_id).first(); mc = u && u.must_change ? 1 : 0; }
  return { ok: true, role: s.role, name: s.name, master_id: s.master_id, must_change: mc };
}
async function authLogout(request, env) {
  const tok = bearer(request);
  try { await env.DB.prepare(`DELETE FROM sessions WHERE token=?`).bind(tok).run(); } catch (e) { }
  return { ok: true };
}
async function authChangePassword(request, env) {
  const tok = bearer(request);
  const s = await sessionUser(env, tok);
  if (!s || !s.user_id) { const e = new Error("Змінити пароль може лише користувач з акаунтом"); e.status = 403; throw e; }
  const b = await request.json();
  const oldp = String(b && b.old_password || ""), newp = String(b && b.new_password || "");
  if (newp.length < 4) return { ok: false, error: "Новий пароль закороткий (мін. 4 символи)" };
  const u = await env.DB.prepare(`SELECT * FROM users WHERE id=?`).bind(s.user_id).first();
  if (!u) { const e = new Error("Акаунт не знайдено"); e.status = 404; throw e; }
  // On a forced first change (must_change) the old password isn't asked for; verify it only for a voluntary change.
  if (u.pass_hash && !u.must_change) { const h = await pbkdf2(oldp, u.pass_salt || ""); if (h !== u.pass_hash) return { ok: false, error: "Невірний поточний пароль" }; }
  const salt = randHex(16), hash = await pbkdf2(newp, salt);
  await env.DB.prepare(`UPDATE users SET pass_hash=?, pass_salt=?, must_change=0 WHERE id=?`).bind(hash, salt, u.id).run();
  /* Решта сесій цього акаунта — геть, лишається тільки та, з якої міняли. Примусова зміна існує,
     щоб тимчасовий пароль з листа чи з «Доступи» перестав пускати; але хто встиг увійти з ним
     раніше, сидів би далі 30 днів, ще й з must_change=0 — замок у вікні його вже не спіймав би.
     Так само, як reset-confirm. Аварійні сесії (user_id=0) сюди не доходять. */
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND token<>?`).bind(u.id, tok).run();
  return { ok: true };
}
/* ---- «Забули пароль?» на екрані входу ----
   Сама собі пароль відновлює лише ВЛАСНИЦЯ: одноразовий код надсилає бот салону в її особистий
   чат (TELEGRAM_CHAT_ID), і код + новий пароль замінюють старий. Співробітникам (адміністратор,
   майстер, підтримка) самообслуговування немає: їм скидає власниця в «Доступи» → 🔑 (тимчасовий
   пароль, must_change=1, сесії вбито), а свій вони задають одразу після входу. Пошти в CRM немає,
   тож іншого каналу немає й не буде. Бота нема — запасний шлях: аварійний пароль (ADMIN_TOKEN).

   Де лежить код. Нова таблиця = міграція, а міграції накочують руками, і після передачі в
   розробника доступу до D1 немає. Тому код живе в client_otp, де client_id = -users.id:
   ВІД'ЄМНИЙ — акаунт CRM, додатний — клієнт сайту. clientOtp/clientVerify шукають рядки лише за id
   реального клієнта (завжди > 0), тож такого рядка вони не побачать ні як спробу, ні як вхід.
   Не в settings: GET /admin/settings віддає всі рядки, а підтримці його читати можна. */
const RESET_TTL_MIN = 10, RESET_TRIES = 5, RESET_PER_ACC = 3, RESET_PER_DAY = 10, RESET_PER_IP = 10;
// Одна відповідь для співробітника і для невідомого логіна, тож підказка про одруківку — для всіх.
const RESET_STAFF = "Код у Telegram отримує лише власниця салону. Співробітникам пароль скидає власниця: CRM → 👥 Доступи → 🔑 біля вашого логіна. Якщо ви власниця — перевірте, чи правильно введено логін.";
const RESET_BUSY = "Забагато запитів коду. Зачекайте 10 хвилин і спробуйте знову.";
const RESET_DAILY = "За добу вже надіслано забагато кодів — нових найближчим часом не буде. Увійдіть аварійним паролем (ADMIN_TOKEN), як описано нижче.";
// Особистий чат = додатний id. Від'ємний — група, і код прочитав би кожен її учасник (та сама
// причина, з якої releaseButton звіряє from.id).
const resetBotOk = env => !!env.TELEGRAM_BOT_TOKEN && /^\d+$/.test(String(env.TELEGRAM_CHAT_ID || ""));
async function resetOwner(env, body) {   // логін нормалізується так само, як в authLogin
  const username = String(body && body.username || "").trim().toLowerCase();
  if (!username) return null;
  return await env.DB.prepare(`SELECT * FROM users WHERE lower(username)=? AND active=1 AND role='owner'`).bind(username).first();
}
function resetCode() {   // 6 цифр з crypto, не Math.random; хвіст вибірки відкидаємо, щоб % не давав перекосу
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= 4294800000);   // 900000 × 4772
  return String(100000 + a[0] % 900000);
}
async function authResetRequest(body, env, request) {
  if (!String(body && body.username || "").trim()) return { ok: false, error: "Вкажіть логін" };
  // Бота й IP перевіряємо ДО пошуку акаунта: ці відповіді однакові для будь-якого логіна.
  if (!resetBotOk(env)) return { ok: false, no_bot: true, error: "Бот салону не підключений до особистого чату власниці — код надіслати нікуди. Запасний шлях — аварійний пароль (ADMIN_TOKEN)." };
  const ip = (request && request.headers.get("CF-Connecting-IP")) || "";
  const now = Date.now(), nowIso = new Date(now).toISOString(), dayAgo = new Date(now - 864e5).toISOString();
  if (ip) {   // той самий лічильник, що в clientOtp: одна адреса — не більше 10 живих кодів будь-кому
    const byIp = await env.DB.prepare(`SELECT COUNT(*) AS n FROM client_otp WHERE ip=? AND expires_at>?`).bind(ip, nowIso).first();
    if (byIp && byIp.n >= RESET_PER_IP) return { ok: false, error: RESET_BUSY };
  }
  const u = await resetOwner(env, body);
  // Невідомий логін і логін співробітника отримують ОДНУ відповідь: список логінів так не вивудиш.
  if (!u) return { ok: false, staff: true, error: RESET_STAFF };
  const key = -u.id;
  await env.DB.prepare(`DELETE FROM client_otp WHERE client_id<0 AND expires_at<?`).bind(dayAgo).run();   // старі коди CRM, клієнтських не чіпаємо
  const code = resetCode();
  /* Ліміти перевіряє сам INSERT, одним оператором, — паралельні запити не проскочать між
     підрахунком і записом. 3 живі коди на акаунт (як у clientOtp) і 10 на добу: кожен код — це
     5 спроб, і без добової стелі терплячий перебір мав би ~2000 спроб на день.
     Рядок народжується РОЗБРОЄНИМ (attempts = межа), і зброю йому дає лише Telegram, що підтвердив
     доставку. Інакше поки бот надсилає, вгадування вже б порівнювались із живим кодом, а невдала
     відправка стирала б рядок разом зі слідом цих спроб — і жоден ліміт їх не бачив би. Зірвати
     відправку чужій людині нескладно: напр., завалити чат власниці відгуками до 429 від Telegram. */
  const ins = await env.DB.prepare(`INSERT INTO client_otp (client_id,code,expires_at,attempts,ip) SELECT ?,?,?,${RESET_TRIES},?
      WHERE (SELECT COUNT(*) FROM client_otp WHERE client_id=? AND expires_at>?) < ${RESET_PER_ACC}
        AND (SELECT COUNT(*) FROM client_otp WHERE client_id=? AND expires_at>?) < ${RESET_PER_DAY}`)
    .bind(key, code, new Date(now + RESET_TTL_MIN * 6e4).toISOString(), ip, key, nowIso, key, dayAgo).run();
  if (!(ins.meta && ins.meta.changes)) {
    // Добова стеля — окрема відповідь: «зачекайте 10 хвилин» тут була б неправдою, а власниці
    // потрібен запасний шлях (admin.html на daily показує його).
    const day = await env.DB.prepare(`SELECT COUNT(*) AS n FROM client_otp WHERE client_id=? AND expires_at>?`).bind(key, dayAgo).first();
    return day && day.n >= RESET_PER_DAY ? { ok: false, daily: true, error: RESET_DAILY } : { ok: false, error: RESET_BUSY };
  }
  const rowId = ins.meta.last_row_id;
  const r = await tgSendTo(env, env.TELEGRAM_CHAT_ID, `🔐 <b>Скидання пароля CRM</b>\nЛогін: <b>${tgEsc(u.username)}</b>\nКод: <b>${code}</b>\nДіє ${RESET_TTL_MIN} хвилин.\n\nЯкщо це не ви — просто проігноруйте: без коду пароль не зміниться.`);
  if (!r || !r.ok) {   // код, якого ніхто не отримав, не має й лежати; спроб на ньому не було — він був розброєний
    await env.DB.prepare(`DELETE FROM client_otp WHERE id=?`).bind(rowId).run();
    return { ok: false, send_failed: true, error: "Не вдалося надіслати код у Telegram. Спробуйте ще раз або увійдіть аварійним паролем." };
  }
  await env.DB.prepare(`UPDATE client_otp SET attempts=0 WHERE id=?`).bind(rowId).run();   // доставлено — тепер код приймається
  return { ok: true, ttl_min: RESET_TTL_MIN };
}
async function authResetConfirm(body, env) {
  const code = String(body && body.code || "").replace(/\D/g, "");
  const newp = String(body && body.new_password || "");
  if (code.length !== 6) return { ok: false, error: "Код — це 6 цифр із повідомлення бота" };
  if (newp.length < 4) return { ok: false, error: "Новий пароль закороткий (мін. 4 символи)" };   // те саме правило, що в authChangePassword
  const u = await resetOwner(env, body);
  const row = u && await env.DB.prepare(`SELECT id,code FROM client_otp WHERE client_id=? AND expires_at>? ORDER BY id DESC LIMIT 1`).bind(-u.id, new Date().toISOString()).first();
  if (!row) return { ok: false, error: "Код прострочений або не запитаний — надішліть новий" };   // і для чужого логіна так само
  // Спробу списуємо ДО порівняння і одним оператором: інакше пачка паралельних запитів прочитала
  // б attempts=0 разом і перебрала б куди більше п'яти кодів.
  const t = await env.DB.prepare(`UPDATE client_otp SET attempts=attempts+1 WHERE id=? AND attempts<${RESET_TRIES}`).bind(row.id).run();
  if (!(t.meta && t.meta.changes)) return { ok: false, error: "Забагато невірних спроб — надішліть новий код" };
  if (row.code !== code) return { ok: false, error: "Невірний код" };
  const salt = randHex(16), hash = await pbkdf2(newp, salt);
  await env.DB.prepare(`UPDATE users SET pass_hash=?, pass_salt=?, must_change=0 WHERE id=?`).bind(hash, salt, u.id).run();
  // Хто сидів зі старим паролем — більше не в CRM. Решта кодів цього акаунта згоряє.
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(u.id).run();
  await env.DB.prepare(`DELETE FROM client_otp WHERE client_id=?`).bind(-u.id).run();
  if (resetBotOk(env)) await tgSendTo(env, env.TELEGRAM_CHAT_ID, `🔐 Пароль CRM для <b>${tgEsc(u.username)}</b> змінено через «Забули пароль?». Інші входи в цей акаунт завершено.\nЯкщо це були не ви — увійдіть аварійним паролем і скиньте пароль у 👥 Доступи → 🔑.`).catch(() => { });
  return issueSession(env, Object.assign({}, u, { must_change: 0 }));   // як /auth/login: CRM одразу впускає
}
/* ---- User management (owner only) ---- */
async function adminUsers(request, env) {
  await requireOwner(request, env);
  const { results } = await env.DB.prepare(`SELECT id,username,name,role,master_id,active,must_change,created_at FROM users ORDER BY role, username`).all();
  // Чий Telegram підключений до кабінету в боті. Без таблиці (міграцію 0005 ще не накочено) — просто ні в кого.
  const tg = {};
  try { ((await env.DB.prepare(`SELECT user_id, linked_at FROM staff_tg WHERE chat_id IS NOT NULL`).all()).results || []).forEach(r => { tg[r.user_id] = r.linked_at || "1"; }); } catch (e) { }
  return { ok: true, users: (results || []).map(u => Object.assign(u, { tg_linked: tg[u.id] || "" })) };
}
async function userSave(request, env) {
  await requireOwner(request, env);
  const b = await request.json();
  const username = String(b.username || "").trim().toLowerCase();
  if (b.id) {
    const cur = await env.DB.prepare(`SELECT role,active FROM users WHERE id=?`).bind(b.id).first();
    const sets = [], vals = [];
    for (const f of ["name", "role", "master_id", "active"]) if (b[f] != null) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (b.username != null) { sets.push("username=?"); vals.push(username); }
    if (sets.length) { vals.push(b.id); await env.DB.prepare(`UPDATE users SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); }
    if (b.password) { const salt = randHex(16), hash = await pbkdf2(String(b.password), salt); await env.DB.prepare(`UPDATE users SET pass_hash=?, pass_salt=?, must_change=1 WHERE id=?`).bind(hash, salt, b.id).run(); }
    /* Роль і доступ живуть у ЗНІМКУ сесії: sessionUser читає sessions і в users більше не
       заглядає. Тому зняти галочку «активний» або понизити роль було недостатньо — людина
       працювала б у CRM ще до 30 діб, доки не протухне сесія. Тепер зміна ролі, доступу або
       пароля завершує всі її сесії, і наступний крок — вхід заново. */
    const kill = !!b.password || (cur && (
      (b.role != null && String(b.role) !== String(cur.role)) ||
      (b.active != null && (b.active ? 1 : 0) !== (cur.active ? 1 : 0))));
    if (kill) { try { await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(b.id).run(); } catch (e) { } }
    /* Кабінет у боті читає роль і «активний» з users на кожному натисканні, тож доступ і так зник би
       миттєво. Прив'язку все одно знімаємо: інша роль — інший кабінет, і людина має підключити його
       сама, а не прокинутися адміністратором у чаті, який колись підключала як майстер. Пароль — ні:
       Telegram від пароля не залежить. */
    const unlink = cur && ((b.role != null && String(b.role) !== String(cur.role)) ||
      (b.active != null && (b.active ? 1 : 0) !== (cur.active ? 1 : 0)));
    if (unlink) await staffTgUnlink(env, b.id, "Ваш доступ у CRM змінено — кабінет у боті відключено. Підключіть його знову з CRM, якщо він вам потрібен.");
    return { ok: true, id: b.id };
  }
  if (!username) return { ok: false, error: "Вкажіть логін" };
  const dup = await env.DB.prepare(`SELECT id FROM users WHERE lower(username)=?`).bind(username).first();
  if (dup) return { ok: false, error: "Такий логін вже існує" };
  const salt = randHex(16), hash = await pbkdf2(String(b.password || "1234"), salt);
  const r = await env.DB.prepare(`INSERT INTO users (username,name,pass_hash,pass_salt,role,master_id,active,must_change,created_at) VALUES (?,?,?,?,?,?,1,1,?)`)
    .bind(username, b.name || "", hash, salt, b.role || "master", b.master_id || null, new Date().toISOString()).run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
}
async function userDelete(request, env) {
  await requireOwner(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  const gone = await env.DB.prepare(`DELETE FROM users WHERE id=? AND role!='owner'`).bind(id).run();
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run();
  if (gone.meta && gone.meta.changes) await staffTgUnlink(env, id, "Ваш акаунт у CRM видалено — кабінет у боті відключено.");
  return { ok: true };
}

async function adminList(request, env) {
  await requireAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings ORDER BY created_at DESC LIMIT 1000`
  ).all();
  return { ok: true, bookings: results || [] };
}

const EDITABLE = ["pet", "pet_name", "service", "breed", "name", "phone", "date", "time", "note", "status", "source", "price", "staff", "weight", "client_id", "pet_id", "pay_method"];

// Can this master actually take the booking? null = fine, otherwise a human-readable reason.
async function staffScheduleProblem(env, b) {
  const staff = String(b.staff || "").trim(), iso = String(b.date || "");
  if (!staff || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || b.service === "Блокування") return null;
  const mst = (await loadMasters(env)).find(m => m.name === staff);
  if (!mst) return `майстра «${staff}» немає в списку майстрів`;
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const dd = `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
  if (!mst.active) return `${staff} — неактивний майстер`;
  for (const v of mst.vacations) if (v && v.from && v.to && iso >= v.from && iso <= v.to) return `${staff} ${dd} — відпустка`;
  if (mst.daysOff.includes(dow)) return `${staff} ${dd} — вихідний`;
  const t = hmToMin(b.time);
  if (t != null) {
    const dur = await visitMinutes(env, b);
    const hm = x => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
    if (t < mst.startMin || t + dur > mst.endMin) return `${staff} працює ${hm(mst.startMin)}–${hm(mst.endMin)}, запис о ${b.time} (${dur} хв) не вкладається`;
    if (inBreak(mst, t, t + dur)) return `${staff}: ${b.time} припадає на обідню перерву (${hm(mst.breakStart)}–${hm(mst.breakEnd)})`;
  }
  return null;
}

async function adminUpdate(request, env) {
  await requireAdmin(request, env);
  const body = await request.json();
  const id = body && body.id;
  if (!id) return { ok: false, error: "id required" };
  if (body.phone != null) body.phone = stdPhone(body.phone);
  // Schedule guard — only when the assignment itself (master / date / time) is being changed.
  if (body.staff != null || body.date != null || body.time != null) {
    const cur = (await env.DB.prepare(`SELECT staff,date,time,service,status FROM bookings WHERE id=?`).bind(id).first()) || {};
    const pick = f => (body[f] != null ? body[f] : cur[f]);
    if (pick("status") !== "cancelled") {
      const why = await staffScheduleProblem(env, { staff: pick("staff"), date: pick("date"), time: pick("time"), service: pick("service") });
      if (why) return { ok: false, error: "Не можна призначити: " + why };
    }
  }
  const sets = [], vals = [];
  for (const f of EDITABLE) {
    if (body[f] != null) { sets.push(`${f}=?`); vals.push(body[f]); }
  }
  const prev = (await env.DB.prepare(`SELECT ${STAFF_COLS} FROM bookings WHERE id=?`).bind(id).first()) || {};
  const moved = (body.date != null && body.date !== prev.date) || (body.time != null && body.time !== prev.time);
  if (moved) sets.push("remind_day_sent=0", "remind_hour_sent=0"); // rescheduled → remind the client again
  if (sets.length) {
    vals.push(id);
    await env.DB.prepare(`UPDATE bookings SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();
  }
  let calendar = "unchanged";
  try { calendar = await syncCalendar(env, id); }
  catch (e) { calendar = "error: " + String(e && e.message || e); }
  await tellClientChange(env, id, prev, body, moved);
  try { await tellMastersChange(env, prev, await env.DB.prepare(`SELECT ${STAFF_COLS} FROM bookings WHERE id=?`).bind(id).first()); } catch (e) { }
  return { ok: true, calendar };
}
/* Що сказати клієнту, коли салон змінив запис: підтверджено / скасовано / перенесено. Одне правило
   для CRM і для бота персоналу — інакше кнопка в Telegram і кнопка в CRM казали б клієнту різне. */
async function tellClientChange(env, id, prev, body, moved) {
  const newStatus = body.status != null ? body.status : prev.status;
  const newDate = body.date != null ? body.date : prev.date;
  const upcoming = !!newDate && newDate >= isoInTz(new Date(), BUSINESS.tz);   // past or finished visits get no messages
  if (body.status === "confirmed" && prev.status !== "confirmed" && upcoming) await tgNotifyClient(env, id, "confirmed");
  else if (body.status === "cancelled" && ["new", "confirmed"].includes(prev.status) && upcoming) await tgNotifyClient(env, id, "cancelled");
  else if (moved && ["new", "confirmed"].includes(newStatus) && upcoming) await tgNotifyClient(env, id, "moved");
}

async function adminCreate(request, env) {   // phone is standardised inside, like every other write
  await requireAdmin(request, env);
  const b = await request.json();
  if (!b || !b.name || !b.phone) return { ok: false, error: "Вкажіть ім'я і телефон" };
  b.phone = stdPhone(b.phone);
  if ((b.status || "new") !== "cancelled") { const why = await staffScheduleProblem(env, b); if (why) return { ok: false, error: "Не можна призначити: " + why }; }
  await applyPricing(env, b);
  const hasTime = !!(b.date && b.time);
  let eventId = null, eventLink = null;
  if (hasTime && (b.status || "new") !== "cancelled") {
    try {
      if (!calOn(env)) throw new Error("no calendar");
      const token = await getAccessToken(env);
      const ev = await calCreate(env, token, b);
      eventId = ev.id; eventLink = ev.htmlLink;
    } catch (e) { /* keep the record even if calendar fails */ }
  }
  const link = await linkClientPet(env, b);
  const r = await env.DB.prepare(
    `INSERT INTO bookings (created_at,pet,service,breed,name,phone,date,time,note,is_request,event_link,status,source,event_id,price,staff,weight,client_id,pet_id,pet_name,tg_code)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    new Date().toISOString(), b.pet || "", b.service || "", b.breed || "",
    b.name || "", b.phone || "", b.date || "", b.time || "", b.note || "",
    hasTime ? 0 : 1, eventLink, b.status || "new", b.source || "phone", eventId,
    (b.price != null && b.price !== "") ? b.price : null, b.staff || "", b.weight || "",
    link.client_id, link.pet_id, b.pet_name || "", randHex(6)
  ).run();
  const newId = r.meta && r.meta.last_row_id;
  try { if (hasTime && (b.status || "new") !== "cancelled") await tgNotifyClient(env, newId, b.status === "confirmed" ? "confirmed" : "created"); } catch (e) { }
  try { if (hasTime && (b.status || "new") !== "cancelled") await tellMaster(env, "new", await env.DB.prepare(`SELECT ${STAFF_COLS} FROM bookings WHERE id=?`).bind(newId).first()); } catch (e) { }
  return { ok: true, id: newId };
}

/* ----------------------------- Clients & Pets ----------------------------- */
// The one format we store: +380XXXXXXXXX. A string we cannot read as a phone is kept as typed.
function stdPhone(p) {
  const raw = String(p == null ? "" : p).trim();
  if (!raw) return "";
  let d = raw.replace(/\D/g, "");
  if (!d) return raw;
  if (d.length === 9) d = "380" + d;                                  // 671234567
  else if (d.length === 10 && d[0] === "0") d = "380" + d.slice(1);   // 0671234567
  else if (d.length === 11 && d.slice(0, 2) === "80") d = "3" + d;    // 80671234567
  if (d.length < 10 || d.length > 15) return raw;                     // too short / too long to trust
  return "+" + d;
}
function normPhone(p) {   // one canonical key for the same number written in any local style
  let d = (p || "").replace(/\D/g, "");
  if (d.length === 9) d = "380" + d;                                  // 671234567
  else if (d.length === 10 && d[0] === "0") d = "380" + d.slice(1);   // 0671234567
  else if (d.length === 11 && d.slice(0, 2) === "80") d = "3" + d;    // 80671234567
  return d;                                                          // +380…, +48…, +7… stay distinct
}

// Find/create the client (by phone) and pet (by name under client) for a booking.
async function linkClientPet(env, b) {
  if (!env.DB) return { client_id: null, pet_id: null };
  let clientId = null, petId = null;
  const np = normPhone(b.phone);
  if (np.length >= 9) {
    const cs = await env.DB.prepare(`SELECT id, phone FROM clients`).all();
    const found = (cs.results || []).find(c => normPhone(c.phone) === np);
    if (found) clientId = found.id;
    else {
      const r = await env.DB.prepare(
        `INSERT INTO clients (created_at,name,phone,source,status) VALUES (?,?,?,?, 'active')`
      ).bind(new Date().toISOString(), b.name || "", stdPhone(b.phone), b.source || "site").run();
      clientId = r.meta && r.meta.last_row_id;
    }
  }
  const petName = (b.pet_name || "").trim();
  if (clientId && petName) {
    const ps = await env.DB.prepare(`SELECT id, name FROM pets WHERE client_id=?`).bind(clientId).all();
    const pf = (ps.results || []).find(p => (p.name || "").trim().toLowerCase() === petName.toLowerCase());
    if (pf) petId = pf.id;
    else {
      const species = b.pet === "Кіт" ? "cat" : b.pet === "Собака" ? "dog" : "other";
      const r = await env.DB.prepare(
        `INSERT INTO pets (client_id,created_at,name,species,breed,weight) VALUES (?,?,?,?,?,?)`
      ).bind(clientId, new Date().toISOString(), petName, species, b.breed || "", b.weight || "").run();
      petId = r.meta && r.meta.last_row_id;
    }
  }
  return { client_id: clientId, pet_id: petId };
}

async function adminClients(request, env) {
  await requireAdmin(request, env);
  const { results } = await env.DB.prepare(`SELECT * FROM clients ORDER BY name COLLATE NOCASE`).all();
  return { ok: true, clients: results || [] };
}
async function adminPets(request, env) {
  await requireAdmin(request, env);
  const { results } = await env.DB.prepare(`SELECT * FROM pets ORDER BY name COLLATE NOCASE`).all();
  const cnt = {};
  try { ((await env.DB.prepare(`SELECT pet_id, COUNT(*) AS n FROM pet_photos GROUP BY pet_id`).all()).results || []).forEach(r => { cnt[r.pet_id] = r.n; }); } catch (e) { }
  return { ok: true, pets: (results || []).map(p => Object.assign(p, { photos: cnt[p.id] || 0 })) };
}
/* ----------------------------- Client cabinet: phone + Telegram one-time code, own visits / pets / profile ----------------------------- */
async function clientSession(env, token) {
  if (!token || !env.DB) return null;
  const s = await env.DB.prepare(`SELECT * FROM client_sessions WHERE token=?`).bind(token).first();
  if (!s) return null;
  if (s.expires_at && s.expires_at < new Date().toISOString()) { try { await env.DB.prepare(`DELETE FROM client_sessions WHERE token=?`).bind(token).run(); } catch (e) { } return null; }
  return s;
}
async function requireClient(request, env) {
  const s = await clientSession(env, bearer(request));
  const c = s ? await env.DB.prepare(`SELECT * FROM clients WHERE id=?`).bind(s.client_id).first() : null;
  if (!c) { const e = new Error("unauthorized"); e.status = 401; throw e; }
  return c;
}
async function issueClientSession(env, clientId) {
  const token = randHex(24), now = new Date();
  await env.DB.prepare(`INSERT INTO client_sessions (token,client_id,created_at,expires_at) VALUES (?,?,?,?)`)
    .bind(token, clientId, now.toISOString(), new Date(now.getTime() + 90 * 864e5).toISOString()).run();
  return token;
}
async function clientByPhone(env, phone) {   // prefer the row that already has Telegram linked
  const np = normPhone(phone); if (np.length < 9) return null;
  const cs = (await env.DB.prepare(`SELECT id,name,phone,tg_chat_id FROM clients`).all()).results || [];
  return cs.find(c => normPhone(c.phone) === np && c.tg_chat_id) || cs.find(c => normPhone(c.phone) === np) || null;
}
function maskPhone(p) { const d = (p || "").replace(/\D/g, ""); return d.length >= 9 ? `+${d.slice(0, d.length - 9)} ** *** ${d.slice(-4, -2)} ${d.slice(-2)}` : p; }
function siteUrl(env) { return String(env.SITE_URL || env.ALLOW_ORIGIN || "").replace(/\/$/, "") + "/"; }
async function clientOtp(body, env, request) {
  const ip = (request && request.headers.get("CF-Connecting-IP")) || "";
  const nowIso = new Date().toISOString();
  if (ip) {   // one caller may not hammer many numbers
    const byIp = await env.DB.prepare(`SELECT COUNT(*) AS n FROM client_otp WHERE ip=? AND expires_at>?`).bind(ip, nowIso).first();
    if (byIp && byIp.n >= 10) return { ok: false, error: "Забагато запитів коду. Зачекайте 10 хвилин і спробуйте знову." };
  }
  const c = await clientByPhone(env, body && body.phone);
  const bot = (await loadSettings(env)).tg_bot || "";
  // same answer whether the number is unknown or just not linked — no customer-list enumeration
  if (!c || !c.tg_chat_id) return { ok: false, error: "Код надсилаємо лише клієнтам із підключеним Telegram-ботом. Відкрийте бота, натисніть «Поділитися номером» і спробуйте ще раз.", need_link: true, bot };
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM client_otp WHERE client_id=? AND expires_at>?`).bind(c.id, nowIso).first();
  if (recent && recent.n >= 3) return { ok: false, error: "Забагато запитів коду. Зачекайте 10 хвилин і спробуйте знову." };
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await env.DB.prepare(`INSERT INTO client_otp (client_id,code,expires_at,attempts,ip) VALUES (?,?,?,0,?)`).bind(c.id, code, new Date(Date.now() + 10 * 60000).toISOString(), ip).run();
  const r = await tgSendTo(env, c.tg_chat_id, `🔑 Код для входу в кабінет: <b>${code}</b>\nДійсний 10 хвилин. Якщо це не ви — просто проігноруйте це повідомлення.`);
  if (!r || !r.ok) return { ok: false, error: "Не вдалося надіслати код у Telegram. Спробуйте ще раз." };
  return { ok: true, masked: maskPhone(c.phone) };
}
async function clientVerify(body, env) {
  const c = await clientByPhone(env, body && body.phone);
  const code = String((body && body.code) || "").replace(/\D/g, "");
  if (!c || code.length !== 6) return { ok: false, error: "Невірний код" };
  const row = await env.DB.prepare(`SELECT id,code,attempts FROM client_otp WHERE client_id=? AND expires_at>? ORDER BY id DESC LIMIT 1`).bind(c.id, new Date().toISOString()).first();
  if (!row) return { ok: false, error: "Код прострочений — запросіть новий" };
  if (row.attempts >= 5) return { ok: false, error: "Забагато невірних спроб — запросіть новий код" };
  if (row.code !== code) { await env.DB.prepare(`UPDATE client_otp SET attempts=attempts+1 WHERE id=?`).bind(row.id).run(); return { ok: false, error: "Невірний код" }; }
  await env.DB.prepare(`DELETE FROM client_otp WHERE client_id=?`).bind(c.id).run();
  return { ok: true, token: await issueClientSession(env, c.id), name: c.name || "" };
}
async function clientBookings(env, c) {   // own rows by client_id, plus legacy rows matched by phone
  const np = normPhone(c.phone);
  const mine = (await env.DB.prepare(`SELECT id,date,time,service,pet_name,pet,breed,staff,status,price,pay_method,note,is_request,created_at FROM bookings WHERE client_id=? AND service<>'Блокування'`).bind(c.id).all()).results || [];
  let legacy = [];
  if (np) legacy = ((await env.DB.prepare(`SELECT id,date,time,service,pet_name,pet,breed,staff,status,price,pay_method,note,is_request,created_at,phone FROM bookings WHERE client_id IS NULL AND phone<>'' AND service<>'Блокування'`).all()).results || [])
    .filter(b => normPhone(b.phone) === np).map(b => { delete b.phone; return b; });
  return mine.concat(legacy).sort((a, b) => ((b.date || "") + (b.time || "")).localeCompare((a.date || "") + (a.time || "")));
}
async function clientMe(request, url, env) {
  const c = await requireClient(request, env);
  const st = await loadSettings(env);
  const pets = (await env.DB.prepare(`SELECT id,name,species,breed,weight,birthdate,sex,color,allergies,behavior,prefs,client_notes FROM pets WHERE client_id=? ORDER BY id`).bind(c.id).all()).results || [];
  let photos = []; try { photos = (await env.DB.prepare(`SELECT id,pet_id,kind,token,created_at,thumb_key FROM pet_photos WHERE company_id=${env.CID} AND pet_id IN (SELECT id FROM pets WHERE client_id=? AND company_id=${env.CID}) ORDER BY created_at DESC`).bind(c.id).all()).results || []; } catch (e) { }
  pets.forEach(p => { p.photos = photos.filter(x => x.pet_id === p.id).map(x => ({ id: x.id, kind: x.kind, created_at: x.created_at, url: photoUrl(url.origin, x), thumb: photoThumbUrl(url.origin, x) })); });
  const bookings = await clientBookings(env, c);
  const visits = bookings.filter(b => b.status === "done" || b.status === "paid").length;
  const every = Math.max(2, parseInt(st.loyalty_every, 10) || 6), filled = visits % every, bonusNow = filled === every - 1;
  return { ok: true, client: { id: c.id, name: c.name || "", phone: c.phone || "", email: c.email || "", tg_linked: !!c.tg_chat_id }, pets, bookings,
    loyalty: { enabled: st.loyalty_enabled === "1", visits, every, reward: st.loyalty_reward || "", filled, remaining: bonusNow ? 0 : every - 1 - filled, bonusNow },
    bot: st.tg_bot || "", site: siteUrl(env) };
}
async function clientOwnBooking(env, c, id) {
  const n = Number(id); if (!Number.isInteger(n) || n <= 0) return null;
  const b = await env.DB.prepare(`SELECT * FROM bookings WHERE id=?`).bind(n).first();
  if (!b) return null;
  const np = normPhone(c.phone);
  return (b.client_id === c.id || (np && normPhone(b.phone) === np)) ? b : null;
}
async function clientCancel(request, env) {
  const c = await requireClient(request, env);
  const { id } = await request.json();
  const b = await clientOwnBooking(env, c, id);
  if (!b) return { ok: false, error: "Запис не знайдено" };
  if (!["new", "confirmed", "waitlist"].includes(b.status)) return { ok: false, error: "Цей запис уже не можна скасувати" };
  if (b.date && b.date < isoInTz(new Date(), BUSINESS.tz)) return { ok: false, error: "Минулий запис не можна скасувати" };
  await env.DB.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).bind(b.id).run();
  try { await syncCalendar(env, b.id); } catch (e) { }
  try { await alertSalon(env, `❌ <b>Клієнт скасував запис у кабінеті</b>\n${b.date && b.time ? visitText(b) : tgEsc(b.service || "")}\n👤 ${tgEsc(b.name || "")} — ${tgEsc(b.phone || "")}`); } catch (e) { }
  try { await tellMaster(env, "cancelled", b); } catch (e) { }
  return { ok: true };
}
async function clientMove(request, env) {
  const c = await requireClient(request, env);
  const body = await request.json();
  const b = await clientOwnBooking(env, c, body.id);
  if (!b) return { ok: false, error: "Запис не знайдено" };
  if (!["new", "confirmed"].includes(b.status)) return { ok: false, error: "Цей запис уже не можна перенести" };
  if (b.is_request || !b.time) return { ok: false, error: "Заявку без точного часу не можна перенести самостійно — напишіть нам, будь ласка" };
  const date = String(body.date || ""), time = String(body.time || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return { ok: false, error: "Оберіть дату й час" };
  if (date < isoInTz(new Date(), BUSINESS.tz)) return { ok: false, error: "Ця дата вже минула" };
  let staff = null; try { staff = await freeMasterAt(env, { date, time, service: b.service, prefer: b.staff, excludeEventId: b.event_id, excludeId: b.id, breed: b.breed, weight: b.weight }); } catch (e) { staff = null; }
  if (!staff) return { ok: false, error: "На жаль, цей час уже зайнятий. Оберіть інший." };
  await env.DB.prepare(`UPDATE bookings SET date=?, time=?, staff=?, remind_day_sent=0, remind_hour_sent=0 WHERE id=?`).bind(date, time, staff, b.id).run();
  try { await syncCalendar(env, b.id); } catch (e) { }
  const nb = Object.assign({}, b, { date, time, staff });
  try { await alertSalon(env, `🔁 <b>Клієнт переніс запис у кабінеті</b>\nБуло: ${fmtDdMm(b.date)} о ${tgEsc(b.time)}${b.staff ? " (" + tgEsc(b.staff) + ")" : ""}\nСтало: ${visitText(nb)}\n👤 ${tgEsc(b.name || "")} — ${tgEsc(b.phone || "")}`, staffAlertButtons(b.id)); } catch (e) { }
  try { await tellMastersChange(env, b, nb); } catch (e) { }
  try { await tgNotifyClient(env, b.id, "moved"); } catch (e) { }
  return { ok: true, staff };
}
const CLIENT_PET_FIELDS = ["name", "species", "breed", "weight", "birthdate", "sex", "color", "allergies", "behavior", "prefs", "client_notes"];   // vet_notes / warnings / reactions / special are staff-only
// A photo of one's own pet, added from the client cabinet. The caps bound what one registered phone
// number can write into D1 — the per-pet one alone would not, since a client may add pets freely.
const CLIENT_PHOTOS_PER_PET = 30, CLIENT_PHOTOS_TOTAL = 40, CLIENT_PETS_MAX = 20;
async function clientOwnPet(env, c, petId) {
  const id = Number(petId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return await env.DB.prepare(`SELECT id,client_id FROM pets WHERE id=? AND client_id=?`).bind(id, c.id).first();
}
async function clientPhotoUpload(request, env) {
  const c = await requireClient(request, env);
  const b = await request.json();
  const pet = await clientOwnPet(env, c, b && b.pet_id);
  if (!pet) return { ok: false, error: "Улюбленця не знайдено" };
  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pet_photos WHERE pet_id=?`).bind(pet.id).first();
  if (n && n.n >= CLIENT_PHOTOS_PER_PET) return { ok: false, error: "У картці вже 30 фото — видаліть зайві" };
  const t = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pet_photos WHERE company_id=${env.CID} AND pet_id IN (SELECT id FROM pets WHERE client_id=? AND company_id=${env.CID})`).bind(c.id).first();
  if (t && t.n >= CLIENT_PHOTOS_TOTAL) return { ok: false, error: "Досягнуто ліміт фото у кабінеті — видаліть зайві" };
  return await savePetPhoto(env, new URL(request.url).origin, { pet_id: pet.id, kind: b.kind, data: b.data, thumb: b.thumb });
}
async function clientPhotoDelete(request, env) {
  const c = await requireClient(request, env);
  const b = await request.json();
  const id = Number(b && b.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "id required" };
  const p = await env.DB.prepare(`SELECT id,pet_id,booking_id,published,r2_key,thumb_key FROM pet_photos WHERE id=?`).bind(id).first();
  if (!p || !(await clientOwnPet(env, c, p.pet_id))) { const e = new Error("Немає доступу до цього фото"); e.status = 403; throw e; }
  if (p.booking_id) return { ok: false, error: "Це фото з візиту — його зробив салон. Попросіть адміністратора видалити" };
  if (p.published) return { ok: false, error: "Це фото салон показує в галереї сайту — попросіть прибрати його звідти" };
  await env.DB.prepare(`DELETE FROM pet_photos WHERE id=?`).bind(id).run();
  await dropPhotoObjects(env, [p.r2_key, p.thumb_key]);
  return { ok: true };
}
async function clientPetSave(request, env) {
  const c = await requireClient(request, env);
  const b = await request.json();
  const name = String(b.name || "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "Вкажіть кличку" };
  const vals = CLIENT_PET_FIELDS.map(f => f === "name" ? name : f === "species" ? (["dog", "cat", "other"].includes(b.species) ? b.species : "dog") : String(b[f] == null ? "" : b[f]).slice(0, 500));
  if (b.id != null && b.id !== "") {
    if (!Number.isInteger(Number(b.id)) || Number(b.id) <= 0) return { ok: false, error: "Улюбленця не знайдено" };
    const p = await env.DB.prepare(`SELECT id FROM pets WHERE id=? AND client_id=?`).bind(+b.id, c.id).first();
    if (!p) return { ok: false, error: "Улюбленця не знайдено" };
    await env.DB.prepare(`UPDATE pets SET ${CLIENT_PET_FIELDS.map(f => f + "=?").join(",")} WHERE id=?`).bind(...vals, +b.id).run();
    return { ok: true, id: +b.id };
  }
  const np = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pets WHERE client_id=?`).bind(c.id).first();
  if (np && np.n >= CLIENT_PETS_MAX) return { ok: false, error: "Забагато карток улюбленців — зверніться до салону" };
  const r = await env.DB.prepare(`INSERT INTO pets (client_id,created_at,${CLIENT_PET_FIELDS.join(",")}) VALUES (?,?,${CLIENT_PET_FIELDS.map(() => "?").join(",")})`).bind(c.id, new Date().toISOString(), ...vals).run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
}
async function clientProfile(request, env) {
  const c = await requireClient(request, env);
  const b = await request.json();
  const name = String(b.name || "").trim().slice(0, 80), email = String(b.email || "").trim().slice(0, 120);
  if (!name) return { ok: false, error: "Вкажіть ім'я" };
  await env.DB.prepare(`UPDATE clients SET name=?, email=? WHERE id=?`).bind(name, email, c.id).run();
  return { ok: true };
}
async function clientLogout(request, env) {   // «Вийти» revokes every session of this client, incl. links sent by the bot
  try { const s = await clientSession(env, bearer(request)); if (s) await env.DB.prepare(`DELETE FROM client_sessions WHERE client_id=?`).bind(s.client_id).run(); } catch (e) { }
  return { ok: true };
}
async function cabinetLinkButton(env, clientId) {   // one-tap login link for the bot (fresh 90-day session)
  const token = await issueClientSession(env, clientId);
  return kb([[{ text: "🔑 Відкрити кабінет", url: `${siteUrl(env)}cabinet.html#t=${token}` }]]);
}

/* ----------------------------- Pet photos (before / after) — bytes in the R2 bucket, metadata in D1, served by /photo/<id>/<token> ----------------------------- */
const PHOTO_MAX_D1 = 900 * 1024;        // a D1 row has to stay small (fallback when no bucket is bound)
const PHOTO_MAX_R2 = 5 * 1024 * 1024;   // the bucket does not mind; the browser sends ~1600 px plus a small copy
const PHOTO_CACHE = "public, max-age=31536000, immutable";
const PHOTO_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const PHOTO_THUMB_MAX = 400 * 1024;     // a 560 px q72 JPEG is ~25-60 KB
const photoUrl = (origin, p) => `${origin}/photo/${p.id}/${p.token}`;
// The small copy for grids and avatars; a row without one answers with the full photo.
const photoThumbUrl = (origin, p) => p && p.thumb_key ? `${origin}/photo/${p.id}/${p.token}/t` : photoUrl(origin, p);
const photoBucket = env => (env && env.PHOTOS && typeof env.PHOTOS.put === "function") ? env.PHOTOS : null;
const photoKey = (petId, token, mime) => `pets/${petId}/${token}.${PHOTO_EXT[mime] || "jpg"}`;
const thumbKey = (petId, token, mime) => `pets/${petId}/${token}-t.${PHOTO_EXT[mime] || "jpg"}`;
// D1 hands a BLOB back as a plain array of byte values — Response() would send those numbers as text
function blobBytes(raw) {
  return Array.isArray(raw) ? new Uint8Array(raw)
    : (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) ? raw
    : typeof raw === "string" ? Uint8Array.from(raw, c => c.charCodeAt(0)) : raw;
}
// Best effort: a forgotten object costs a fraction of a cent, a delete that throws costs the client their photo.
async function dropPhotoObjects(env, keys) {
  const bucket = photoBucket(env), list = (keys || []).filter(Boolean);
  if (!bucket || !list.length) return;
  try { await bucket.delete(list.length === 1 ? list[0] : list); } catch (e) { }
}
async function photoKeysFor(env, where, ...binds) {   // collect the bucket keys before the rows are gone
  try {
    const rows = (await env.DB.prepare(`SELECT r2_key, thumb_key FROM pet_photos WHERE company_id=${env.CID} AND (${where})`).bind(...binds).all()).results || [];
    return rows.reduce((acc, r) => acc.concat([r.r2_key, r.thumb_key]), []).filter(Boolean);
  }
  catch (e) { return []; }
}
async function savePetPhoto(env, origin, b) {   // shared by the admin pet card and the master's visit card
  const petId = Number(b.pet_id); if (!Number.isInteger(petId) || petId <= 0) return { ok: false, error: "pet_id required" };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ""));
  if (!m) return { ok: false, error: "Очікується зображення JPEG / PNG / WebP" };
  const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  let thumb = null;
  const tm = photoBucket(env) ? /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.thumb || "")) : null;
  // the regex admits base64 that atob rejects — decoding belongs inside the guard
  if (tm) { try { thumb = { mime: tm[1], bin: Uint8Array.from(atob(tm[2]), c => c.charCodeAt(0)) }; } catch (e) { } }
  return await savePetPhotoBytes(env, origin, Object.assign({}, b, { mime: m[1], bin, thumb }));
}
/* Те саме, але з готовими байтами: так фото приходить з Telegram, і гнати його через base64 заради
   спільного коду — це зайві мілісекунди CPU на безкоштовному тарифі. b.thumb = { mime, bin } або null. */
async function savePetPhotoBytes(env, origin, b) {
  const petId = Number(b.pet_id); if (!Number.isInteger(petId) || petId <= 0) return { ok: false, error: "pet_id required" };
  const kind = b.kind === "after" ? "after" : "before";
  const mime = b.mime, bin = b.bin;
  if (!PHOTO_EXT[mime] || !bin || !bin.length) return { ok: false, error: "Очікується зображення JPEG / PNG / WebP" };
  const bucket = photoBucket(env);
  if (bin.length > (bucket ? PHOTO_MAX_R2 : PHOTO_MAX_D1)) {
    return { ok: false, error: bucket ? "Фото завелике (макс. 5 МБ)" : "Фото завелике (макс. 900 КБ після стиснення)" };
  }
  const pet = await env.DB.prepare(`SELECT client_id FROM pets WHERE id=?`).bind(petId).first();
  if (!pet) return { ok: false, error: "Улюбленця не знайдено" };
  const token = randHex(8);
  const key = bucket ? photoKey(petId, token, mime) : null;
  if (bucket) {
    try { await bucket.put(key, bin, { httpMetadata: { contentType: mime, cacheControl: PHOTO_CACHE } }); }
    catch (e) { return { ok: false, error: "Не вдалося зберегти фото, спробуйте ще раз" }; }
  }
  // The small copy is a bonus, never a reason to lose the photo: if it fails, the row simply has none.
  let tKey = null, tSize = null;
  const t = bucket && b.thumb && PHOTO_EXT[b.thumb.mime] ? b.thumb : null;
  if (t) {
    try {
      if (t.bin && t.bin.length && t.bin.length <= PHOTO_THUMB_MAX) {
        const candidate = thumbKey(petId, token, t.mime);
        await bucket.put(candidate, t.bin, { httpMetadata: { contentType: t.mime, cacheControl: PHOTO_CACHE } });
        tKey = candidate; tSize = t.bin.length;
      }
    } catch (e) { }
  }
  try {
    const r = await env.DB.prepare(`INSERT INTO pet_photos (pet_id,client_id,booking_id,kind,mime,data,r2_key,size,thumb_key,thumb_size,token,created_at,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(petId, pet.client_id || null, b.booking_id ? +b.booking_id : null, kind, mime, key ? null : bin.buffer, key, bin.length, tKey, tSize, token, new Date().toISOString(), String(b.note || "").slice(0, 200)).run();
    const id = r.meta && r.meta.last_row_id;
    const row = { id, token, thumb_key: tKey };
    return { ok: true, id, kind, url: photoUrl(origin, row), thumb: photoThumbUrl(origin, row) };
  } catch (e) {                    // no row means nobody can reach the objects — do not leave them behind
    await dropPhotoObjects(env, [key, tKey]);
    throw e;
  }
}
async function photoUpload(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  return await savePetPhoto(env, new URL(request.url).origin, b);
}
async function adminPhotos(request, url, env) {
  await requireAdmin(request, env);
  const petId = +url.searchParams.get("pet_id"); if (!petId) return { ok: false, error: "pet_id required" };
  const { results } = await env.DB.prepare(`SELECT id,pet_id,booking_id,kind,token,created_at,note,published,thumb_key,COALESCE(size,length(data)) AS size FROM pet_photos WHERE pet_id=? ORDER BY created_at DESC, id DESC`).bind(petId).all();
  return { ok: true, photos: (results || []).map(p => ({ id: p.id, booking_id: p.booking_id, kind: p.kind, created_at: p.created_at, note: p.note, size: p.size, published: p.published ? 1 : 0, url: photoUrl(url.origin, p), thumb: photoThumbUrl(url.origin, p) })) };
}
// CRM: mark a photo for the public «До / після» gallery. A pair = «before» + «after» of the same pet on the same day, both published.
async function photoPublish(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  const id = Number(b.id); if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "id required" };
  await env.DB.prepare(`UPDATE pet_photos SET published=? WHERE id=?`).bind(b.published ? 1 : 0, id).run();
  return { ok: true, id, published: b.published ? 1 : 0 };
}
// Public gallery feed, filled from the pet cards: `items` = «До» + «Після» of one day (comparison slider),
// `photos` = every other 🌐 photo as a plain gallery tile. Only pet name / breed / species leave the salon.
async function publicBeforeAfter(url, env) {
  let rows = [];
  try {
    rows = (await env.DB.prepare(`SELECT p.id,p.pet_id,p.kind,p.token,p.created_at,p.thumb_key,t.name AS pet_name,t.species,t.breed
      FROM pet_photos p JOIN pets t ON t.id=p.pet_id AND t.company_id=p.company_id
      WHERE p.company_id=${env.CID} AND COALESCE(p.published,0)=1 ORDER BY p.created_at DESC, p.id DESC`).all()).results || [];
  } catch (e) { return { ok: true, items: [] }; }
  const groups = {}, order = [];
  rows.forEach(r => { const k = r.pet_id + "|" + String(r.created_at || "").slice(0, 10); if (!groups[k]) { groups[k] = {}; order.push(k); } if (!groups[k][r.kind]) groups[k][r.kind] = r; });
  const pairs = order.map(k => groups[k]).filter(g => g.before && g.after);
  const items = pairs.slice(0, 40).map(g => ({
    id: "live" + g.after.id, before: photoUrl(url.origin, g.before), after: photoUrl(url.origin, g.after),
    tb: photoThumbUrl(url.origin, g.before), ta: photoThumbUrl(url.origin, g.after),
    name: g.after.pet_name || "", species: ["cat", "dog"].indexOf(g.after.species) >= 0 ? g.after.species : "other", breed: g.after.breed || "", date: String(g.after.created_at || "").slice(0, 10), w: 1280, h: 1280,
  }));
  const paired = {}; pairs.forEach(g => { paired[g.before.id] = 1; paired[g.after.id] = 1; });
  const photos = rows.filter(r => !paired[r.id]).slice(0, 60).map(r => ({
    id: "ph" + r.id, src: photoUrl(url.origin, r), t: photoThumbUrl(url.origin, r), name: r.pet_name || "",
    species: ["cat", "dog"].indexOf(r.species) >= 0 ? r.species : "other", breed: r.breed || "", kind: r.kind === "before" ? "before" : "portrait",
    date: String(r.created_at || "").slice(0, 10), w: 1280, h: 1280,
  }));
  return { ok: true, items, photos };
}
async function photoDelete(request, env) {
  await requireAdmin(request, env);
  const { id } = await request.json(); if (!Number.isInteger(Number(id)) || Number(id) <= 0) return { ok: false, error: "id required" };
  const keys = await photoKeysFor(env, "id=?", Number(id));
  await env.DB.prepare(`DELETE FROM pet_photos WHERE id=?`).bind(Number(id)).run();
  await dropPhotoObjects(env, keys);
  return { ok: true };
}
// Owner-only, idempotent, batched: move the bytes still sitting in D1 into the bucket. Safe to run repeatedly.
async function photosToR2(request, env) {
  await requireOwner(request, env);
  const bucket = photoBucket(env);
  if (!bucket) return { ok: false, error: "R2 не підключено: немає binding PHOTOS" };
  let body = {}; try { body = await request.json(); } catch (e) { }
  const limit = Math.min(Math.max(Number(body && body.limit) || 25, 1), 100);
  const rows = ((await env.DB.prepare(
    `SELECT id,pet_id,mime,token,data FROM pet_photos WHERE r2_key IS NULL AND data IS NOT NULL ORDER BY id LIMIT ?`
  ).bind(limit).all()).results) || [];
  let moved = 0, bytes = 0; const errors = [];
  for (const r of rows) {
    try {
      const bin = blobBytes(r.data);
      const len = bin && (bin.byteLength != null ? bin.byteLength : bin.length) || 0;
      if (!len) { errors.push({ id: r.id, error: "порожній файл" }); continue; }
      const token = r.token || randHex(8);                 // a row without a token was unreachable anyway
      const key = photoKey(r.pet_id, token, r.mime);
      await bucket.put(key, bin, { httpMetadata: { contentType: r.mime || "image/jpeg", cacheControl: PHOTO_CACHE } });
      const back = await bucket.head(key);                 // the URL is cached «immutable» for a year — check before letting go of D1
      if (!back || back.size !== len) { await dropPhotoObjects(env, [key]); errors.push({ id: r.id, error: "перевірка не зійшлася" }); continue; }
      await env.DB.prepare(`UPDATE pet_photos SET r2_key=?, size=?, token=?, data=NULL WHERE id=?`).bind(key, len, token, r.id).run();
      moved++; bytes += len;
    } catch (e) { errors.push({ id: r.id, error: String((e && e.message) || e) }); }
  }
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pet_photos WHERE r2_key IS NULL AND data IS NOT NULL`).first();
  return { ok: true, moved, bytes, remaining: (left && left.n) || 0, errors };
}
/* ---------- Photos of the SITE (CRM «Сайт» tab): hero, team, interior, hotel ----------
   The bytes live in the same bucket as pet photos, the slot map lives in settings.site_cms.
   Two copies, both bigger than a pet-card thumbnail because these fill whole sections:
   1600 px long side for the lightbox, ~1000 px for the page. There is no D1 fallback on
   purpose — a hero served out of a database row is worse than refusing the upload. */
const SITE_IMG_MAX = 2.5 * 1024 * 1024;
const SITE_IMG_SMALL_MAX = 900 * 1024;
const SITE_IMG_SLOTS = 40;                  // the markup has 14; the cap only stops abuse
const CMS_KEY_RE = /^[\w.-]{1,80}$/;       // one rule for the upload and for the saved map
const siteMediaKey = (token, mime, small) => `site/${token}${small ? "-m" : ""}.${PHOTO_EXT[mime] || "jpg"}`;
const iSize = v => { const n = Math.round(Number(v)); return Number.isInteger(n) && n > 0 && n < 20000 ? n : null; };

// The claimed mime is the uploader's word; the first bytes are not.
function sniffImage(b) {
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "image/png";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}
function dataUrlBytes(s, maxBytes) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ""));
  if (!m) return { error: "Очікується зображення JPEG / PNG / WebP" };
  if (m[2].length * 0.75 > maxBytes + 1024) return { error: "Зображення завелике" };   // judged before decoding
  let bin; try { bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0)); } catch (e) { return { error: "Пошкоджене зображення" }; }
  if (!bin.length || bin.length > maxBytes) return { error: "Зображення завелике" };
  const real = sniffImage(bin);
  if (!real || real !== m[1]) return { error: "Файл не схожий на зображення" };
  return { bin, mime: real };
}
async function siteImageUpload(request, env) {
  await requireAdmin(request, env);
  const bucket = photoBucket(env);
  if (!bucket) return { ok: false, error: "R2 не підключено: немає binding PHOTOS" };
  const b = await request.json().catch(() => null);
  const key = String((b && b.key) || "");
  if (!CMS_KEY_RE.test(key)) return { ok: false, error: "Невідомий слот фото" };
  const big = dataUrlBytes(b && b.data, SITE_IMG_MAX);
  if (big.error) return { ok: false, error: big.error };
  const token = randHex(8);
  const r2big = siteMediaKey(token, big.mime, false);
  // The row goes in FIRST. An object nobody can name is garbage nothing can ever find again;
  // a row whose object is missing is a visible broken frame the owner simply replaces.
  const ins = await env.DB.prepare(
    `INSERT INTO site_media (cms_key,mime,r2_key,size,w,h,token,created_at) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(key, big.mime, r2big, big.bin.length, iSize(b && b.w), iSize(b && b.h), token, new Date().toISOString()).run();
  const id = ins.meta && ins.meta.last_row_id;
  try { await bucket.put(r2big, big.bin, { httpMetadata: { contentType: big.mime, cacheControl: PHOTO_CACHE } }); }
  catch (e) {
    try { await env.DB.prepare(`DELETE FROM site_media WHERE id=?`).bind(id).run(); } catch (e2) { }
    return { ok: false, error: "Не вдалося зберегти фото, спробуйте ще раз" };
  }
  // The page copy is a bonus, never a reason to lose the upload: without it /img/<id>/<token>/t
  // simply answers with the big one.
  const small = dataUrlBytes(b && b.small, SITE_IMG_SMALL_MAX);
  if (!small.error) {
    try {
      const k = siteMediaKey(token, small.mime, true);
      await bucket.put(k, small.bin, { httpMetadata: { contentType: small.mime, cacheControl: PHOTO_CACHE } });
      await env.DB.prepare(`UPDATE site_media SET thumb_key=?,thumb_size=?,tw=?,th=? WHERE id=?`)
        .bind(k, small.bin.length, iSize(b && b.tw), iSize(b && b.th), id).run();
    } catch (e) { }
  }
  const o = new URL(request.url).origin;
  return { ok: true, id, token, mime: big.mime, size: big.bin.length,
    u: `${o}/img/${id}/${token}`, t: `${o}/img/${id}/${token}/t` };
}
async function siteImageServe(url, env, cors) {
  const miss = () => new Response("not found", { status: 404, headers: { ...cors, "Cache-Control": "no-store" } });
  const m = /^\/img\/(\d+)\/([0-9a-f]{16})(?:\/(t))?$/.exec(url.pathname);
  if (!m) return miss();
  // The data column is deliberately not selected: this is the public site's LCP path, not an admin screen.
  const p = await (env.DBRAW || env.DB).prepare(`SELECT mime,token,r2_key,thumb_key,company_id FROM site_media WHERE id=?`).bind(+m[1]).first();
  if (!p || p.token !== m[2]) return miss();
  const bucket = photoBucket(env);
  if (!bucket) return miss();
  const small = m[3] === "t" && p.thumb_key;
  let obj = await bucket.get(small ? p.thumb_key : p.r2_key);
  if (!obj && small) obj = await bucket.get(p.r2_key);        // no page copy left — the big one answers
  if (!obj) return miss();
  const head = { ...cors, "Content-Type": p.mime || "image/jpeg", "Cache-Control": PHOTO_CACHE, "X-Content-Type-Options": "nosniff" };
  if (obj.httpEtag) head.ETag = obj.httpEtag;
  return new Response(obj.body, { headers: head });
}
// A slot that was replaced or cleared is only STAMPED here. Deleting on save would take with it an
// upload that has not been saved yet, or a slot a stale CRM page never knew about; the daily cron
// removes what has been unreferenced for a week, by which time nothing points at it.
async function siteMediaSweepRaw(env) { return env.DBRAW || env.DB; }
async function siteMediaMark(env, images) {
  const keep = Object.keys(images || {}).map(k => Number(images[k] && images[k].id)).filter(n => Number.isInteger(n) && n > 0);
  const inKeep = "(" + (keep.length ? keep.join(",") : "0") + ")";
  try {
    await env.DB.prepare(`UPDATE site_media SET unref_at=NULL WHERE unref_at IS NOT NULL AND id IN ${inKeep}`).run();
    await env.DB.prepare(`UPDATE site_media SET unref_at=? WHERE unref_at IS NULL AND id NOT IN ${inKeep}`).bind(new Date().toISOString()).run();
  } catch (e) { }
}
async function siteMediaSweep(env, days) {
  const DB = await siteMediaSweepRaw(env);        // the janitor runs for every salon at once
  const cut = new Date(Date.now() - (days || 7) * 86400000).toISOString();
  try {
    const rows = ((await DB.prepare(`SELECT id,r2_key,thumb_key FROM site_media WHERE unref_at IS NOT NULL AND unref_at < ?`).bind(cut).all()).results) || [];
    if (!rows.length) return 0;
    const keys = []; rows.forEach(r => { keys.push(r.r2_key, r.thumb_key); });
    await dropPhotoObjects(env, keys);
    await DB.prepare(`DELETE FROM site_media WHERE id IN (${rows.map(r => r.id).join(",")})`).run();
    return rows.length;
  } catch (e) { return 0; }
}
async function photoServe(url, env, cors) {   // public but unguessable (16-hex token), cached for a year
  const miss = () => new Response("not found", { status: 404, headers: { ...cors, "Cache-Control": "no-store" } });
  const m = /^\/photo\/(\d+)\/([0-9a-f]{16})(?:\/(t))?$/.exec(url.pathname);   // …/t = the small copy for grids
  if (!m) return miss();
  const p = await (env.DBRAW || env.DB).prepare(`SELECT mime,data,token,r2_key,thumb_key,company_id FROM pet_photos WHERE id=?`).bind(+m[1]).first();
  if (!p || p.token !== m[2]) return miss();
  const head = Object.assign({ "Content-Type": p.mime || "image/jpeg", "Cache-Control": PHOTO_CACHE, "X-Content-Type-Options": "nosniff" }, cors);
  const small = m[3] === "t" && p.thumb_key;
  if (small || p.r2_key) {
    const bucket = photoBucket(env);
    let obj = bucket ? await bucket.get(small ? p.thumb_key : p.r2_key) : null;
    if (!obj && small && p.r2_key && bucket) obj = await bucket.get(p.r2_key);   // no small copy left — the big one still answers
    if (obj) {
      if (obj.httpEtag) head.ETag = obj.httpEtag;
      return new Response(obj.body, { headers: head });
    }
    // no bucket (deployed without the binding) or no object — fall back to the D1 copy while it still exists
  }
  if (p.data == null) return miss();   // an empty 200 here would be cached for a year
  return new Response(blobBytes(p.data), { headers: head });
}
const CLIENT_FIELDS = ["name", "phone", "email", "messenger", "source", "note", "consent", "status"];
async function clientSave(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  if (b.phone != null) b.phone = stdPhone(b.phone);
  if (b.id) {
    const sets = [], vals = [];
    for (const f of CLIENT_FIELDS) if (b[f] != null) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (sets.length) { vals.push(b.id); await env.DB.prepare(`UPDATE clients SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); }
    return { ok: true, id: b.id };
  }
  const r = await env.DB.prepare(
    `INSERT INTO clients (created_at,name,phone,email,messenger,source,note,consent,status) VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(new Date().toISOString(), b.name || "", b.phone || "", b.email || "", b.messenger || "",
    b.source || "site", b.note || "", b.consent ? 1 : 0, b.status || "active").run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
}
async function clientDelete(request, env) {
  await requireAdmin(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  const petKeys = await photoKeysFor(env, `pet_id IN (SELECT id FROM pets WHERE client_id=? AND company_id=${env.CID})`, id);
  try { await env.DB.prepare(`DELETE FROM pet_photos WHERE company_id=${env.CID} AND pet_id IN (SELECT id FROM pets WHERE client_id=? AND company_id=${env.CID})`).bind(id).run(); } catch (e) { }   // photos live in the pet card
  await dropPhotoObjects(env, petKeys);
  await env.DB.prepare(`DELETE FROM pets WHERE client_id=?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM clients WHERE id=?`).bind(id).run();
  return { ok: true };
}
const PET_FIELDS = ["client_id", "name", "species", "breed", "birthdate", "weight", "sex", "color",
  "allergies", "behavior", "reactions", "prefs", "vet_notes", "warnings", "special"];
async function petSave(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  if (b.id) {
    const sets = [], vals = [];
    for (const f of PET_FIELDS) if (b[f] != null) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (sets.length) { vals.push(b.id); await env.DB.prepare(`UPDATE pets SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); }
    return { ok: true, id: b.id };
  }
  if (!b.client_id) return { ok: false, error: "client_id required" };
  const cols = ["client_id", "created_at"].concat(PET_FIELDS.filter(f => f !== "client_id"));
  const vals = [b.client_id, new Date().toISOString()].concat(
    PET_FIELDS.filter(f => f !== "client_id").map(f => f === "special" ? (b[f] ? 1 : 0) : (b[f] != null ? b[f] : "")));
  const ph = cols.map(() => "?").join(",");
  const r = await env.DB.prepare(`INSERT INTO pets (${cols.join(",")}) VALUES (${ph})`).bind(...vals).run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
}
async function petDelete(request, env) {
  await requireAdmin(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  const petKeys = await photoKeysFor(env, "pet_id=?", id);
  await env.DB.prepare(`DELETE FROM pets WHERE id=?`).bind(id).run();
  try { await env.DB.prepare(`DELETE FROM pet_photos WHERE pet_id=?`).bind(id).run(); } catch (e) { }
  await dropPhotoObjects(env, petKeys);
  return { ok: true };
}

/* ----------------------------- Masters (schedule) ----------------------------- */
async function publicMasters(env) {
  const masters = await loadMasters(env);
  const on = masters.filter(m => m.active);
  const tiers = {};
  on.forEach(m => { if (m.tier) tiers[m.name] = m.tier; });
  // Список имён остаётся массивом строк — его читают форма записи и бот, ломать нельзя.
  // Уровни едут отдельным полем, и его отсутствие для салона без рівнів ничего не меняет.
  return { ok: true, masters: on.map(m => m.name), tiers };
}
async function adminMasters(request, env) {
  const auth = await requireAdmin(request, env);
  const { results } = await env.DB.prepare(`SELECT * FROM masters ORDER BY sort, id`).all();
  let masters = results || [];
  if (auth.role !== "owner") masters = masters.map(m => {
    const c = { ...m }; delete c.salary_type; delete c.salary_value; delete c.salary_base;  // salaries are owner-only
    // Код кабінету — канал до клієнтів в обхід сесій: masterByCode шукає рядок по ньому і в
    // sessions не заглядає, а /master/data потім віддає імена, телефони і клички за 120 днів.
    // Строку він не має і не ротується, тож побачений один раз закривається лише зміною коду.
    if (auth.role === "support") delete c.access_code;
    return c;
  });
  return { ok: true, masters };
}
const MASTER_FIELDS = ["name", "active", "work_start", "work_end", "days_off", "vacations", "sort", "salary_type", "salary_value", "salary_base", "break_start", "break_end", "access_code", "tier"];
const MASTER_FIELDS_ADMIN = MASTER_FIELDS.filter(f => f !== "salary_type" && f !== "salary_value" && f !== "salary_base");
async function masterSave(request, env) {
  const auth = await requireAdmin(request, env);
  const fields = auth.role === "owner" ? MASTER_FIELDS : MASTER_FIELDS_ADMIN; // admin cannot set salaries
  const b = await request.json();
  if (b.id) {
    const sets = [], vals = [];
    for (const f of fields) if (b[f] != null) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (sets.length) { vals.push(b.id); await env.DB.prepare(`UPDATE masters SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); }
    return { ok: true, id: b.id };
  }
  if (!b.name) return { ok: false, error: "name required" };
  const r = await env.DB.prepare(
    `INSERT INTO masters (name,active,work_start,work_end,days_off,vacations,sort,salary_type,salary_value,salary_base,break_start,break_end,access_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(b.name, b.active ? 1 : 0, b.work_start || "10:00", b.work_end || "20:00", b.days_off || "", b.vacations || "", b.sort || 0, b.salary_type || "", (b.salary_value == null || b.salary_value === "") ? null : Number(b.salary_value), (b.salary_base == null || b.salary_base === "") ? null : Number(b.salary_base), b.break_start || "", b.break_end || "", b.access_code || "").run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
}
async function masterDelete(request, env) {
  await requireAdmin(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  await env.DB.prepare(`DELETE FROM masters WHERE id=?`).bind(id).run();
  return { ok: true };
}

/* ----------------------------- Master cabinet (per-master, access-code auth) ----------------------------- */
async function masterByCode(env, code) {
  code = String(code || "").trim();
  if (!code || !env.DB) return null;
  const row = await env.DB.prepare(`SELECT * FROM masters WHERE access_code=? LIMIT 1`).bind(code).first();
  return row || null;
}
// A master is identified by a logged-in session (role=master) OR a legacy access code.
async function masterFromReq(request, env, code) {
  const tok = bearer(request);
  if (tok) { const s = await sessionUser(env, tok); if (s && s.role === "master" && s.master_id) {
    const m = await env.DB.prepare(`SELECT * FROM masters WHERE id=?`).bind(s.master_id).first(); if (m) return m; } }
  return masterByCode(env, code);
}
const MASTER_STATUSES = ["confirmed", "arrived", "in_progress", "done", "paid", "no_show"];
// GET /master/data?code=XXX (or Bearer master session) -> the master's profile + their bookings
async function masterData(request, url, env) {
  const m = await masterFromReq(request, env, url.searchParams.get("code"));
  if (!m) { const e = new Error("Невірний код доступу"); e.status = 401; throw e; }
  const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT id,date,time,name,phone,pet,pet_name,breed,weight,service,price,status,note,source,pay_method,pet_id,
            (SELECT COUNT(*) FROM pet_photos ph WHERE ph.pet_id=bookings.pet_id AND ph.company_id=bookings.company_id) AS photos
       FROM bookings WHERE company_id=${env.CID} AND staff=? AND (date>=? OR date='' OR date IS NULL) ORDER BY date, time`
  ).bind(m.name, since).all();
  return {
    ok: true,
    master: {
      name: m.name, work_start: m.work_start, work_end: m.work_end,
      break_start: m.break_start, break_end: m.break_end, days_off: m.days_off,
      salary_type: m.salary_type || "", salary_value: m.salary_value, salary_base: m.salary_base,
    },
    bookings: results || [],
  };
}
// A photo endpoint a master may use only for a visit that is theirs.
async function masterBooking(env, m, bookingId) {
  const id = Number(bookingId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const b = await env.DB.prepare(`SELECT id,staff,pet_id,client_id,date FROM bookings WHERE id=?`).bind(id).first();
  return (b && b.staff === m.name) ? b : null;
}
async function masterOr401(request, env, code) {
  const m = await masterFromReq(request, env, code);
  if (!m) { const e = new Error("Невірний код доступу"); e.status = 401; throw e; }
  return m;
}
function forbid() { const e = new Error("Немає доступу до цього запису"); e.status = 403; throw e; }
async function masterPhotoUpload(request, env) {
  const body = await request.json();
  const m = await masterOr401(request, env, body && body.code);
  const b = await masterBooking(env, m, body && body.booking_id);
  if (!b) forbid();
  if (!b.pet_id) return { ok: false, error: "У цьому записі ще немає картки улюбленця — попросіть адміністратора її створити" };
  return await savePetPhoto(env, new URL(request.url).origin, { pet_id: b.pet_id, booking_id: b.id, kind: body.kind, data: body.data, thumb: body.thumb, note: body.note });
}
async function masterPhotos(request, url, env) {
  const m = await masterOr401(request, env, url.searchParams.get("code"));
  const b = await masterBooking(env, m, url.searchParams.get("booking_id"));
  if (!b) forbid();
  if (!b.pet_id) return { ok: true, photos: [] };
  const rows = (await env.DB.prepare(`SELECT id,kind,token,created_at,booking_id,thumb_key FROM pet_photos WHERE pet_id=? ORDER BY created_at DESC, id DESC LIMIT 30`).bind(b.pet_id).all()).results || [];
  const origin = new URL(request.url).origin;
  return { ok: true, photos: rows.map(r => ({ id: r.id, kind: r.kind, created_at: r.created_at, url: photoUrl(origin, r), thumb: photoThumbUrl(origin, r), mine: r.booking_id === b.id })) };
}
async function masterPhotoDelete(request, env) {
  const body = await request.json();
  const m = await masterOr401(request, env, body && body.code);
  const id = Number(body && body.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "id required" };
  const p = await env.DB.prepare(`SELECT id,booking_id,published,r2_key,thumb_key FROM pet_photos WHERE id=?`).bind(id).first();
  if (!p || !p.booking_id) forbid();                       // only a photo taken on one of this master's visits
  if (p.published) return { ok: false, error: "Фото вже в галереї сайту — попросіть адміністратора спершу прибрати його звідти" };
  if (!(await masterBooking(env, m, p.booking_id))) forbid();
  await env.DB.prepare(`DELETE FROM pet_photos WHERE id=?`).bind(id).run();
  await dropPhotoObjects(env, [p.r2_key, p.thumb_key]);
  return { ok: true };
}
// POST /master/status {code,id,status} -> update status of one of the master's own bookings
async function masterStatus(request, body, env) {
  const m = await masterFromReq(request, env, body && body.code);
  if (!m) { const e = new Error("Невірний код доступу"); e.status = 401; throw e; }
  const id = body && body.id, status = body && body.status;
  if (!id || MASTER_STATUSES.indexOf(status) < 0) return { ok: false, error: "bad request" };
  const row = await env.DB.prepare(`SELECT id, staff FROM bookings WHERE id=?`).bind(id).first();
  if (!row || row.staff !== m.name) { const e = new Error("Немає доступу до цього запису"); e.status = 403; throw e; }
  await env.DB.prepare(`UPDATE bookings SET status=? WHERE id=?`).bind(status, id).run();
  let calendar = "unchanged";
  try { calendar = await syncCalendar(env, id); } catch (e) { calendar = "error"; }
  return { ok: true, calendar };
}

/* ----------------------------- Reviews & loyalty ----------------------------- */
// public: a client submits a review (hidden until the salon approves it)
async function reviewCreate(b, env) {
  if (b && b.phone != null) b.phone = stdPhone(b.phone);
  const rating = Math.max(1, Math.min(5, parseInt(b && b.rating, 10) || 0));
  const text = String(b && b.text || "").trim().slice(0, 1500);
  const name = String(b && b.name || "").trim().slice(0, 80);
  if (!rating) return { ok: false, error: "Оцініть від 1 до 5 зірок" };
  let clientId = null;
  const np = normPhone(b && b.phone);
  if (np && env.DB) {
    try { const cs = await env.DB.prepare(`SELECT id, phone FROM clients`).all();
      const f = (cs.results || []).find(c => normPhone(c.phone) === np); if (f) clientId = f.id; } catch (e) { }
  }
  await env.DB.prepare(
    `INSERT INTO reviews (created_at,name,phone,rating,text,master,client_id,published) VALUES (?,?,?,?,?,?,?,0)`   /* phone standardised by the caller */
  ).bind(new Date().toISOString(), name, String(b && b.phone || "").trim(), rating, text, String(b && b.master || "").trim(), clientId).run();
  try { await alertSalon(env, `🌟 Новий відгук (${rating}/5)${name ? " від " + tgEsc(name) : ""}\n${text ? tgEsc(text) : "(без тексту)"}\nПідтвердьте показ у CRM → Відгуки.`); } catch (e) { }
  return { ok: true };
}
// public: approved reviews for the site
async function publicReviews(env) {
  if (!env.DB) return { ok: true, reviews: [], avg: 0, count: 0 };
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, name, rating, text, master, reply FROM reviews WHERE published=1 ORDER BY created_at DESC LIMIT 100`
  ).all();
  const rows = results || [];
  const all = await env.DB.prepare(`SELECT AVG(rating) a, COUNT(*) c FROM reviews WHERE published=1`).first();
  return { ok: true, reviews: rows, avg: all && all.a ? Math.round(all.a * 10) / 10 : 0, count: all && all.c || 0 };
}
async function adminReviews(request, env) {
  await requireAdmin(request, env);
  const { results } = await env.DB.prepare(`SELECT * FROM reviews ORDER BY created_at DESC LIMIT 500`).all();
  return { ok: true, reviews: results || [] };
}
async function reviewSave(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  if (!b || !b.id) return { ok: false, error: "id required" };
  const sets = [], vals = [];
  for (const f of ["published", "reply", "name", "rating", "text", "master"]) if (b[f] != null) { sets.push(`${f}=?`); vals.push(b[f]); }
  if (sets.length) { vals.push(b.id); await env.DB.prepare(`UPDATE reviews SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); }
  return { ok: true };
}
async function reviewDelete(request, env) {
  await requireAdmin(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  await env.DB.prepare(`DELETE FROM reviews WHERE id=?`).bind(id).run();
  return { ok: true };
}

/* ----------------------------- Services (booking + price = one entity) ----------------------------- */
// One service = a bookable item AND its price list. price_type:
//   flat   → single `price` (may be "" / "від 1000")
//   breed  → rows [[breed, price], …] (dog grooming); form matches breed → price
//   options→ rows [[label, price], …] (sub-services / tariffs); form shows a sub-select
//   table  → rows [[label, col1, col2, …]] with `columns` headers (weight / hotel); form shows a range
function jparse(s, dflt) { try { const v = JSON.parse(s || ""); return v == null ? dflt : v; } catch (e) { return dflt; } }
function svcRow(r) {
  return {
    id: r.id, name: r.name, species: r.species || "both", duration: r.duration || 0,
    is_request: r.is_request ? 1 : 0, bookable: r.bookable == null ? 1 : (r.bookable ? 1 : 0),
    active: r.active == null ? 1 : (r.active ? 1 : 0), sort: r.sort || 0,
    price_type: r.price_type || "flat", price: (r.price == null ? "" : String(r.price)), unit: r.unit || "₴",
    note: r.note || "", columns: jparse(r.columns, []), rows: jparse(r.rows, []),
    col_roles: jparse(r.col_roles, []),
  };
}
// Split a legacy breed label into [breed, weight]: "Пудель 4–7 кг" → ["Пудель","4–7 кг"].
function splitBreedWeight(label) {
  const s = String(label == null ? "" : label).trim();
  const m = s.match(/^(.*?)\s+(від\s+\d+\s+до\s+\d+\s*кг|до\s+\d+\s*кг|від\s+\d+\s*кг|\d+\s*[–-]\s*\d+\s*кг)$/i);
  if (m && m[1]) return [m[1].trim(), m[2].replace(/\s+/g, " ").trim()];
  return [s, ""];
}
// Breed services are stored as [Порода, Ціна] (legacy) or [Порода, Вага, Ціна].
// Normalize on read to 3 columns so breed & weight are separate dimensions.
function migrateBreedService(s) {
  if (svcRoles(s).length) return s;            // роли сказали, что где — угадывать не надо
  if (s.price_type !== "breed") return s;
  if ((s.columns || []).length >= 3) return s;
  s.columns = ["Порода", "Вага", "Ціна, ₴"];
  s.rows = (s.rows || []).map(r => { const bw = splitBreedWeight(r[0]); return [bw[0], bw[1], (r[1] != null ? r[1] : "")]; });
  return s;
}
const svcDefaults = () => DEFAULT_SERVICES.map((s, i) => ({ id: null, sort: i, ...s }));
const SVC_COLS = ["name", "species", "duration", "is_request", "bookable", "active", "sort", "price_type", "price", "unit", "note", "columns", "rows", "col_roles"];
function svcBind(s) {
  return [s.name || "", s.species || "both", +s.duration || 0, s.is_request ? 1 : 0,
    s.bookable == null ? 1 : (s.bookable ? 1 : 0), s.active == null ? 1 : (s.active ? 1 : 0), +s.sort || 0,
    s.price_type || "flat", (s.price == null ? "" : String(s.price)), s.unit || "₴", s.note || "",
    JSON.stringify(s.columns || []), JSON.stringify(s.rows || []), JSON.stringify(s.col_roles || [])];
}
async function seedServices(env) {
  const d = svcDefaults();
  for (const s of d) {
    await env.DB.prepare(`INSERT INTO services (${SVC_COLS.join(",")}) VALUES (${SVC_COLS.map(() => "?").join(",")})`).bind(...svcBind(s)).run();
  }
}
async function loadServices(env) {
  if (!env.DB) return [];
  try {
    let r = await env.DB.prepare(`SELECT * FROM services ORDER BY sort, id`).all();
    // Deliberately no seeding here. /catalog is public, so one crawler hit used to WRITE the
    // GAV&LOVE price list into a new salon's table as its own. A new salon fills its price list in
    // the CRM; seedServices below is kept for the deployment script and is called from nowhere yet.
    return (r.results || []).map(row => migrateBreedService(svcRow(row)));
  } catch (e) { const err = new Error("Не вдалося прочитати перелік послуг"); err.status = 503; throw err; }
}
async function serviceInfo(env, name) { return (await loadServices(env)).find(s => s.name === name) || null; }
/* Сколько минут занимает конкретный визит. У сохранённой записи это записанный факт,
   у ещё не сохранённой — расчёт по породе. Календарное событие и проверка расписания мастера
   обязаны согласоваться с сеткой слотов, иначе день разъедется. */
async function visitMinutes(env, b) {
  if (b && b.duration > 0) return b.duration;
  return await bookingDuration(env, { service: (b && b.service) || "", breed: (b && b.breed) || "", weight: (b && b.weight) || "" });
}
/* Сколько времени займёт этот визит. Порода важнее услуги: у бивера 1 г 45 хв, у чихуахуа
   1 г 30 хв, и на этой разнице строится день салона, где мастер один. Откат всегда в сторону
   длительности услуги, то есть большего значения: ошибка должна стоить пустого слота,
   а не двух собак в одном кресле. Считает сервер — параметра «сколько минут» у клиента нет. */
async function bookingDuration(env, { service, breed, weight }) {
  const s = await serviceInfo(env, service);
  if (s && breed && roleAt(svcRoles(s), "duration") >= 0) {
    const mins = rowDuration(s, pickRowOf(s, breed, weight));
    if (mins) return mins;
  }
  return (s && s.duration) ? s.duration : (SERVICE_DURATIONS[service] || DEFAULT_DURATION);
}
async function serviceIsRequest(env, name) { const s = await serviceInfo(env, name); return s ? !!s.is_request : REQUEST_SERVICES.has(name); }
const numOf = v => { const m = /\d+/.exec(String(v == null ? "" : v)); return m ? +m[0] : null; };
const normBreed = x => String(x || "").toLowerCase().replace(/[’'ʼ`]/g, "'").replace(/\s+/g, " ").trim();
// Match a breed to a price row: exact (normalized), else substring either way.
/* ---------- Роли колонок прайса ------------------------------------------------------------
   Прайс — это таблица, и до сих пор код угадывал смысл её колонок по месту: цена в последней
   ячейке, вес во второй. Второму салону это не подходит: у него в строке две цены (обычный
   грумер и топ-грумер, разница от 0 до 500 ₴ и непропорциональная) и своё время на каждую
   породу. Роли называют смысл вслух, по одной на колонку:

     label · weight · price · price:<ключ уровня> · duration · info

   Пустые роли означают «как было», и это ветка всех услуг, которые существуют сегодня. */
const ROLE_PRICE = /^price(?::([a-z0-9_]{1,16}))?$/i;
const svcRoles = s => (Array.isArray(s && s.col_roles) ? s.col_roles.map(x => String(x == null ? "" : x)) : []);
const roleAt = (roles, role) => roles.findIndex(r => r.toLowerCase() === role);
function priceColumns(roles) {
  const out = [];
  roles.forEach((r, i) => { const m = ROLE_PRICE.exec(r || ""); if (m) out.push({ key: (m[1] || "").toLowerCase(), idx: i }); });
  return out;
}
const cellNum = v => { const m = /\d[\d\s]*/.exec(String(v == null ? "" : v).replace(/\u00a0/g, " ")); return m ? +m[0].replace(/\s/g, "") : null; };

// Цена строки для мастера уровня tierKey.
function rowPriceFor(s, row, tierKey) {
  if (!row) return null;
  const cols = priceColumns(svcRoles(s));
  if (!cols.length) return rowPrice(row);                    // ролей нет — последняя ячейка, как сегодня
  if (cols.length === 1) return row[cols[0].idx];
  const hit = tierKey && cols.find(c => c.key === String(tierKey).toLowerCase());
  if (hit) return row[hit.idx];
  // Уровень неизвестен или настроен неверно — берём самую дешёвую ячейку. Ошибка настройки
  // не должна приходить клиенту счётом побольше.
  const nums = cols.map(c => cellNum(row[c.idx])).filter(v => v != null);
  return nums.length ? String(Math.min(...nums)) : null;
}

/* "1 г 45 хв" → 105, "45 хв" → 45, "2 г" → 120, "90" → 90.
   "1 год+" не число, а обещание — такие строки откатываются на длительность услуги.
   Границы слова здесь не годятся: \b работает по латинице, а у нас кириллица. */
function parseDurMin(v) {
  const t = String(v == null ? "" : v).toLowerCase().trim();
  if (!t || t.includes("+")) return null;
  if (/^\d+$/.test(t)) return +t;
  const h = /(\d+)\s*г/.exec(t), m = /(\d+)\s*хв/.exec(t);
  if (!h && !m) return null;
  const total = (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
  return total > 0 ? total : null;
}

// Длительность строки прайса, если она там объявлена.
function rowDuration(s, row) {
  const i = roleAt(svcRoles(s), "duration");
  return (i < 0 || !row) ? null : parseDurMin(row[i]);
}

// Ключ ценового уровня мастера по его имени.
function tierOfStaff(masters, staff) {
  if (!staff) return null;
  const m = (masters || []).find(x => x.name === staff);
  return (m && m.tier) ? String(m.tier).toLowerCase() : null;
}

function matchBreedRow(rows, breed) {
  const b = normBreed(breed); if (!b) return null;
  let row = (rows || []).find(r => normBreed(r[0]) === b);
  if (row) return row;
  return (rows || []).find(r => { const l = normBreed(r[0]); return l && (b.includes(l) || l.includes(b)); }) || null;
}
const normW = x => String(x || "").toLowerCase().replace(/\s+/g, " ").replace(/грн|кг/g, "").trim();
// Pick the price row for a breed (+optional weight). Rows are [breed, weight, price].
// Индекс колонки веса: по ролям, иначе исторические r[1].
const weightIdx = s => { const i = roleAt(svcRoles(s), "weight"); return i < 0 ? (svcRoles(s).length ? -1 : 1) : i; };
function pickRowOf(s, breed, weight) { return pickBreedRow(s.rows, breed, weight, weightIdx(s)); }
function pickBreedRow(rows, breed, weight, widx) {
  if (widx == null) widx = 1;
  const b = normBreed(breed); if (!b) return null;
  const all = rows || [];
  let bm = all.filter(r => normBreed(r[0]) === b);   // exact label wins ("Вичісування" must not resolve to "Мейн-кун (вичісування)")
  if (!bm.length) bm = all.filter(r => { const l = normBreed(r[0]); return l && (b.includes(l) || l.includes(b)); })
    .sort((x, y) => Math.abs(normBreed(x[0]).length - b.length) - Math.abs(normBreed(y[0]).length - b.length)); // closest label first
  if (!bm.length) return null;
  if (bm.length === 1) return bm[0];
  if (widx < 0) return bm[0];                                // колонки веса нет — первая подходящая
  const w = normW(weight);
  return (w && bm.find(r => normW(r[widx]) === w)) || bm.find(r => !String(r[widx] || "").trim()) || null;
}
const rowPrice = r => (r ? r[r.length - 1] : null);
// Auto-price a booking from its service (only when unambiguous & numeric).
async function priceForBooking(env, b) {
  const s = await serviceInfo(env, b.service); if (!s) return null;
  if (s.price_type === "breed" && b.breed) {
    const tier = tierOfStaff(await loadMasters(env), b.staff);
    const p = rowPriceFor(s, pickRowOf(s, b.breed, b.weight), tier);
    if (p != null && /^\d+$/.test(String(p).trim())) return +p;
  }
  if (s.price_type === "flat" && /^\d+$/.test(String(s.price).trim())) return +s.price;
  return null;
}
// Add-ons: price_type "addon" services hold extra procedures [label, price/modifier].
function parseAddon(price) {
  const s = String(price == null ? "" : price).trim();
  if (/%/.test(s)) { const n = numOf(s); return n != null ? { type: "pct", val: n } : { type: "manual" }; }
  if (/^\+?\s*\d+$/.test(s)) return { type: "abs", val: +s.replace(/[^\d]/g, "") };
  return { type: "manual" };
}
// Add-on rows may carry a "Для кого" middle column: собаки → dog, коти → cat, empty → both.
function addonRowSpecies(r) { if (!r || r.length < 3) return ""; const t = String(r[1] || "").toLowerCase(); return /соб|dog/.test(t) ? "dog" : /кіт|кот|cat/.test(t) ? "cat" : ""; }
function petSpeciesOf(pet) { const p = String(pet || "").toLowerCase(); return /кіт|кот|cat/.test(p) ? "cat" : /соб|dog/.test(p) ? "dog" : ""; }
// Add-ons offered for a species: the addon service's own species and each row's "Для кого" tag both apply.
async function loadAddonItems(env, species) {
  const items = {};
  (await loadServices(env)).forEach(s => {
    if (s.price_type !== "addon" || !s.active) return;
    if (species && s.species && s.species !== "both" && s.species !== species) return;
    (s.rows || []).forEach(r => { const rs = addonRowSpecies(r); if (r[0] && (!species || !rs || rs === species)) items[r[0]] = r[r.length - 1]; });
  });
  return items;
}
async function computeAddons(env, addons, base, pet) {
  if (!Array.isArray(addons) || !addons.length) return { addTotal: 0, hasManual: false, names: [] };
  const items = await loadAddonItems(env, petSpeciesOf(pet));   // an add-on that doesn't fit the pet is ignored
  let add = 0, manual = false; const names = [];
  addons.forEach(nm => {
    if (!(nm in items)) return; names.push(nm);
    const p = parseAddon(items[nm]);
    if (p.type === "abs") add += p.val;
    else if (p.type === "pct") { if (base != null) add += Math.round(base * p.val / 100); else manual = true; }
    else manual = true;
  });
  return { addTotal: add, hasManual: manual, names };
}
// Fill price (base + add-ons) when empty and record chosen add-ons in the note.
async function applyPricing(env, b) {
  const base = await priceForBooking(env, b);
  const ad = await computeAddons(env, b.addons, base, b.pet);
  if ((b.price == null || b.price === "") && base != null) b.price = base + ad.addTotal;
  if (ad.names.length) b.note = (b.note ? b.note + " · " : "") + "Допи: " + ad.names.join(", ") + (ad.hasManual ? " (уточнити)" : "");
}
// Public: the full service+price list for the site (form + «Ціни»), single fetch.
async function publicCatalog(env) {
  const services = (await loadServices(env)).filter(s => s.active);
  const st = await loadSettings(env);
  return { ok: true, services, notes: { gift: st.note_gift || "", big: st.note_big || "" } };
}
async function adminServices(request, env) { await requireAdmin(request, env); return { ok: true, services: await loadServices(env) }; }
/* Що serviceSave записує в колонку — і, слово в слово, що журнал підтримки каже, ніби записано.
   Раніше значення йшло в D1 як прийшло, а вирішувала спорідненість колонок SQLite: "0x0" чи " 0"
   лишалися ТЕКСТОМ у колонці INTEGER, svcRow читав їх як «так», і прихована послуга виходила на
   сайт. col_roles ішов сирим масивом, якого D1 не приймає: збереження послуги з ролями колонок
   закінчувалося 500. Таблиця — лише масив (рядки — масиви) простих значень: рядок-об'єкт
   {"0":…,"length":3} код прочитав би як рядок прайсу, а порівняти його не зміг би ніхто. */
const SVC_FLAGS = { is_request: 1, bookable: 1, active: 1 }, SVC_TABLE = { columns: 1, rows: 1, col_roles: 1 };
function svcOn(v) { if (typeof v !== "string") return !!v; const t = v.trim(); return t !== "" && !(isFinite(+t) && +t === 0); }
function svcBad(msg) { const e = new Error(msg); e.status = 400; return e; }
function svcTable(f, v) {
  const a = typeof v === "string" ? jparse(v, null) : v, plain = x => x == null || typeof x !== "object";
  if (!Array.isArray(a) || !a.every(f === "rows" ? r => Array.isArray(r) && r.every(plain) : plain)) throw svcBad("Таблиця цін має неправильний формат");
  return a;
}
function svcStore(f, v) {
  if (SVC_TABLE[f]) return JSON.stringify(svcTable(f, v));
  if (typeof v === "object") throw svcBad("bad request");                  // null сюди не доходить
  if (SVC_FLAGS[f]) return svcOn(v) ? 1 : 0;
  if (f === "duration" || f === "sort") { const n = +v; return Number.isFinite(n) ? n : 0; }
  return String(v);
}
// Нова послуга такою, як її вставить serviceSave (далі — svcBind): таблиці перевірені і вже масиви.
function svcNew(b) {
  const t = Object.assign({}, b);
  for (const f of Object.keys(SVC_TABLE)) if (b[f] != null) t[f] = svcTable(f, b[f]);
  return t;
}
const svcZip = vals => Object.fromEntries(SVC_COLS.map((f, i) => [f, vals[i]]));
async function serviceSave(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  if (b.id) {
    const sets = [], vals = [];
    for (const f of SVC_COLS) {
      if (b[f] == null) continue;
      sets.push(`${f}=?`);
      vals.push(svcStore(f, b[f]));
    }
    if (sets.length) { vals.push(b.id); await env.DB.prepare(`UPDATE services SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); }
    return { ok: true, id: b.id };
  }
  if (!b.name) return { ok: false, error: "name required" };
  const r = await env.DB.prepare(`INSERT INTO services (${SVC_COLS.join(",")}) VALUES (${SVC_COLS.map(() => "?").join(",")})`).bind(...svcBind(svcNew(b))).run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
}
async function serviceDelete(request, env) {
  await requireAdmin(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  await env.DB.prepare(`DELETE FROM services WHERE id=?`).bind(id).run();
  return { ok: true };
}

/* ----------------------------- Expenses (P&L) ----------------------------- */
async function adminExpenses(request, env) {
  await requireOwner(request, env);
  const { results } = await env.DB.prepare(`SELECT * FROM expenses ORDER BY date DESC, id DESC`).all();
  return { ok: true, expenses: results || [] };
}
const EXPENSE_FIELDS = ["date", "category", "title", "amount", "note"];
async function expenseSave(request, env) {
  await requireOwner(request, env);
  const b = await request.json();
  if (b.id) {
    const sets = [], vals = [];
    for (const f of EXPENSE_FIELDS) if (b[f] != null) { sets.push(`${f}=?`); vals.push(f === "amount" ? (Number(b[f]) || 0) : b[f]); }
    if (sets.length) { vals.push(b.id); await env.DB.prepare(`UPDATE expenses SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); }
    return { ok: true, id: b.id };
  }
  const r = await env.DB.prepare(`INSERT INTO expenses (date,category,title,amount,note) VALUES (?,?,?,?,?)`)
    .bind(b.date || "", b.category || "", b.title || "", Number(b.amount) || 0, b.note || "").run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
}
async function expenseDelete(request, env) {
  await requireOwner(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  await env.DB.prepare(`DELETE FROM expenses WHERE id=?`).bind(id).run();
  return { ok: true };
}

/* ----------------------------- Settings & reminders ----------------------------- */
async function loadSettings(env) {
  const def = { reminders_enabled: "1", repeat_weeks: "6", loyalty_enabled: "1", loyalty_every: "6", loyalty_reward: "Знижка 50% на наступний комплекс",
    client_reminders_enabled: "1", remind_hours_before: "2", tg_bot: "",
    // Вимикач підтримки. У списку settingsSave його немає і бути не повинно: змінюють його
    // тільки /admin/support-open та /admin/support-close, і обидві — лише для власниці.
    support_until: "", support_prices: "0",
    // Коли востаннє надсилали анкету — щоб публічна ручка /brief не стала спамером.
    brief_at: "",
    // Пульс job watch: «n|час». Пише лише /release/state і /release/done, читає кнопка ↩️.
    rel_watch: "" };
  if (!env.DB) return def;
  try {
    const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
    (results || []).forEach(r => { def[r.key] = r.value; });
  } catch (e) { }
  return def;
}
async function adminSettings(request, env) {
  await requireAdmin(request, env);
  return { ok: true, settings: await loadSettings(env) };
}
// Що CRM може змінити в settings. Окремою константою, бо по ній же журнал підтримки рахує «було → стало».
const SETTINGS_SAVE_KEYS = ["reminders_enabled", "repeat_weeks", "note_gift", "note_big", "loyalty_enabled", "loyalty_every", "loyalty_reward", "client_reminders_enabled", "remind_hours_before"];
async function settingsSave(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  for (const k of SETTINGS_SAVE_KEYS) {
    if (b[k] != null) await env.DB.prepare(`INSERT INTO settings (company_id,key,value) VALUES (${env.CID},?,?) ON CONFLICT(company_id,key) DO UPDATE SET value=?`).bind(k, String(b[k]), String(b[k])).run();
  }
  return { ok: true, settings: await loadSettings(env) };
}

/* ----------------------------- Site CMS ----------------------------- */
// One JSON blob in `settings` (key "site_cms"): { hidden: [sectionId…], texts: { key: text } }.
// The site (scripts/main.js) hides the listed [data-cms-section] ids and replaces [data-cms] texts.
const SITE_CMS_MAX = 64 * 1024;
// The second argument is the map already stored. The CRM builds its editor from GET /site, which publishes URLs
// rather than ids, so an entry that comes back carrying only a new crop or a new alt is a CORRECTION
// to the slot that is already there — not a broken entry to drop.
const SITE_HIDDEN_TEXTS = 200;
function normalizeSiteCms(b, cur) {
  const hidden = [], hiddenText = [], texts = {}, images = {}, seen = new Set(), seenH = new Set();
  (Array.isArray(b && b.hidden) ? b.hidden : []).forEach(x => {
    const id = String(x == null ? "" : x).trim();
    if (/^[\w-]{1,40}$/.test(id) && !seen.has(id)) { seen.add(id); hidden.push(id); }
  });
  // individual lines the owner switched off — same idea as a hidden section, one level down
  (Array.isArray(b && b.hiddenText) ? b.hiddenText : []).forEach(x => {
    const k = String(x == null ? "" : x).trim();
    if (CMS_KEY_RE.test(k) && !seenH.has(k) && hiddenText.length < SITE_HIDDEN_TEXTS) { seenH.add(k); hiddenText.push(k); }
  });
  const t = b && b.texts;
  if (t && typeof t === "object" && !Array.isArray(t)) {
    for (const k of Object.keys(t)) {
      if (!/^[\w.-]{1,80}$/.test(k) || typeof t[k] !== "string") continue;
      const v = t[k].trim();
      if (v) texts[k] = v;
    }
  }
  // { "hero.main": { id, token, w, h, tw, th, pos:"50% 30%", alt } } — ids and tokens only,
  // never a URL: the worker builds those from its own origin when the site asks for them.
  const im = b && b.images;
  if (im && typeof im === "object" && !Array.isArray(im)) {
    for (const k of Object.keys(im)) {
      if (!CMS_KEY_RE.test(k) || Object.keys(images).length >= SITE_IMG_SLOTS) continue;
      const v = im[k];
      if (!v || typeof v !== "object") continue;
      const base = (cur && cur.images && cur.images[k]) || null;
      const good = x => Number.isInteger(x.id) && x.id > 0 && /^[0-9a-f]{16}$/.test(x.token);
      let cand = { id: Math.round(Number(v.id)), token: String(v.token || "") };
      if (!good(cand) && base) cand = { id: base.id, token: base.token };   // keep the photo, take the edit
      if (!good(cand)) continue;
      const o = { id: cand.id, token: cand.token };
      ["w", "h", "tw", "th"].forEach(f => { const n = iSize(v[f]) || (base ? iSize(base[f]) : 0); if (n) o[f] = n; });
      const pos = String(v.pos || "").trim();
      if (/^\d{1,3}% \d{1,3}%$/.test(pos) && pos !== "50% 50%") o.pos = pos;
      const alt = String(v.alt || "").replace(/\s+/g, " ").trim();
      if (alt) o.alt = alt.slice(0, 160);
      images[k] = o;
    }
  }
  return { hidden, hiddenText, texts, images };
}
async function loadSiteCms(env) {
  if (!env.DB) return { hidden: [], hiddenText: [], texts: {}, images: {} };
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='site_cms'`).first();
    if (row && row.value) return normalizeSiteCms(JSON.parse(row.value));
  } catch (e) { }
  return { hidden: [], hiddenText: [], texts: {}, images: {} };
}
async function publicSite(env, origin) {
  const c = await loadSiteCms(env);
  const images = {};
  for (const k of Object.keys(c.images || {})) {
    const v = c.images[k];
    images[k] = { u: `${origin}/img/${v.id}/${v.token}`, t: `${origin}/img/${v.id}/${v.token}/t`,
      w: v.w, h: v.h, tw: v.tw, th: v.th, pos: v.pos, alt: v.alt };
  }
  return { ok: true, hidden: c.hidden, hiddenText: c.hiddenText, texts: c.texts, images };
}
// What siteSave is about to store. A function of its own because the support journal computes its
// «було → стало» with this very code — a copy of it would one day start telling a different story.
// Texts are replaced wholesale (the editor always sends them all), photos are MERGED: a second tab,
// or a CRM page that parsed an older index.html, must not drop a slot it never knew about.
// Clearing a photo is explicit — the editor names the slot in the remove list.
function siteCmsNext(b, cur) {
  const next = normalizeSiteCms(b, cur);
  next.images = Object.assign({}, cur.images || {}, next.images);
  (Array.isArray(b.remove) ? b.remove : []).forEach(k => { if (CMS_KEY_RE.test(String(k))) delete next.images[String(k)]; });
  return next;
}
// Why siteSave would refuse that next state, or "" when it would not. The support journal asks the same
// function, so it never records a «було → стало» for a save that did not happen.
function siteCmsRefusal(next, cur) {
  if (Object.keys(next.images).length > SITE_IMG_SLOTS) return "Забагато фото";
  const size = new TextEncoder().encode(JSON.stringify(next)).length;   // bytes, not UTF-16 units — Cyrillic costs double
  if (size > SITE_CMS_MAX && size >= new TextEncoder().encode(JSON.stringify(cur)).length) return "Занадто багато тексту (ліміт 64 КБ)";   // a save that shrinks it always passes
  return "";
}
async function siteSave(request, env) {
  await requireAdmin(request, env);
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") { const e = new Error("bad request"); e.status = 400; throw e; }
  const cur = await loadSiteCms(env);
  const next = siteCmsNext(b, cur), why = siteCmsRefusal(next, cur);
  if (why) { const e = new Error(why); e.status = 413; throw e; }
  const raw = JSON.stringify(next), prev = JSON.stringify(cur);
  await env.DB.prepare(`INSERT INTO settings (company_id,key,value) VALUES (${env.CID},'site_cms_prev',?) ON CONFLICT(company_id,key) DO UPDATE SET value=?`).bind(prev, prev).run();
  await env.DB.prepare(`INSERT INTO settings (company_id,key,value) VALUES (${env.CID},'site_cms',?) ON CONFLICT(company_id,key) DO UPDATE SET value=?`).bind(raw, raw).run();
  await siteMediaMark(env, next.images);
  return { ok: true };
}
/* ---------- Nightly backup ----------
   The whole database written out as SQL into its own bucket, so a restore is one wrangler command
   and not an archaeology project. Thirty dailies, twelve monthlies (the 1st of each month), the rest
   swept by the same nightly run. The dump holds client names, phones and password hashes — the bucket
   is private, there is no public route to it, and it belongs to whoever owns the data. */
const BACKUP_DAILY_KEEP = 30, BACKUP_MONTHLY_KEEP = 12;
/* The salon's name, for the messages that reach its clients. It lives in the companies row, not in
   this file: a bot that greets someone else's customers by the wrong salon's name is the kind of
   thing nobody reports and everybody notices. schema.sql seeds a name, so the fallback is a
   formality. */
const salonName = env => (env && env.SALON) || "Салон";

const backupBucket = env => (env && env.BACKUPS && typeof env.BACKUPS.put === "function") ? env.BACKUPS : null;

const EXPECTED_TABLES = ["bookings", "clients", "pets", "pet_photos", "masters", "services", "expenses",
  "reviews", "users", "sessions", "client_sessions", "client_otp", "settings", "tg_sessions",
  "site_media", "companies", "support_log", "releases", "staff_tg"];

/* Enough to diagnose someone else's installation without opening their data. Deliberately has no
   client names, phones or notes in it: supporting a salon should not require reading its clients.
   Behind the operator's token, because the shape of a business is information too. */
async function health(env, origin) {
  const out = {
    ok: true, version: VERSION, build: BUILD, at: new Date().toISOString(),
    site: env.SITE_URL || "", origin: env.ALLOW_ORIGIN || "",
    calendar: calOn(env),
    telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    backups: !!backupBucket(env),
    admin_password_set: !!env.ADMIN_TOKEN,
  };
  const DB = env.DBRAW || env.DB;
  if (!DB) { out.ok = false; out.db = "немає прив'язки до бази"; return out; }
  try {
    const t = ((await DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`
    ).all()).results || []).map(r => r.name);
    out.tables = t.length;
    const missing = EXPECTED_TABLES.filter(x => !t.includes(x));
    if (missing.length) { out.ok = false; out.missing_tables = missing; }
    const one = async (sql) => { try { return (await DB.prepare(sql).first()).n; } catch (e) { return null; } };
    const today = isoInTz(new Date(), BUSINESS.tz);
    out.counts = {
      bookings: await one(`SELECT COUNT(*) AS n FROM bookings`),
      clients: await one(`SELECT COUNT(*) AS n FROM clients`),
      masters: await one(`SELECT COUNT(*) AS n FROM masters WHERE active=1`),
      services: await one(`SELECT COUNT(*) AS n FROM services WHERE active=1`),
      users: await one(`SELECT COUNT(*) AS n FROM users WHERE active=1`),
    };
    out.upcoming = await one(`SELECT COUNT(*) AS n FROM bookings WHERE date>='${today}' AND COALESCE(status,'new') NOT IN ('cancelled','no_show')`);
    // created_at is stored as a JS ISO string ("…T22:56:55.239Z") and SQLite's datetime() returns
    // "… 11:19:35" with a space. Compared as text, "T" sorts after " ", so the SQLite form quietly
    // swept in a whole extra day. Build the boundary in the same format the column uses.
    const since = new Date(Date.now() - 86400000).toISOString();
    out.booked_last_24h = await one(`SELECT COUNT(*) AS n FROM bookings WHERE created_at > '${since}'`);
    // An installation that cannot take a booking is the thing worth shouting about.
    if (!out.counts.masters) { out.ok = false; out.warn = "немає жодного активного майстра — форма запису не запропонує часу"; }
  } catch (e) { out.ok = false; out.db = String(e && e.message || e); }
  try {
    const b = backupBucket(env);
    if (b) {
      const o = await b.get("latest.json");
      out.last_backup = o ? JSON.parse(await o.text()) : null;
      if (!o) { out.ok = false; out.warn = (out.warn ? out.warn + "; " : "") + "жодного бекапу ще не було"; }
    }
  } catch (e) { out.last_backup = "помилка: " + String(e && e.message || e); }
  if (origin && env.TELEGRAM_BOT_TOKEN) {
    out.bot = await tgHealth(env, origin);
    if (!out.bot.ok) { out.ok = false; out.warn = (out.warn ? out.warn + "; " : "") + "бот: " + (out.bot.problem || "див. поле bot"); }
  }
  return out;
}
/* Чи бот справді працює, а не лише чи задані секрети. Після передачі токен знає тільки власниця,
   і «бот мовчить» без цього не розібрати: підтримка бачить /admin/health, а getWebhookInfo — ні.
   Токена й секрету вебхука тут немає: ім'я бота, куди дивиться вебхук, черга й остання помилка
   доставки, яку Telegram пам'ятає сам. */
async function tgHealth(env, origin) {
  const me = await tgApi(env, "getMe", {});
  // 401 — токен відкликано, 404 — токен битий; інший error_code — збій Telegram; без коду — мережа.
  if (!me || !me.ok) {
    const c = me && me.error_code;
    const why = c === 401 || c === 404 ? "Telegram не приймає токен" : c ? `Telegram відповів помилкою ${c}` : "Telegram не відповідає";
    return { ok: false, problem: why + ": " + (me && me.description || "немає відповіді") };
  }
  const out = { ok: true, username: (me.result && me.result.username) || "", chat_set: !!env.TELEGRAM_CHAT_ID };
  const wi = await tgApi(env, "getWebhookInfo", {});
  if (!wi || !wi.ok) return Object.assign(out, { ok: false, problem: "getWebhookInfo: " + (wi && wi.description || "немає відповіді") });
  const w = wi.result || {};
  const want = origin + "/tg/webhook/" + (env.CID || DEFAULT_COMPANY_ID);
  // Чужу адресу — лише хостом: дехто кладе токен бота просто в шлях вебхука.
  let host = ""; try { host = new URL(w.url).host; } catch (e) { }
  out.webhook = !w.url ? "не підключено" : w.url === want ? "цей воркер" : "інша адреса: " + host;
  out.pending = w.pending_update_count || 0;
  if (w.last_error_date) out.last_error = { at: new Date(w.last_error_date * 1000).toISOString(), message: w.last_error_message || "" };
  if (!out.chat_set) { out.ok = false; out.problem = "не задано TELEGRAM_CHAT_ID"; }
  if (w.url !== want) { out.ok = false; out.problem = "вебхук не на цьому воркері — власниці натиснути «Підключити бота»"; }
  // last_error_date Telegram не стирає після успішної доставки, тож свіжа помилка — проблема лише
  // тоді, коли апдейти справді накопичуються.
  else if (w.last_error_date && out.pending > 0 && Date.now() / 1000 - w.last_error_date < 3600) {
    // 403 тут майже завжди означає: новий токен уже у воркері, а кнопку ще не натиснули.
    out.ok = false; out.problem = "Telegram не може достукатися до воркера: " + (w.last_error_message || "");
  }
  return out;
}
function sqlLit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "object") {          // D1 hands a BLOB back as an array of byte values
    const b = v instanceof ArrayBuffer ? new Uint8Array(v) : Uint8Array.from(v.length != null ? v : []);
    let hex = ""; for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, "0");
    return "X'" + hex + "'";
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}
async function dumpDatabase(env) {
  const DB = env.DBRAW || env.DB;
  const tables = (((await DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`
  ).all()).results) || []).map(r => r.name);
  // The dump carries its own CREATE TABLE. Without it a backup can only be restored over a
  // database that already has today's exact schema: an empty D1 fails on "no such table",
  // and a dump taken before a migration fails on a table that has since been dropped.
  const ddlRows = (((await DB.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
     ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, tbl_name, name`
  ).all()).results) || []);
  const ifNotExists = sql => String(sql).trim()
    .replace(/^CREATE TABLE\s+(?!IF NOT EXISTS)/i, "CREATE TABLE IF NOT EXISTS ")
    .replace(/^CREATE (UNIQUE )?INDEX\s+(?!IF NOT EXISTS)/i, (m, u) => "CREATE " + (u || "") + "INDEX IF NOT EXISTS ");
  const out = ["-- " + salonName(env) + " CRM · " + new Date().toISOString(),
    "-- restore into an empty database: npx wrangler d1 execute <db> --remote --file <this file>",
    "-- this file is self-contained: schema first, then the rows.",
    "PRAGMA defer_foreign_keys = true;", ""];
  for (const d of ddlRows) out.push(ifNotExists(d.sql) + ";");
  const counts = {};
  for (const t of tables) {
    const rows = (((await DB.prepare(`SELECT * FROM "${t}"`).all()).results) || []);
    counts[t] = rows.length;
    out.push("", `-- ${t} (${rows.length})`, `DELETE FROM "${t}";`);
    for (const r of rows) {
      const cols = Object.keys(r);
      out.push(`INSERT INTO "${t}" (${cols.map(c => '"' + c + '"').join(",")}) VALUES (${cols.map(c => sqlLit(r[c])).join(",")});`);
    }
  }
  return { sql: out.join("\n") + "\n", counts };
}
async function backupSweep(bucket, now) {
  const cut = { "daily/": new Date(now.getTime() - BACKUP_DAILY_KEEP * 86400000).toISOString().slice(0, 10),
    "monthly/": new Date(now.getTime() - BACKUP_MONTHLY_KEEP * 31 * 86400000).toISOString().slice(0, 7) };
  let dropped = 0;
  for (const prefix of Object.keys(cut)) {
    const list = await bucket.list({ prefix });
    for (const o of (list.objects || [])) {
      const stamp = o.key.slice(prefix.length).replace(/\.sql$/, "");
      if (stamp && stamp < cut[prefix]) { try { await bucket.delete(o.key); dropped++; } catch (e) { } }
    }
  }
  return dropped;
}
async function runBackup(env, alsoMonthly) {
  const bucket = backupBucket(env);
  if (!bucket || !env.DB) return { ok: false, error: "Немає бакета для резервних копій (binding BACKUPS)" };
  const now = new Date(), day = now.toISOString().slice(0, 10);
  const { sql, counts } = await dumpDatabase(env);
  const meta = { httpMetadata: { contentType: "application/sql; charset=utf-8" } };
  await bucket.put(`daily/${day}.sql`, sql, meta);
  if (alsoMonthly || day.slice(8) === "01") await bucket.put(`monthly/${day.slice(0, 7)}.sql`, sql, meta);
  const rows = Object.keys(counts).reduce((n, k) => n + counts[k], 0);
  const summary = { day, bytes: sql.length, tables: Object.keys(counts).length, rows, counts };
  await bucket.put("latest.json", JSON.stringify(summary, null, 1), { httpMetadata: { contentType: "application/json" } });
  summary.dropped = await backupSweep(bucket, now);
  summary.ok = true;
  return summary;
}
async function backupList(env) {
  const bucket = backupBucket(env);
  if (!bucket) return { ok: false, error: "Немає бакета для резервних копій" };
  const all = [];
  for (const prefix of ["daily/", "monthly/"]) {
    const list = await bucket.list({ prefix });
    (list.objects || []).forEach(o => all.push({ key: o.key, size: o.size, uploaded: o.uploaded }));
  }
  all.sort((a, b) => a.key < b.key ? 1 : -1);
  let latest = null;
  try { const o = await bucket.get("latest.json"); if (o) latest = JSON.parse(await o.text()); } catch (e) { }
  return { ok: true, files: all, latest };
}
async function backupFetch(env, key) {
  const bucket = backupBucket(env);
  if (!bucket || !/^(daily|monthly)\/[\w.-]{1,40}\.sql$/.test(String(key || ""))) return null;
  return await bucket.get(key);
}
// YYYY-MM-DD for a Date in a timezone.
function isoInTz(d, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function contactLinks(phone) {
  const digits = (phone || "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  const intl = digits.startsWith("+") ? digits : ("+38" + digits.replace(/^\+?/, ""));
  return ` <a href="tel:${intl}">☎</a> <a href="viber://chat?number=${encodeURIComponent(intl)}">Viber</a>`;
}
async function sendTelegram(env, text, extra) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const r = await tgApi(env, "sendMessage", Object.assign({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }, extra || {}));
  return !!(r && r.ok);
}
/* Подія салону, яку мають бачити всі, хто веде записи: власниця (її чат) і адміністратори з
   підключеним ботом. Службове (підтримка, випуски, коди входу) сюди НЕ йде — лише sendTelegram. */
async function alertSalon(env, text, extra) {
  const ok = await sendTelegram(env, text, extra);
  try { await staffNotify(env, text, { admins: true }, extra); } catch (e) { }
  return ok;
}
// Daily digest: tomorrow's appointments + clients due for a repeat visit.
async function runDailyDigest(env, force) {
  if (!env.DB) return { ok: false, error: "no db" };
  const s = await loadSettings(env);
  if (!force && s.reminders_enabled !== "1") return { ok: true, skipped: true };
  const tz = BUSINESS.tz;
  const today = isoInTz(new Date(), tz);
  const tomorrow = isoInTz(new Date(Date.now() + 86400000), tz);
  const weeks = Math.max(1, parseInt(s.repeat_weeks, 10) || 6);

  const { results: bookings } = await env.DB.prepare(`SELECT * FROM bookings`).all();
  const all = bookings || [];

  // 1) tomorrow's appointments
  const tmr = all.filter(b => b.date === tomorrow && b.time && (b.status === "new" || b.status === "confirmed") && b.service !== "Блокування")
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  let msg1;
  if (tmr.length) {
    msg1 = `🔔 <b>Записи на завтра (${tomorrow})</b>\n\n` + tmr.map(b =>
      `${tgEsc(b.time)} — ${b.pet_name ? tgEsc(b.pet_name) + " · " : ""}${tgEsc(b.service || "")}${b.staff ? " · " + tgEsc(b.staff) : ""}\n👤 ${tgEsc(b.name || "")} — ${tgEsc(b.phone || "")}${contactLinks(b.phone)}`
    ).join("\n\n");
  } else {
    msg1 = `🔔 <b>Записи на завтра (${tomorrow})</b>\n\nНа завтра записів немає.`;
  }
  const sent1 = await sendTelegram(env, msg1);
  let sent2 = true;
  // Адміністраторам — те саме зведення, майстрам — лише їхній завтрашній день. Результат цієї
  // функції (і кнопки в CRM) залежить тільки від чату власниці, як і раніше.
  try { await staffNotify(env, msg1, { admins: true }); await runMasterDigest(env, tomorrow, tmr); } catch (e) { }

  // 2) repeat-due clients: last done >= weeks ago and no upcoming booking
  const byClient = {};
  const key = b => (b.client_id != null ? "c" + b.client_id : "p" + (b.phone || "").replace(/\D/g, "").slice(-9));
  all.forEach(b => { const k = key(b); (byClient[k] = byClient[k] || []).push(b); });
  const cutoff = isoInTz(new Date(Date.now() - weeks * 7 * 86400000), tz);
  const due = [];
  for (const k in byClient) {
    const list = byClient[k];
    const isDone = b => b.status === "done" || b.status === "paid";
    const doneDates = list.filter(b => isDone(b) && b.date).map(b => b.date).sort();
    if (!doneDates.length) continue;
    const last = doneDates[doneDates.length - 1];
    const hasUpcoming = list.some(b => b.date && b.date >= today && (b.status === "new" || b.status === "confirmed"));
    if (last <= cutoff && !hasUpcoming) {
      const ref = list.slice().reverse().find(isDone) || list[0];
      due.push({ name: ref.name || "", phone: ref.phone || "", pet: ref.pet_name || "", last });
    }
  }
  due.sort((a, b) => (a.last || "").localeCompare(b.last || ""));
  if (due.length) {
    const msg2 = `🔁 <b>Час на повторний грумінг</b> (останній візит понад ${weeks} тижнів тому)\n\n` +
      due.slice(0, 40).map(d => `${d.pet ? tgEsc(d.pet) + " · " : ""}${tgEsc(d.name)} — ${tgEsc(d.phone)}${contactLinks(d.phone)}\n<i>останній: ${tgEsc(d.last)}</i>`).join("\n\n");
    sent2 = await sendTelegram(env, msg2);
    try { await staffNotify(env, msg2, { admins: true }); } catch (e) { }
  }
  // Раніше відповідь була ok:true, навіть коли Telegram нічого не прийняв, і кнопка в CRM казала
  // «Готово!». Причину відмови видно в wrangler tail (рядок «telegram sendMessage: …»).
  if (!sent1 || !sent2) return { ok: false, error: "Telegram не прийняв зведення", tomorrow: tmr.length, repeatDue: due.length };
  return { ok: true, tomorrow: tmr.length, repeatDue: due.length };
}

// Keep the Google Calendar event in sync with the CRM row (source of truth).
async function syncCalendar(env, id) {
  if (!env.DB || !env.CALENDAR_ID || !env.SA_EMAIL) return "skip";
  const row = await env.DB.prepare(`SELECT * FROM bookings WHERE id=?`).bind(id).first();
  if (!row) return "no-row";
  const hasTime = !!(row.date && row.time);
  const active = hasTime && row.status !== "cancelled" && row.status !== "no_show";
  const token = await getAccessToken(env);
  if (active) {
    if (row.event_id) { await calPatch(env, token, row.event_id, row); return "patched"; }
    const ev = await calCreate(env, token, row);
    await env.DB.prepare(`UPDATE bookings SET event_id=?, event_link=? WHERE id=?`).bind(ev.id, ev.htmlLink, id).run();
    return "created";
  }
  // no time or cancelled -> remove the calendar event, free the slot
  if (row.event_id) {
    await calDelete(env, token, row.event_id);
    await env.DB.prepare(`UPDATE bookings SET event_id=NULL, event_link=NULL WHERE id=?`).bind(id).run();
    return "deleted";
  }
  return "unchanged";
}

async function adminDelete(request, env) {
  await requireAdmin(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  try {   // an upcoming active booking removed from the CRM is a cancellation from the client's point of view
    const cur = await env.DB.prepare(`SELECT ${STAFF_COLS} FROM bookings WHERE id=?`).bind(id).first();
    if (cur && ["new", "confirmed"].includes(cur.status) && cur.date && cur.date >= isoInTz(new Date(), BUSINESS.tz)) {
      await tgNotifyClient(env, id, "cancelled");
      await tellMaster(env, "cancelled", cur);   // і майстру: інакше він чекатиме собаку, якої не буде
    }
  } catch (e) { }
  // remove the linked Google Calendar event first
  try {
    const row = await env.DB.prepare(`SELECT event_id FROM bookings WHERE id=?`).bind(id).first();
    if (row && row.event_id && env.CALENDAR_ID && env.SA_EMAIL) {
      const token = await getAccessToken(env);
      await calDelete(env, token, row.event_id);
    }
  } catch (e) { /* non-fatal — still delete the row */ }
  await env.DB.prepare(`DELETE FROM bookings WHERE id=?`).bind(id).run();
  return { ok: true };
}

async function notifyTelegram(env, b) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const head = b.waitlist ? "⏳ <b>Лист очікування</b>"
    : b.isRequest ? "📩 <b>Нова заявка (готель/садочок)</b>" : "🗓️ <b>Новий запис</b>" + (b.source === "telegram" ? " · 🤖 через бота" : "");
  // Усе нижче приходить з анонімної форми, а повідомлення йде з parse_mode HTML: без tgEsc «<3» у
  // коментарі ламало розбір (сповіщення не доходило), а <a href> малювався клікабельним у її чаті.
  const e = tgEsc;
  const when = b.isRequest ? (b.date ? `\n📅 Бажана дата: ${e(b.date)}` : "") : `\n📅 ${e(b.date)} о ${e(b.time)}`;
  const text =
    `${head}\n\n🐾 ${e(b.pet || "—")} · ${e(b.breed || "")}\n✂️ ${e(b.service)}${when}` +
    (b.staff ? `\n👩‍🔧 ${e(b.staff)}` : "") + `\n👤 ${e(b.name)}\n📞 ${e(b.phone)}` +
    (b.note ? `\n💬 ${e(b.note)}` : "");
  // Через tgApi, бо той не кидає: збій мережі до Telegram колись губив сам запис клієнта.
  const btns = b.id ? staffAlertButtons(b.id, !b.isRequest && !b.waitlist) : undefined;
  if (env.TELEGRAM_CHAT_ID) await tgApi(env, "sendMessage", Object.assign({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }, btns || {}));
  try {
    await staffNotify(env, text, { admins: true }, btns);
    if (b.id && b.staff && !b.isRequest && !b.waitlist) await tellMaster(env, "new", { id: b.id, date: b.date, time: b.time, service: b.service, pet_name: b.pet_name, pet: b.pet, breed: b.breed, name: b.name, staff: b.staff, note: b.note });
  } catch (e) { }
}

/* ----------------------------- Client reminders via Telegram -----------------------------
   The salon's bot also talks to clients. A client links their chat once (deep link after
   booking on the site, or by sharing their phone with the bot); after that they get a
   confirmation, a day-before and a "starting soon" reminder with ✅/❌ buttons. */
function tgEsc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
async function tgApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, description: "no bot token" };
  // У лог — лише метод і відповідь Telegram («bot was blocked by the user», «Unauthorized»).
  // Ні chat id, ні тексту повідомлення; токен вирізається, бо він є в адресі запиту.
  const warn = (what) => console.warn(`telegram ${method}: ${String(what).split(env.TELEGRAM_BOT_TOKEN).join("<token>").slice(0, 300)}`);
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}) });
    const j = await r.json();
    if (!j || !j.ok) warn(`${(j && j.error_code) || r.status} ${(j && j.description) || ""}`);
    return j;
  } catch (e) {
    warn(e && e.message || e);
    return { ok: false, description: String(e && e.message || e) };
  }
}
async function tgSendTo(env, chatId, text, extra) {
  if (!chatId) return { ok: false, description: "no chat" };
  return tgApi(env, "sendMessage", Object.assign({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }, extra || {}));
}
async function sha256hex(s) { return bufToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function tgWebhookSecret(env) { return (await sha256hex("tg-webhook:" + (env.TELEGRAM_BOT_TOKEN || ""))).slice(0, 40); }
async function tgDeepLink(env, code) { const s = await loadSettings(env); return s.tg_bot && code ? `https://t.me/${s.tg_bot}?start=${code}` : ""; }
function fmtDdMm(iso) { const p = String(iso || "").split("-"); return p.length === 3 ? `${p[2]}.${p[1]}` : iso; }
function kyivNow() { // { iso, min } in Europe/Kyiv
  const tz = BUSINESS.tz, d = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  return { iso: isoInTz(d, tz), min: ((+p.hour) % 24) * 60 + (+p.minute) };
}
const CLIENT_COLS = `id,date,time,name,phone,pet_name,service,staff,status,client_id,remind_day_sent,remind_hour_sent,is_request,event_id`;
function visitText(b) { return `${fmtDdMm(b.date)} о <b>${tgEsc(b.time)}</b> — ${tgEsc(b.service || "грумінг")}${b.pet_name ? " для " + tgEsc(b.pet_name) : ""}${b.staff ? "\n👩‍🔧 Майстер: " + tgEsc(b.staff) : ""}`; }
function visitButtons(b) { return { reply_markup: { inline_keyboard: [[{ text: "✅ Буду", callback_data: `ok:${b.id}` }], [{ text: "🔁 Перенести", callback_data: `mv:${b.id}` }, { text: "❌ Скасувати", callback_data: `cancel:${b.id}` }]] } }; }
async function clientChatFor(env, b) { // the booking's client's chat id (by client_id, else by phone)
  if (!env.DB) return null;
  if (b.client_id) { const c = await env.DB.prepare(`SELECT tg_chat_id FROM clients WHERE id=?`).bind(b.client_id).first(); if (c && c.tg_chat_id) return c.tg_chat_id; }
  const np = normPhone(b.phone); if (np.length < 9) return null;   // junk phones must never collide
  const cs = await env.DB.prepare(`SELECT phone, tg_chat_id FROM clients WHERE tg_chat_id IS NOT NULL`).all();
  const f = (cs.results || []).find(c => normPhone(c.phone) === np); return f ? f.tg_chat_id : null;
}
// "created" / "confirmed" / "moved" / "cancelled" message to a linked client. Never throws, never blocks the caller.
const NOTIFY_HEAD = { created: "🗓 <b>Запис створено</b>", confirmed: "✅ <b>Ваш запис підтверджено</b>", moved: "🔁 <b>Ваш запис перенесено</b>", cancelled: "❌ <b>Ваш запис скасовано</b>" };
async function tgNotifyClient(env, bookingId, kind) {
  try {
    const b = await env.DB.prepare(`SELECT ${CLIENT_COLS} FROM bookings WHERE id=?`).bind(bookingId).first(); if (!b || !b.date || !b.time) return;
    const chat = await clientChatFor(env, b); if (!chat) return;
    const head = NOTIFY_HEAD[kind] || NOTIFY_HEAD.created;
    if (kind === "cancelled") { await tgSendTo(env, chat, `${head}\n${visitText(b)}\n\nЯкщо це помилка або хочете інший час — напишіть нам чи натисніть /book, щоб записатися знову.`); return; }
    await tgSendTo(env, chat, `${head}\n${visitText(b)}\n\nНагадаємо напередодні. Якщо плани зміняться — натисніть «Перенести» або «Скасувати».`, visitButtons(b));
  } catch (e) { }
}
// CRM → one client: free-text message to the client's linked chat (by booking or by client id).
async function notifyClientManual(request, env) {
  const who = await requireAdmin(request, env);
  const body = await request.json();
  const text = String(body.text || "").trim().slice(0, 1500);
  if (!text) return { ok: false, error: "Порожнє повідомлення" };
  let chat = null, name = "";
  if (body.booking_id) { const b = await env.DB.prepare(`SELECT ${CLIENT_COLS} FROM bookings WHERE id=?`).bind(+body.booking_id).first(); if (b) { chat = await clientChatFor(env, b); name = b.name || ""; } }
  else if (body.client_id) { const c = await env.DB.prepare(`SELECT name,tg_chat_id FROM clients WHERE id=?`).bind(+body.client_id).first(); if (c) { chat = c.tg_chat_id || null; name = c.name || ""; } }
  if (!chat) return { ok: false, error: "Клієнт ще не підключив Telegram-бот — повідомлення нікуди надіслати" };
  return await sendClientMessage(env, who.name || "CRM", chat, name, text);
}
// Повідомлення клієнту від імені салону — з CRM і з бота адміністратора. Власниця бачить кожне.
async function sendClientMessage(env, whoName, chat, clientName, text) {
  const r = await tgSendTo(env, chat, `💬 <b>${tgEsc(salonName(env))}</b>\n${tgEsc(text)}`);
  if (!r || !r.ok) return { ok: false, error: "Telegram не прийняв повідомлення: " + ((r && r.description) || "помилка") };
  try { await sendTelegram(env, `✉️ <b>${tgEsc(whoName)}</b> написав(ла) клієнту ${tgEsc(clientName)}:\n<i>${tgEsc(text)}</i>`); } catch (e) { }
  return { ok: true };
}
// CRM → every linked client (promo / news). Sequential, gentle on the Bot API rate limit.
async function notifyBroadcast(request, env) {
  const who = await requireAdmin(request, env);
  const body = await request.json();
  const text = String(body.text || "").trim().slice(0, 2000);
  if (!text) return { ok: false, error: "Порожнє повідомлення" };
  const rows = (await env.DB.prepare(`SELECT id,tg_chat_id FROM clients WHERE tg_chat_id IS NOT NULL AND tg_chat_id<>'' AND COALESCE(status,'active')='active'`).all()).results || [];
  const seen = new Set(); let sent = 0, failed = 0;
  for (const c of rows) {
    if (seen.has(String(c.tg_chat_id))) continue; seen.add(String(c.tg_chat_id));
    const r = await tgSendTo(env, c.tg_chat_id, `📣 <b>${tgEsc(salonName(env))}</b>\n${tgEsc(text)}`);
    if (r && r.ok) sent++; else failed++;
    if ((sent + failed) % 20 === 0) await new Promise(res => setTimeout(res, 1100));
  }
  try { await sendTelegram(env, `📣 <b>Розсилка від ${tgEsc(who.name || "CRM")}</b> — надіслано ${sent}, помилок ${failed}\n<i>${tgEsc(text.slice(0, 300))}</i>`); } catch (e) { }
  return { ok: true, sent, failed, total: seen.size };
}
// Free master for a date-time (same rule as book()): prefer `prefer`, else the first free one; null = nobody.
// Used when a booking is moved — from the client cabinet and from the bot. It is the third place
// that decides "is this hour taken", and it has to answer from the same source as the other two.
async function freeMasterAt(env, { date, time, service, prefer, excludeEventId, excludeId, breed, weight }) {
  const { y, m, d } = parseDate(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(time || ""); if (!tm) return null;
  const startMin = (+tm[1]) * 60 + (+tm[2]);
  const duration = await bookingDuration(env, { service, breed, weight });
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const masters = await loadMasters(env);
  const start = wallToUTC(y, m, d, startMin, BUSINESS.tz), end = new Date(start.getTime() + duration * 60000);
  if (start.getTime() < Date.now() + BUSINESS.minLeadMin * 60000 || start.getTime() > Date.now() + BUSINESS.maxAheadDays * 86400000) return null; // same bounds as the slot picker
  const events = (await busyEvents(env, date,
      new Date(start.getTime() - BUSINESS.bufferMin * 60000),
      new Date(end.getTime() + BUSINESS.bufferMin * 60000), excludeId || 0))
    .filter(ev => !excludeEventId || ev.id !== excludeEventId);   // the booking's own event is not a conflict
  const isFree = mst => startMin >= mst.startMin && startMin + duration <= mst.endMin &&
    !inBreak(mst, startMin, startMin + duration) && masterWorks(mst, date, dow) &&
    !overlappingAt(events, start.getTime(), end.getTime()).some(ev => ev.blockAll || ev.staff === mst.name);
  const p = prefer ? masters.find(x => x.name === prefer) : null;
  if (p && isFree(p)) return p.name;
  const f = masters.find(isFree);
  return f ? f.name : null;
}
// Cron: "day" = tomorrow's visits (evening run), "soon" = visits starting within N hours (every 30 min). Idempotent via remind_*_sent flags.
async function runClientReminders(env, kind, force) {
  if (!env.DB) return { ok: false, error: "no db" };
  const s = await loadSettings(env);
  if (!force && s.client_reminders_enabled !== "1") return { ok: true, skipped: true };
  const now = kyivNow(), hours = Math.max(1, parseInt(s.remind_hours_before, 10) || 2);
  let rows;
  if (kind === "day") {
    const tomorrow = isoInTz(new Date(Date.now() + 86400000), BUSINESS.tz);
    rows = (await env.DB.prepare(`SELECT ${CLIENT_COLS} FROM bookings WHERE date=? AND time<>'' AND status IN ('new','confirmed') AND service<>'Блокування' AND COALESCE(remind_day_sent,0)=0`).bind(tomorrow).all()).results || [];
  } else {
    rows = ((await env.DB.prepare(`SELECT ${CLIENT_COLS} FROM bookings WHERE date=? AND time<>'' AND status IN ('new','confirmed') AND service<>'Блокування' AND COALESCE(remind_hour_sent,0)=0`).bind(now.iso).all()).results || [])
      .filter(b => { const t = hmToMin(b.time); return t != null && t > now.min && t - now.min <= hours * 60; });
  }
  let sent = 0, unlinked = 0;
  for (const b of rows) {
    const chat = await clientChatFor(env, b);
    if (!chat) { unlinked++; continue; }
    const text = kind === "day"
      ? `🔔 <b>Нагадуємо про візит завтра</b>\n${visitText(b)}\n\nПідтвердіть, будь ласка, що ви будете:`
      : `⏰ <b>Вже скоро!</b>\nЧекаємо вас ${visitText(b)}\n\nДо зустрічі в ${tgEsc(salonName(env))} 🐾`;
    const r = await tgSendTo(env, chat, text, kind === "day" ? visitButtons(b) : undefined);
    if (r && r.ok) { sent++; await env.DB.prepare(`UPDATE bookings SET ${kind === "day" ? "remind_day_sent" : "remind_hour_sent"}=1 WHERE id=?`).bind(b.id).run(); }
  }
  return { ok: true, kind, candidates: rows.length, sent, unlinked };
}
async function linkClientChat(env, clientId, chatId) {
  await env.DB.prepare(`UPDATE clients SET tg_chat_id=NULL WHERE tg_chat_id=? AND id<>?`).bind(chatId, clientId).run();
  await env.DB.prepare(`UPDATE clients SET tg_chat_id=? WHERE id=?`).bind(chatId, clientId).run();
}
// "Give us your phone" step: the contact handler continues wherever st.after says.
const PHONE_KB = { reply_markup: { keyboard: [[{ text: "📱 Поділитися номером", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } };
function bookBtn() { return kb([[{ text: "📅 Записатися", callback_data: "b:start" }, { text: "🔑 Кабінет", callback_data: "cab" }], [{ text: "☰ Усе меню", callback_data: "c:m" }]]); }
async function askPhone(env, chat, after, text) {
  await tgSetState(env, chat, { step: "contact", after: after || "" });
  await tgSendTo(env, chat, text, PHONE_KB);
}
async function sendCabinetLink(env, chat, clientId) {
  await tgSendTo(env, chat, "Ваш кабінет: візити, перенесення, улюбленці та бонуси. Посилання відкриває кабінет без коду:", await cabinetLinkButton(env, clientId));
}
async function sendVisits(env, chat, c) {
  const rows = (await env.DB.prepare(`SELECT ${CLIENT_COLS} FROM bookings WHERE client_id=? AND date>=? AND time<>'' AND status IN ('new','confirmed','arrived') AND service<>'Блокування' ORDER BY date, time LIMIT 6`).bind(c.id, isoInTz(new Date(), BUSINESS.tz)).all()).results || [];
  if (!rows.length) { await tgSendTo(env, chat, "👤 " + tgEsc(c.name || "") + "\n\nНайближчих візитів немає. Записатися можна прямо тут 👇", bookBtn()); return; }
  await tgSendTo(env, chat, `👤 ${tgEsc(c.name || "")} — ваші найближчі візити (${rows.length}):`);
  for (const b of rows) {
    const canChange = b.status !== "arrived";
    await tgSendTo(env, chat, `${b.status === "confirmed" ? "✅" : b.status === "arrived" ? "🏠" : "🕐"} ${visitText(b)}`,
      canChange ? kb([[{ text: "🔁 Перенести", callback_data: `mv:${b.id}` }, { text: "❌ Скасувати", callback_data: `cancel:${b.id}` }]]) : undefined);
  }
}
// Shown once, right after a chat is linked: what this bot is for.
async function botIntroText(env) {
  let st = {};
  try { st = await loadSettings(env); } catch (e) { }
  const lines = [
    "Ось що я вмію 👇",
    "📅 <b>Записати на грумінг</b> — кнопка нижче або /book",
    "🔔 <b>Нагадаю про візит</b> — за день і за годину до нього",
    "🔁 <b>Перенести</b> або ❌ <b>скасувати</b> — /visits, двома кнопками",
    "🔑 <b>Кабінет</b> — /cabinet: візити, улюбленці, бонуси",
  ];
  if (st.loyalty_enabled === "1") {
    const every = Math.max(2, parseInt(st.loyalty_every, 10) || 6);
    const reward = st.loyalty_reward || "приємний бонус";
    lines.push(`🎁 <b>Бонусна картка</b> — кожен ${every}-й візит: ${tgEsc(reward)}. Відмітки нараховуються автоматично.`);
  }
  return lines.join("\n");
}
async function nextVisitsText(env, clientId) {
  const today = isoInTz(new Date(), BUSINESS.tz);
  const r = await env.DB.prepare(`SELECT ${CLIENT_COLS} FROM bookings WHERE client_id=? AND date>=? AND time<>'' AND status IN ('new','confirmed','arrived') AND service<>'Блокування' ORDER BY date,time LIMIT 3`).bind(clientId, today).all();
  const rows = r.results || [];
  return rows.length ? "\n\nВаші найближчі візити:\n" + rows.map(b => "• " + visitText(b).replace(/\n👩‍🔧 Майстер: /g, " · ")).join("\n") : "";
}
// Telegram → us. Handles /start [code], shared contact, and the ✅/❌ buttons.
async function handleTgUpdate(env, u) {
  if (!env.DB || !u) return;
  const msg = u.message, cq = u.callback_query;
  if (cq && cq.data && cq.message) {
    const chat = cq.message.chat.id;
    if (cq.data.startsWith("s:")) { await staffCallback(env, cq, chat); return; }    // кабінет персоналу
    if (cq.data.startsWith("c:")) { await clientCallback(env, cq, chat); return; }   // меню клієнта
    if (cq.data.startsWith("b:")) {   // booking dialogue buttons
      try { await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id }); } catch (e) { }
      await bookingStep(env, chat, cq.data);
      return;
    }
    if (cq.data === "cab") {   // «🔑 Кабінет» button → personal login link
      try { await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id }); } catch (e) { }
      const c = await clientByChat(env, chat);
      if (!c) { await askPhone(env, chat, "cab", "Щоб відкрити кабінет, поділіться номером телефону — ми знайдемо або створимо ваш профіль:"); return; }
      await sendCabinetLink(env, chat, c.id);
      return;
    }
    // Перед розбором кнопок броні: нижче невідомий callback_data мовчки ігнорується.
    if (await releaseButton(env, cq, chat)) return;
    const m = /^(ok|cancel|mv):(\d+)$/.exec(cq.data);
    if (!m) return;
    const b = await env.DB.prepare(`SELECT ${CLIENT_COLS} FROM bookings WHERE id=?`).bind(+m[2]).first();
    const owner = b ? await clientChatFor(env, b) : null;
    if (!b || String(owner) !== String(chat)) { await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Запис не знайдено" }); return; }
    const clearButtons = () => tgApi(env, "editMessageReplyMarkup", { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    if (m[1] === "mv") {   // reschedule: reuse the booking dialogue's date/time pickers with move_id in the state
      if (!["new", "confirmed"].includes(b.status)) { await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Цей запис уже не можна перенести" }); return; }
      if (b.is_request || !b.time) { await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Заявку без точного часу переносимо вручну — напишіть нам" }); return; }
      await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id });
      const st = { step: "date", move_id: b.id, service: b.service, staff: b.staff || "", pet_name: b.pet_name || "", old_date: b.date, old_time: b.time };
      await tgSendTo(env, chat, `🔁 Переносимо запис: ${visitText(b)}`);
      await bookingAskDate(env, chat, st, 0);
      return;
    }
    if (!["new", "confirmed"].includes(b.status)) {   // stale buttons on a finished / cancelled booking
      await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id, text: b.status === "cancelled" ? "Цей запис уже скасовано" : "Цей запис уже завершено", show_alert: false });
      await clearButtons();
      return;
    }
    if (m[1] === "ok") {
      if (b.status === "new") { await env.DB.prepare(`UPDATE bookings SET status='confirmed' WHERE id=?`).bind(b.id).run(); try { await syncCalendar(env, b.id); } catch (e) { } }
      await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Дякуємо! Чекаємо на вас 🐾" });
      await clearButtons();
      await tgSendTo(env, chat, `✅ Підтверджено: ${visitText(b)}`);
    } else {
      if (["new", "confirmed"].includes(b.status)) {
        await env.DB.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).bind(b.id).run();
        try { await syncCalendar(env, b.id); } catch (e) { }
        try { await alertSalon(env, `❌ <b>Клієнт скасував запис через бота</b>\n${visitText(b)}\n👤 ${tgEsc(b.name || "")} — ${tgEsc(b.phone || "")}`); } catch (e) { }
        try { await tellMaster(env, "cancelled", b); } catch (e) { }
      }
      await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Запис скасовано" });
      await clearButtons();
      await tgSendTo(env, chat, "❌ Запис скасовано. Будемо раді бачити вас іншим разом — записатись знову можна на сайті.");
    }
    return;
  }
  if (!msg || !msg.chat) return;
  const chat = msg.chat.id, text = String(msg.text || "").trim();
  const st = await tgGetState(env, chat);   // booking dialogue in progress (if any)
  const BOOK_BTN = bookBtn();
  if (msg.contact && msg.contact.phone_number) {
    // only the sender's OWN contact — a forwarded card must never attach this chat to someone else's profile
    const own = msg.from && msg.contact.user_id && String(msg.contact.user_id) === String(msg.from.id);
    if (!own) { await tgSendTo(env, chat, "Приймаємо лише ваш власний номер 🙏\nНатисніть кнопку «📱 Поділитися номером» унизу екрана.", PHONE_KB); return; }
    const phone = stdPhone(msg.contact.phone_number);
    const np = normPhone(phone);
    const after = (st && st.step === "contact" && st.after) || "";
    const cs = await env.DB.prepare(`SELECT id,name,phone FROM clients`).all();
    let c = (cs.results || []).find(x => normPhone(x.phone) === np), created = false;
    if (!c) {   // this chat may already belong to a profile whose CRM phone is a different number — keep it, never fork
      const cur = await clientByChat(env, chat);
      if (cur) {
        c = cur;
        try { await alertSalon(env, `⚠️ <b>Номер у Telegram не збігається з карткою клієнта</b>\n👤 ${tgEsc(cur.name || "")} (#${cur.id}) — у CRM ${tgEsc(cur.phone || "")}, у Telegram ${tgEsc(phone)}`); } catch (e) { }
      }
    }
    if (!c) {   // nobody with this number yet → register them right here
      const nm = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(" ") || "Клієнт з Telegram";
      const r = await env.DB.prepare(`INSERT INTO clients (created_at,name,phone,source,status) VALUES (?,?,?,'telegram','active')`).bind(new Date().toISOString(), nm, phone).run();
      c = { id: r.meta && r.meta.last_row_id, name: nm, phone }; created = true;
      try { await alertSalon(env, `🆕 <b>Новий клієнт через Telegram-бот</b>\n👤 ${tgEsc(nm)} — ${tgEsc(phone)}`); } catch (e) { }
    }
    await linkClientChat(env, c.id, chat);
    await tgSendTo(env, chat, `✅ Готово, ${tgEsc(c.name || "")}! Нагадування про візити приходитимуть сюди.${created ? "" : await nextVisitsText(env, c.id)}`, { reply_markup: { remove_keyboard: true } });
    try { await tgSendTo(env, chat, await botIntroText(env)); } catch (e) { }
    if (after === "book") { await bookingAskPet(env, chat, c); return; }
    await tgClearState(env, chat);
    if (after === "cab") { await sendCabinetLink(env, chat, c.id); return; }
    if (after === "visits") { await sendVisits(env, chat, c); return; }
    if (after === "menu") { await clientMenu(env, chat, null, c); return; }
    await tgSendTo(env, chat, "Записатися на грумінг можна прямо тут 👇", BOOK_BTN);
    return;
  }
  // Свій chat id людина й так бачить, він не секрет. Потрібен у день передачі: id особистого чату
  // власниці йде в TELEGRAM_CHAT_ID, а getUpdates, поки вебхук живий, не працює.
  if (/^\/id(@\w+)?$/i.test(text)) { await tgSendTo(env, chat, `Ваш chat id: <code>${chat}</code>`); return; }
  // Посилання з CRM «📲 Telegram»: t.me/<бот>?start=st_<код>. Раніше за все інше в /start.
  const stCode = /^\/start\s+st_(\S+)$/.exec(text);
  if (stCode) { await staffLinkStart(env, chat, msg.from, stCode[1]); return; }
  const staff = await staffByChat(env, chat, msg.from);   // null для клієнтів і для будь-якої групи
  if (staff && st && st.step === "s_photo" && (msg.photo || msg.document)) { await staffPhotoIn(env, chat, msg, st); return; }
  const cmd = (re) => re.test(text);
  if (staff) {
    if (cmd(/^\/(menu|staff)(@\w+)?$/i)) { await tgClearState(env, chat); await staffMenu(env, chat, null, staff); return; }
    if (cmd(/^\/today(@\w+)?$/i)) { await staffDay(env, chat, null, staff, isoInTz(new Date(), BUSINESS.tz)); return; }
    if (cmd(/^\/tomorrow(@\w+)?$/i)) { await staffDay(env, chat, null, staff, isoShift(isoInTz(new Date(), BUSINESS.tz), 1)); return; }
    if (cmd(/^\/week(@\w+)?$/i)) { await staffWeek(env, chat, null, staff); return; }
    if (cmd(/^\/new(@\w+)?$/i) && isAdm(staff)) { await staffNew(env, chat, null, staff); return; }
    const fq = /^\/find(?:@\w+)?(?:\s+([\s\S]+))?$/i.exec(text);
    if (fq && isAdm(staff)) { if (fq[1]) await staffFind(env, chat, staff, fq[1]); else await staffFindAsk(env, chat, null); return; }
    if (st && st.step === "s_find" && text && !text.startsWith("/")) { await staffFind(env, chat, staff, text); return; }
    if (st && st.step === "s_write" && text && !text.startsWith("/")) { await staffWrite(env, chat, staff, st, text); return; }
    if (st && st.step === "s_photo" && text && !text.startsWith("/")) { await tgSendTo(env, chat, "Чекаю на фото 📷 Коли закінчите — натисніть «✔ Готово» або /menu."); return; }
  }
  if (cmd(/^\/menu(@\w+)?$/i)) {
    const c = await clientByChat(env, chat);
    if (!c) { await askPhone(env, chat, "menu", "Щоб відкрити кабінет, поділіться номером телефону — ми знайдемо або створимо ваш профіль:"); return; }
    await clientMenu(env, chat, null, c); return;
  }
  if (/^\/book/.test(text)) { await bookingStart(env, chat); return; }
  if (/^\/cabinet/.test(text)) {
    const c = await clientByChat(env, chat);
    if (!c) { await askPhone(env, chat, "cab", "Щоб відкрити кабінет, поділіться номером телефону — ми знайдемо або створимо ваш профіль:"); return; }
    await sendCabinetLink(env, chat, c.id);
    return;
  }
  if (/^\/(visits|my)/.test(text)) {   // each upcoming visit as its own card with Перенести / Скасувати
    const c = await clientByChat(env, chat);
    if (!c) { await askPhone(env, chat, "visits", "Щоб побачити ваші візити, поділіться номером телефону:"); return; }
    await sendVisits(env, chat, c);
    return;
  }
  if (st && st.step === "breed_text" && text && !text.startsWith("/")) {   // the client typed the breed
    const n = normBreed(text), list = st.breeds || [];
    const hit = list.find(b => normBreed(b) === n) || list.find(b => normBreed(b).includes(n) || n.includes(normBreed(b)));
    await bookingAfterBreed(env, chat, st, hit || text);
    return;
  }
  if (/^\/start/.test(text)) {
    const code = text.replace(/^\/start\s*/, "").trim();
    const wantCab = code === "cab";   // deep link from the site cabinet: t.me/<bot>?start=cab
    // NB: a booking code is not proof of identity — anyone can book with someone else's phone and get the link.
    // Whoever arrives, the chat is attached only to the number Telegram itself confirms below.
    const c = await clientByChat(env, chat);
    if (staff && !code) { await tgClearState(env, chat); await staffMenu(env, chat, null, staff); return; }
    if (c) {
      if (wantCab) { await sendCabinetLink(env, chat, c.id); return; }
      await clientMenu(env, chat, null, c, `Вітаємо знову, ${tgEsc(c.name || "")} 🐾`);
      return;
    }
    await askPhone(env, chat, wantCab ? "cab" : "", `Вітаємо в ${tgEsc(salonName(env))} 🐾\nЩоб отримувати нагадування, записатися або відкрити кабінет, поділіться номером телефону:`);
    return;
  }
  if (staff) { await staffMenu(env, chat, null, staff, "Не впізнав команду 🙂 Ось ваше меню:"); return; }
  await tgSendTo(env, chat, `Я нагадую про візити в ${tgEsc(salonName(env))} і можу записати вас на грумінг — натисніть кнопку або /book.`, BOOK_BTN);
}
/* ---- Booking dialogue in the bot (/book): pet → service → breed/weight → date → time → confirm ---- */
// Per-chat dialogue state lives in tg_sessions (Telegram itself is stateless). Expires after 45 min.
async function tgGetState(env, chat) {
  const r = await env.DB.prepare(`SELECT state, updated_at FROM tg_sessions WHERE chat_id=?`).bind(chat).first();
  if (!r) return null;
  if (r.updated_at && Date.now() - Date.parse(r.updated_at) > 45 * 60000) { await tgClearState(env, chat); return null; }
  try { return JSON.parse(r.state || "{}"); } catch (e) { return null; }
}
async function tgSetState(env, chat, st) {
  await env.DB.prepare(`INSERT INTO tg_sessions (company_id,chat_id,state,updated_at) VALUES (${env.CID},?,?,?) ON CONFLICT(company_id,chat_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`)
    .bind(chat, JSON.stringify(st || {}), new Date().toISOString()).run();
}
async function tgClearState(env, chat) { await env.DB.prepare(`DELETE FROM tg_sessions WHERE chat_id=?`).bind(chat).run(); }
async function clientByChat(env, chat) { return await env.DB.prepare(`SELECT id,name,phone FROM clients WHERE tg_chat_id=?`).bind(chat).first(); }
function kb(rows) { return { reply_markup: { inline_keyboard: rows } }; }
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
const CANCEL_ROW = [{ text: "✖ Скасувати", callback_data: "b:x" }];
const DOW_UA = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

async function bookingStart(env, chat) {
  const c = await clientByChat(env, chat);
  if (!c) {   // need a phone first — the contact handler continues the dialogue
    await askPhone(env, chat, "book", "Щоб записатися, спочатку поділіться номером телефону:");
    return;
  }
  await bookingAskPet(env, chat, c);
}
async function bookingAskPet(env, chat, c) {
  const pets = (await env.DB.prepare(`SELECT id,name,species,breed,weight FROM pets WHERE client_id=? ORDER BY id`).bind(c.id).all()).results || [];
  const rows = chunk(pets.slice(0, 8).map(p => ({ text: `${p.species === "cat" ? "🐱" : "🐶"} ${p.name || "?"}`, callback_data: `b:pet:${p.id}` })), 2);
  rows.push([{ text: pets.length ? "🐶 Інший собака" : "🐶 Собака", callback_data: "b:sp:dog" }, { text: pets.length ? "🐱 Інший кіт" : "🐱 Кіт", callback_data: "b:sp:cat" }]);
  rows.push(CANCEL_ROW);
  await tgSetState(env, chat, { step: "pet" });
  await tgSendTo(env, chat, "📅 <b>Запис на грумінг</b>\nХто йде на процедуру?", kb(rows));
}
async function bookingAskService(env, chat, st) {
  const svcs = (await loadServices(env)).filter(s => s.bookable && !s.is_request && (!s.species || s.species === "both" || s.species === st.species));
  if (!svcs.length) { await tgClearState(env, chat); await tgSendTo(env, chat, "Наразі немає послуг для онлайн-запису — напишіть нам, будь ласка."); return; }
  const rows = svcs.map(s => [{ text: s.name, callback_data: `b:svc:${s.id}` }]); rows.push(CANCEL_ROW);
  st.step = "service"; await tgSetState(env, chat, st);
  await tgSendTo(env, chat, `${st.pet_name ? "🐾 " + tgEsc(st.pet_name) + "\n" : ""}Оберіть послугу:`, kb(rows));
}
async function bookingAfterService(env, chat, st, svc) {
  st.service_id = svc.id; st.service = svc.name;
  if (svc.price_type === "breed") {
    const breeds = [...new Set((svc.rows || []).map(r => r[0]).filter(Boolean))];
    if (st.species === "cat" || breeds.length <= 8) {   // short lists (and cat variants) as buttons
      st.step = "breed"; st.breeds = breeds; await tgSetState(env, chat, st);
      const rows = chunk(breeds.map((b, i) => ({ text: b, callback_data: `b:br:${i}` })), 2); rows.push(CANCEL_ROW);
      await tgSendTo(env, chat, st.species === "cat" ? "Оберіть варіант:" : "Оберіть породу:", kb(rows)); return;
    }
    st.step = "breed_text"; st.breeds = breeds; await tgSetState(env, chat, st);
    await tgSendTo(env, chat, "Напишіть породу улюбленця (наприклад, <i>Такса</i>):", kb([CANCEL_ROW])); return;
  }
  await bookingAskDate(env, chat, st, 0);
}
async function bookingAfterBreed(env, chat, st, breed) {
  st.breed = breed;
  const svc = await serviceInfo(env, st.service);
  const variants = [...new Set(((svc && svc.rows) || []).filter(r => normBreed(r[0]) === normBreed(breed)).map(r => r[1]).filter(Boolean))];
  if (variants.length > 1 && !st.weight) {
    st.step = "weight"; st.weights = variants; await tgSetState(env, chat, st);
    const rows = chunk(variants.map((w, i) => ({ text: w, callback_data: `b:w:${i}` })), 2); rows.push(CANCEL_ROW);
    await tgSendTo(env, chat, "Вага улюбленця:", kb(rows)); return;
  }
  if (variants.length === 1 && !st.weight) st.weight = variants[0];
  await bookingAskDate(env, chat, st, 0);
}
async function bookingAskDate(env, chat, st, page) {
  page = Math.max(0, Math.min(3, page || 0));
  const days = [];
  for (let i = page * 7; i < page * 7 + 7; i++) {
    const iso = isoInTz(new Date(Date.now() + i * 86400000), BUSINESS.tz);
    const [y, m, d] = iso.split("-").map(Number), dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    days.push({ text: `${DOW_UA[dow]} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`, callback_data: `b:d:${iso}` });
  }
  const rows = chunk(days, 4), nav = [];
  if (page > 0) nav.push({ text: "◀ Раніше", callback_data: `b:dp:${page - 1}` });
  if (page < 3) nav.push({ text: "Далі ▶", callback_data: `b:dp:${page + 1}` });
  if (nav.length) rows.push(nav); rows.push(CANCEL_ROW);
  st.step = "date"; st.page = page; await tgSetState(env, chat, st);
  await tgSendTo(env, chat, "Оберіть дату:", kb(rows));
}
async function bookingAskTime(env, chat, st) {
  let slots = [];
  try { slots = ((await getSlots(new URL(`https://x/slots?date=${st.date}&service=${encodeURIComponent(st.service || "")}${st.move_id ? "&exclude=" + st.move_id : ""}`), env)) || {}).slots || []; } catch (e) { }
  if (!slots.length) {
    st.step = "date"; await tgSetState(env, chat, st);
    await tgSendTo(env, chat, `На ${fmtDdMm(st.date)} вільного часу немає 😔`, kb([[{ text: "📅 Інша дата", callback_data: `b:dp:${st.page || 0}` }], CANCEL_ROW])); return;
  }
  const rows = chunk(slots.slice(0, 24).map(t => ({ text: t, callback_data: `b:t:${t}` })), 4);
  rows.push([{ text: "📅 Інша дата", callback_data: `b:dp:${st.page || 0}` }], CANCEL_ROW);
  st.step = "time"; await tgSetState(env, chat, st);
  await tgSendTo(env, chat, `${fmtDdMm(st.date)} — оберіть час:`, kb(rows));
}
async function bookingConfirm(env, chat, st) {
  const c = await clientByChat(env, chat);
  let price = null; try { price = await priceForBooking(env, { service: st.service, breed: st.breed, weight: st.weight }); } catch (e) { }
  const who = st.pet_name || (st.species === "cat" ? "Кіт" : "Собака");
  const sum = `🐾 ${tgEsc(who)}${st.breed ? " · " + tgEsc(st.breed) : ""}${st.weight ? " · " + tgEsc(st.weight) : ""}\n✂️ ${tgEsc(st.service)}\n📅 ${fmtDdMm(st.date)} о <b>${tgEsc(st.time)}</b>\n👤 ${tgEsc(c ? c.name : "")}, ${tgEsc(c ? c.phone : "")}\n💰 ${price != null ? price + " ₴" : "ціну уточнимо на місці"}`;
  st.step = "confirm"; await tgSetState(env, chat, st);
  await tgSendTo(env, chat, `Перевірте запис:\n${sum}`, kb([[{ text: "✅ Підтвердити", callback_data: "b:ok" }], [{ text: "🕐 Інший час", callback_data: "b:back:time" }, { text: "📅 Інша дата", callback_data: `b:dp:${st.page || 0}` }], CANCEL_ROW]));
}
async function bookingCreate(env, chat, st) {
  const c = await clientByChat(env, chat);
  if (!c) { await tgClearState(env, chat); await tgSendTo(env, chat, "Сесія завершилась — почнімо знову: /book"); return; }
  const res = await book({ pet: st.species === "cat" ? "Кіт" : "Собака", pet_name: st.pet_name || "", service: st.service, breed: st.breed || "", weight: st.weight || "", name: c.name, phone: c.phone, date: st.date, time: st.time, note: "" }, env, "telegram");
  if (!res || !res.ok) { await tgSendTo(env, chat, tgEsc((res && res.error) || "Не вдалося створити запис."), kb([[{ text: "🕐 Обрати інший час", callback_data: "b:back:time" }], CANCEL_ROW])); return; }
  await tgClearState(env, chat);   // book() already sent this linked client the "Запис створено" message with ✅/❌
  await tgSendTo(env, chat, "🎉 Записали! Нагадаємо напередодні та за пару годин до візиту. До зустрічі 🐾");
}
async function bookingStep(env, chat, data) {
  const a = data.split(":"), k = a[1], v = a.slice(2).join(":");
  if (k === "x") { const cur = await tgGetState(env, chat); await tgClearState(env, chat); await tgSendTo(env, chat, cur && cur.move_id ? "Добре, залишаємо запис як є 🙂" : "Добре, запис скасовано. Почати знову — /book"); return; }
  if (k === "start") { await bookingStart(env, chat); return; }
  const st = await tgGetState(env, chat);
  if (st && st.step === "contact") {   // stale button pressed while we are waiting for the phone — re-ask instead of falling into the dialogue
    await askPhone(env, chat, st.after || "", "Спочатку поділіться номером телефону — кнопка «📱 Поділитися номером» унизу 👇");
    return;
  }
  if (!st || !st.step) { await tgSendTo(env, chat, "Ця сесія завершилась — почнімо знову 🙂"); await bookingStart(env, chat); return; }
  if (k === "pet") { const p = await env.DB.prepare(`SELECT id,name,species,breed,weight FROM pets WHERE id=?`).bind(+v).first(); if (!p) return;
    Object.assign(st, { species: p.species === "cat" ? "cat" : "dog", pet_id: p.id, pet_name: p.name || "", breed: p.breed || "", weight: p.weight || "" }); await bookingAskService(env, chat, st); return; }
  if (k === "sp") { Object.assign(st, { species: v === "cat" ? "cat" : "dog", pet_id: null, pet_name: "", breed: "", weight: "" }); await bookingAskService(env, chat, st); return; }
  if (k === "svc") { const svc = (await loadServices(env)).find(s => String(s.id) === v); if (!svc) return;
    if (st.breed && svc.price_type === "breed") { st.service_id = svc.id; st.service = svc.name; await bookingAfterBreed(env, chat, st, st.breed); }
    else await bookingAfterService(env, chat, st, svc); return; }
  if (k === "br") { const b = (st.breeds || [])[+v]; if (b == null) return; await bookingAfterBreed(env, chat, st, b); return; }
  if (k === "w") { const w = (st.weights || [])[+v]; if (w == null) return; st.weight = w; await bookingAskDate(env, chat, st, 0); return; }
  if (k === "dp") { await bookingAskDate(env, chat, st, +v || 0); return; }
  if (k === "d") { st.date = v; await bookingAskTime(env, chat, st); return; }
  if (k === "t") { st.time = v; if (st.move_id) await moveConfirm(env, chat, st); else await bookingConfirm(env, chat, st); return; }
  if (k === "back" && v === "time") { await bookingAskTime(env, chat, st); return; }
  if (k === "ok") { if (st.step !== "confirm") return; if (st.move_id) await moveApply(env, chat, st); else await bookingCreate(env, chat, st); return; }
}
/* ---- Reschedule through the bot: same date/time pickers, then move the existing booking ---- */
async function moveConfirm(env, chat, st) {
  st.step = "confirm"; await tgSetState(env, chat, st);
  await tgSendTo(env, chat, `🔁 Перенести запис?\n✂️ ${tgEsc(st.service || "")}${st.pet_name ? " для " + tgEsc(st.pet_name) : ""}\nБуло: ${fmtDdMm(st.old_date)} о ${tgEsc(st.old_time || "")}\nСтане: ${fmtDdMm(st.date)} о <b>${tgEsc(st.time)}</b>`,
    kb([[{ text: "✅ Так, перенести", callback_data: "b:ok" }], [{ text: "🕐 Інший час", callback_data: "b:back:time" }, { text: "📅 Інша дата", callback_data: `b:dp:${st.page || 0}` }], [{ text: "✖ Залишити як є", callback_data: "b:x" }]]));
}
async function moveApply(env, chat, st) {
  const b = await env.DB.prepare(`SELECT ${CLIENT_COLS} FROM bookings WHERE id=?`).bind(+st.move_id).first();
  const owner = b ? await clientChatFor(env, b) : null;
  if (!b || String(owner) !== String(chat) || !["new", "confirmed"].includes(b.status) || b.is_request || !b.time) { await tgClearState(env, chat); await tgSendTo(env, chat, "Цей запис уже не можна перенести — напишіть нам, будь ласка."); return; }
  let staff = null;
  try { staff = await freeMasterAt(env, { date: st.date, time: st.time, service: b.service, prefer: b.staff, excludeEventId: b.event_id, excludeId: b.id, breed: b.breed, weight: b.weight }); } catch (e) { staff = null; }
  if (!staff) { await tgSendTo(env, chat, "На жаль, цей час щойно зайняли. Оберіть інший, будь ласка.", kb([[{ text: "🕐 Інший час", callback_data: "b:back:time" }], [{ text: "✖ Залишити як є", callback_data: "b:x" }]])); return; }
  await env.DB.prepare(`UPDATE bookings SET date=?, time=?, staff=?, remind_day_sent=0, remind_hour_sent=0 WHERE id=?`).bind(st.date, st.time, staff, b.id).run();
  try { await syncCalendar(env, b.id); } catch (e) { }
  await tgClearState(env, chat);
  const nb = Object.assign({}, b, { date: st.date, time: st.time, staff });
  try { await alertSalon(env, `🔁 <b>Клієнт переніс запис через бота</b>\nБуло: ${fmtDdMm(b.date)} о ${tgEsc(b.time)}${b.staff ? " (" + tgEsc(b.staff) + ")" : ""}\nСтало: ${visitText(nb)}\n👤 ${tgEsc(b.name || "")} — ${tgEsc(b.phone || "")}`, staffAlertButtons(b.id)); } catch (e) { }
  try { await tellMastersChange(env, b, nb); } catch (e) { }
  await tgSendTo(env, chat, `🔁 Перенесено: ${visitText(nb)}${staff !== b.staff && b.staff ? "\n(інший майстер — попередній на цей час зайнятий)" : ""}\n\nНагадаємо напередодні 🐾`, visitButtons(nb));
}

/* ======================= Кабінети в боті: власниця, адміністратор, майстер, клієнт =======================
   Бот — та сама CRM, тільки в кишені. Тому права ті самі, що в CRM і в кабінеті майстра, і рахує
   їх той самий код: статуси міняє тим же UPDATE + syncCalendar + tellClientChange, що й adminUpdate.

   ХТО Є ХТО. Клієнта бот знає за номером, який Telegram сам підтвердив («Поділитися номером»).
   Співробітника — за прив'язкою в staff_tg: у CRM (або в кабінеті майстра) людина натискає
   «📲 Telegram» і отримує одноразове посилання на 15 хвилин. Паролів у чаті немає і не буде —
   історія чату живе вічно на кожному пристрої. Власниці прив'язка не потрібна: її особистий чат
   (TELEGRAM_CHAT_ID) і так ключ до кнопок випуску і до кодів «Забули пароль?».

   ЩО ПЕРЕВІРЯЄТЬСЯ НА КОЖНОМУ НАТИСКАННІ. Роль і «активний» читаються з users щоразу, кешу немає —
   як у sessionUser. Зняла власниця галочку «активний» — наступна ж кнопка в боті нічого не відкриє.
   Лише особистий чат і та сама людина (from.id = chat id): у групі кабінет не відкривається ні в
   кого, бо кнопку там натиснув би будь-хто з учасників.

   ЧОГО В БОТІ НЕМАЄ свідомо: фінансів і зарплат (рішення власниці, 12.10), «підтримки» (розробник
   не повинен бачити клієнтів ні в CRM, ні тут), редагування прайсу, майстрів і сайту — це CRM. */
const STAFF_ROLES = ["owner", "admin", "master"];
const STAFF_COLS = CLIENT_COLS + ",pet,breed,weight,pet_id,note,price,pay_method,source";
const STAFF_LINK_TTL_MIN = 15;
const ROLE_CAB = { owner: "Кабінет власниці", admin: "Кабінет адміністратора", master: "Кабінет майстра" };
const ROLE_UA = { owner: "власниця", admin: "адміністратор", master: "майстер" };
const ST_ICON = { new: "🕐", confirmed: "✅", arrived: "🏠", in_progress: "✂️", done: "🏁", paid: "💰", no_show: "🚫", cancelled: "❌", waitlist: "⏳" };
const ST_UA = { new: "нова", confirmed: "підтверджена", arrived: "прибув", in_progress: "у роботі", done: "готово", paid: "оплачено", no_show: "не прийшов", cancelled: "скасована", waitlist: "лист очікування" };
// Короткі коди статусів для callback_data (Telegram дає 64 байти). Майстер — як у master.html: без «підтвердити».
const ST_CODE = { cf: "confirmed", ar: "arrived", ip: "in_progress", dn: "done", pd: "paid", ns: "no_show" };
const ST_BTN = { cf: "✅ Підтвердити", ar: "🏠 Прибув", ip: "✂️ У роботі", dn: "🏁 Готово", pd: "💰 Оплачено", ns: "🚫 Не прийшов" };
const PAY_UA = { cash: "💵 Готівка", card: "💳 Картка", transfer: "🔁 Переказ" };
const PET_NOTES = [["warnings", "⚠️"], ["allergies", "🌡 Алергії:"], ["behavior", "🐾 Поведінка:"], ["reactions", "💢 Реакції:"], ["vet_notes", "🩺 Вет:"], ["prefs", "💡 Побажання:"], ["client_notes", "📝 Від клієнта:"]];
const STAFF_CMDS = {
  admin: [["menu", "Кабінет: меню"], ["today", "Записи на сьогодні"], ["tomorrow", "Записи на завтра"], ["new", "Нові записи — підтвердити"], ["find", "Знайти клієнта"]],
  master: [["menu", "Мій кабінет"], ["today", "Мої записи на сьогодні"], ["tomorrow", "Мої записи на завтра"], ["week", "Мій тиждень"]],
};
const isAdm = s => s && (s.role === "owner" || s.role === "admin");
const ownerChat = (env, chat) => !!env.TELEGRAM_CHAT_ID && String(chat) === String(env.TELEGRAM_CHAT_ID);
const isoShift = (iso, days) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };
const isIso = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const cut = (v, n) => { const t = String(v == null ? "" : v).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
function dayTitle(iso) {
  if (!isIso(iso)) return "Без дати";
  const [y, m, d] = iso.split("-").map(Number), dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const today = isoInTz(new Date(), BUSINESS.tz);
  const pre = iso === today ? "Сьогодні, " : iso === isoShift(today, 1) ? "Завтра, " : iso === isoShift(today, -1) ? "Вчора, " : "";
  return `${pre}${DOW_UA[dow].toLowerCase()} ${fmtDdMm(iso)}`;
}
const petLabel = b => b.pet_name || b.pet || b.name || "—";

/* Хто пише боту. null — не співробітник (або не особистий чат). */
async function staffByChat(env, chat, from) {
  if (!(Number(chat) > 0) || !from || String(from.id) !== String(chat)) return null;
  try {
    const r = await env.DB.prepare(`SELECT u.id AS user_id, u.name, u.username, u.role, u.master_id, s.notify, m.name AS master
        FROM staff_tg s JOIN users u ON u.id=s.user_id LEFT JOIN masters m ON m.id=u.master_id
        WHERE s.chat_id=? AND u.active=1 AND u.role IN ('owner','admin','master')`).bind(chat).first();
    if (r) return r;
  } catch (e) { }   // таблиці ще немає (міграцію 0005 не накочено) — тоді кабінет є лише у власниці
  if (ownerChat(env, chat)) return { user_id: 0, name: "", username: "", role: "owner", master_id: null, notify: 1, master: null };
  return null;
}
// Майстру — лише його записи. Адміністратору й власниці — усі.
const staffSees = (s, b) => !!b && (isAdm(s) || (s.role === "master" && !!s.master && b.staff === s.master));

/* Чати персоналу для сповіщень. Чат власниці пропускаємо: усе салонне вона й так отримує через
   sendTelegram, інакше кожне повідомлення приходило б їй двічі. */
async function staffChats(env) {
  try {
    const rows = (await env.DB.prepare(`SELECT s.chat_id, s.notify, u.role, m.name AS master
        FROM staff_tg s JOIN users u ON u.id=s.user_id LEFT JOIN masters m ON m.id=u.master_id
        WHERE s.chat_id IS NOT NULL AND u.active=1 AND u.role IN ('owner','admin','master')`).all()).results || [];
    return rows.filter(r => !ownerChat(env, r.chat_id));
  } catch (e) { return []; }
}
// admins: власницям і адміністраторам; masters: [імена] — лише цим майстрам.
async function staffNotify(env, text, opts, extra) {
  const o = opts || {}, want = new Set((o.masters || []).filter(Boolean));
  if (!o.admins && !want.size) return;
  for (const r of await staffChats(env)) {
    if (!r.notify) continue;
    const hit = (o.admins && (r.role === "owner" || r.role === "admin")) || (r.role === "master" && r.master && want.has(r.master));
    if (hit) await tgSendTo(env, r.chat_id, text, extra);
  }
}
// Кнопки під сповіщенням про запис: відкрити картку і, для нової, підтвердити не відкриваючи.
function staffAlertButtons(id, canConfirm) {
  if (!id) return undefined;
  const open = { text: "🗂 Відкрити", callback_data: `s:o:${id}` };
  return kb([canConfirm ? [{ text: "✅ Підтвердити", callback_data: `s:ok:${id}` }, open] : [open]]);
}
function staffLine(b) {
  const pet = [b.pet_name ? "«" + tgEsc(b.pet_name) + "»" : tgEsc(b.pet || ""), tgEsc(b.breed || "")].filter(Boolean).join(" · ");
  return `${fmtDdMm(b.date)}${b.time ? " о <b>" + tgEsc(b.time) + "</b>" : ""} — ${tgEsc(b.service || "")}` +
    (pet ? `\n🐾 ${pet}` : "") + (b.name ? `\n👤 ${tgEsc(b.name)}` : "");
}
const MASTER_HEAD = { new: "🗓 <b>Новий запис до вас</b>", moved: "🔁 <b>Ваш запис перенесено</b>", cancelled: "❌ <b>Запис скасовано</b>", gone: "↪️ <b>Запис передано іншому майстру</b>" };
// Майстру — про його власний майбутній візит. Минулі й без майстра — мовчки.
async function tellMaster(env, kind, b, was) {
  if (!b || !b.staff || !isIso(b.date) || b.service === "Блокування") return;
  if (b.date < isoInTz(new Date(), BUSINESS.tz)) return;
  const text = `${MASTER_HEAD[kind] || MASTER_HEAD.new}\n` + (was ? `Було: ${fmtDdMm(was.date)} о ${tgEsc(was.time || "—")}\nСтало: ` : "") + staffLine(b);
  const open = (kind === "new" || kind === "moved") && b.id ? kb([[{ text: "🗂 Відкрити", callback_data: `s:o:${b.id}` }]]) : undefined;
  await staffNotify(env, text, { masters: [b.staff] }, open);
}
// Салон змінив запис (CRM, бот адміністратора, клієнт сам): хто з майстрів має про це знати.
async function tellMastersChange(env, prev, next) {
  if (!prev || !next) return;
  const on = st => ["new", "confirmed"].includes(st || "new");
  if (on(prev.status) && next.status === "cancelled") { await tellMaster(env, "cancelled", prev); return; }
  if (["cancelled", "waitlist"].includes(prev.status) && on(next.status)) { await tellMaster(env, "new", next); return; }
  if (!on(prev.status) || !on(next.status)) return;   // «прибув», «готово» тощо — це робота самого майстра
  if ((prev.staff || "") !== (next.staff || "")) { await tellMaster(env, "gone", prev); await tellMaster(env, "new", next); return; }
  if (prev.date !== next.date || prev.time !== next.time) await tellMaster(env, "moved", next, prev);
}
// Вечірній крон: кожному майстру з ботом — його завтрашній день.
async function runMasterDigest(env, tomorrow, tmr) {
  for (const r of await staffChats(env)) {
    if (r.role !== "master" || !r.master || !r.notify) continue;
    const mine = tmr.filter(b => b.staff === r.master);
    if (!mine.length) continue;
    await tgSendTo(env, r.chat_id, `🔔 <b>${dayTitle(tomorrow)}: ${supMany(mine.length, "запис", "записи", "записів")}</b>\n\n` +
      mine.map(b => `<b>${tgEsc(b.time)}</b> — ${tgEsc(petLabel(b))} · ${tgEsc(b.service || "")}`).join("\n"),
      kb([[{ text: "📋 Відкрити мій день", callback_data: `s:d:${tomorrow}` }]]));
  }
}

/* ---- Прив'язка Telegram співробітника ---- */
async function staffTgSession(request, env) {
  const s = await sessionUser(env, bearer(request));
  if (!s) { const e = new Error("unauthorized"); e.status = 401; throw e; }
  if (!STAFF_ROLES.includes(s.role)) { const e = new Error("Кабінет у боті є у власниці, адміністраторів і майстрів"); e.status = 403; throw e; }
  // Аварійний вхід (ADMIN_TOKEN) акаунта не має: прив'язувати чат нема до кого.
  if (!s.user_id) { const e = new Error("Аварійний вхід не має акаунта — увійдіть своїм логіном"); e.status = 403; throw e; }
  return s;
}
async function staffTgStatus(request, env) {
  const s = await staffTgSession(request, env);
  const bot = (await loadSettings(env)).tg_bot || "";
  let row = null;
  try { row = await env.DB.prepare(`SELECT chat_id, linked_at, notify FROM staff_tg WHERE user_id=?`).bind(s.user_id).first(); }
  catch (e) { return { ok: true, bot, ready: false, linked: false }; }
  return { ok: true, bot, ready: true, linked: !!(row && row.chat_id), linked_at: (row && row.linked_at) || "", notify: row ? (row.notify ? 1 : 0) : 1 };
}
async function staffTgLink(request, env) {
  const s = await staffTgSession(request, env);
  const bot = (await loadSettings(env)).tg_bot || "";
  if (!bot || !env.TELEGRAM_BOT_TOKEN) return { ok: false, error: "Бот салону ще не підключений: власниця натискає «Підключити бота» в CRM → 🔔 Нагадування." };
  const code = randHex(16), now = new Date();
  const exp = new Date(now.getTime() + STAFF_LINK_TTL_MIN * 6e4).toISOString();
  try {
    await env.DB.prepare(`INSERT INTO staff_tg (user_id,code_hash,code_expires,created_at) VALUES (?,?,?,?)
        ON CONFLICT(company_id,user_id) DO UPDATE SET code_hash=excluded.code_hash, code_expires=excluded.code_expires`)
      .bind(s.user_id, await sha256hex("staff-tg:" + code), exp, now.toISOString()).run();
  } catch (e) { return { ok: false, error: "У базі ще немає таблиці для Telegram співробітників — потрібна міграція 0005_staff_tg.sql." }; }
  return { ok: true, link: `https://t.me/${bot}?start=st_${code}`, ttl_min: STAFF_LINK_TTL_MIN };
}
async function staffTgUnlinkSelf(request, env) {
  const s = await staffTgSession(request, env);
  await staffTgUnlink(env, s.user_id, "Кабінет у боті відключено з CRM. Підключити знову: CRM → 📲 Telegram.");
  return { ok: true };
}
async function adminUserTgUnlink(request, env) {
  await requireOwner(request, env);
  const b = await request.json().catch(() => ({}));
  const id = Number(b && b.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "id required" };
  await staffTgUnlink(env, id, "Власниця відключила ваш Telegram від кабінету салону.");
  return { ok: true };
}
// Прибирає прив'язку і меню команд у тому чаті. Повертає true, якщо чат справді був підключений.
async function staffTgUnlink(env, userId, why) {
  let row = null;
  try {
    row = await env.DB.prepare(`SELECT chat_id FROM staff_tg WHERE user_id=?`).bind(userId).first();
    await env.DB.prepare(`DELETE FROM staff_tg WHERE user_id=?`).bind(userId).run();
  } catch (e) { return false; }
  if (!row || !row.chat_id) return false;
  try {
    if (ownerChat(env, row.chat_id)) await setStaffCommands(env, row.chat_id, "owner");   // її чат лишається кабінетом власниці
    else await tgApi(env, "deleteMyCommands", { scope: { type: "chat", chat_id: row.chat_id } });
  } catch (e) { }
  if (why) { try { await tgSendTo(env, row.chat_id, "🔌 " + tgEsc(why)); } catch (e) { } }
  return true;
}
async function setStaffCommands(env, chat, role) {
  const list = role === "master" ? STAFF_CMDS.master : STAFF_CMDS.admin;
  await tgApi(env, "setMyCommands", { scope: { type: "chat", chat_id: chat }, commands: list.map(([command, description]) => ({ command, description })) });
}
// /start st_<код> — посилання з CRM. Код одноразовий: згоряє в тому ж UPDATE, що прив'язує чат.
async function staffLinkStart(env, chat, from, code) {
  if (!(Number(chat) > 0) || !from || String(from.id) !== String(chat)) { await tgSendTo(env, chat, "Кабінет підключається лише в особистому чаті з ботом."); return; }
  const bad = "Посилання недійсне, прострочене або вже використане. Отримайте нове: CRM → 📲 Telegram (у майстрів — кабінет майстра).";
  if (!/^[0-9a-f]{32}$/.test(code)) { await tgSendTo(env, chat, bad); return; }
  const h = await sha256hex("staff-tg:" + code), now = new Date().toISOString();
  let row = null;
  try {
    row = await env.DB.prepare(`SELECT s.id, s.user_id, u.name, u.username, u.role, u.active FROM staff_tg s JOIN users u ON u.id=s.user_id
        WHERE s.code_hash=? AND s.code_expires>?`).bind(h, now).first();
  } catch (e) { row = null; }
  if (!row || !row.active || !STAFF_ROLES.includes(row.role)) { await tgSendTo(env, chat, bad); return; }
  // Один чат — один акаунт: якщо цей Telegram був кабінетом іншого співробітника, той рядок іде геть.
  await env.DB.prepare(`DELETE FROM staff_tg WHERE chat_id=? AND id<>?`).bind(chat, row.id).run();
  const u = await env.DB.prepare(`UPDATE staff_tg SET chat_id=?, code_hash=NULL, code_expires=NULL, linked_at=?, notify=COALESCE(notify,1) WHERE id=? AND code_hash=?`)
    .bind(chat, now, row.id, h).run();
  if (!(u.meta && u.meta.changes)) { await tgSendTo(env, chat, bad); return; }   // хтось устиг цим кодом раніше
  await tgClearState(env, chat);
  try { await setStaffCommands(env, chat, row.role); } catch (e) { }
  const who = row.name || row.username || "";
  if (!ownerChat(env, chat)) {
    try { await sendTelegram(env, `📲 <b>${tgEsc(who)}</b> (${ROLE_UA[row.role] || row.role}) підключив(ла) Telegram до кабінету в боті.\nВідключити: /menu → 👥 Команда або CRM → 👥 Доступи.`); } catch (e) { }
  }
  const s = await staffByChat(env, chat, from);
  if (s) await staffMenu(env, chat, null, s, `✅ Готово${who ? ", " + tgEsc(who) : ""}! Telegram підключено до вашого кабінету.`);
}

/* ---- Екрани кабінету персоналу ---- */
// Натиснули кнопку — редагуємо те саме повідомлення, щоб чат не заростав. Не вийшло — нове.
async function tgShow(env, chat, cq, text, rows) {
  const extra = { reply_markup: { inline_keyboard: rows || [] } };
  if (cq && cq.message) {
    const r = await tgApi(env, "editMessageText", Object.assign({ chat_id: chat, message_id: cq.message.message_id, text, parse_mode: "HTML", disable_web_page_preview: true }, extra));
    if (r && (r.ok || /not modified/i.test(r.description || ""))) return r;
  }
  return tgSendTo(env, chat, text, extra);
}
const MENU_ROW = [{ text: "☰ Меню", callback_data: "s:m" }];
async function staffMenu(env, chat, cq, s, note) {
  const today = isoInTz(new Date(), BUSINESS.tz), one = async (sql, ...v) => { try { return ((await env.DB.prepare(sql).bind(...v).first()) || {}).n || 0; } catch (e) { return 0; } };
  const lines = [`☰ <b>${ROLE_CAB[s.role]}</b>${s.name ? " · " + tgEsc(s.name) : ""}`];
  if (s.role === "master" && !s.master) lines.push("\n⚠️ Акаунт не прив'язаний до майстра — попросіть власницю: CRM → 👥 Доступи.");
  else {
    const mineSql = s.role === "master" ? " AND staff=?" : "", mineV = s.role === "master" ? [s.master] : [];
    const nToday = await one(`SELECT COUNT(*) AS n FROM bookings WHERE date=? AND service<>'Блокування' AND COALESCE(status,'new') NOT IN ('cancelled','waitlist')${mineSql}`, today, ...mineV);
    lines.push(`Сьогодні: ${supMany(nToday, "запис", "записи", "записів")}${s.role === "master" ? " у вас" : " у салоні"}`);
  }
  let nNew = 0;
  if (isAdm(s)) { nNew = await one(`SELECT COUNT(*) AS n FROM bookings WHERE COALESCE(status,'new')='new' AND service<>'Блокування'`); lines.push(`Непідтверджених: ${nNew}`); }
  if (note) lines.push("", note);
  const tomorrow = isoShift(today, 1), rows = [[{ text: "📋 Сьогодні", callback_data: `s:d:${today}` }, { text: "📅 Завтра", callback_data: `s:d:${tomorrow}` }]];
  if (s.role === "master") rows.push([{ text: "🗓 Мій тиждень", callback_data: "s:wk" }]);
  if (isAdm(s)) rows.push([{ text: `🆕 Нові (${nNew})`, callback_data: "s:n" }, { text: "🔎 Клієнт", callback_data: "s:f" }]);
  if (s.role === "owner") rows.push([{ text: "👥 Команда", callback_data: "s:t" }, { text: "🔧 Підтримка", callback_data: "s:sp" }], [{ text: "🩺 Стан системи", callback_data: "s:hl" }]);
  if (s.user_id && !ownerChat(env, chat)) rows.push([{ text: s.notify ? "🔔 Сповіщення увімкнені" : "🔕 Сповіщення вимкнені", callback_data: "s:nt" }]);
  if (await clientByChat(env, chat)) rows.push([{ text: "🐾 Я як клієнт", callback_data: "c:m" }]);
  await tgShow(env, chat, cq, lines.join("\n"), rows);
}
async function staffDay(env, chat, cq, s, iso) {
  const mine = s.role === "master";
  if (mine && !s.master) { await staffMenu(env, chat, cq, s); return; }
  const rows = (await env.DB.prepare(`SELECT ${STAFF_COLS} FROM bookings WHERE date=? AND service<>'Блокування'${mine ? " AND staff=?" : ""}
      ORDER BY CASE WHEN time IS NULL OR time='' THEN 1 ELSE 0 END, time`).bind(...(mine ? [iso, s.master] : [iso])).all()).results || [];
  const vis = rows.filter(b => b.status !== "cancelled"), cancelled = rows.length - vis.length;
  const lines = [`📋 <b>${dayTitle(iso)}</b>${mine ? "" : " — салон"}`];
  if (mine) {
    try {
      const m = (await loadMasters(env)).find(x => x.name === s.master), [y, mo, d] = iso.split("-").map(Number);
      if (m && !masterWorks(m, iso, new Date(Date.UTC(y, mo - 1, d)).getUTCDay())) lines.push("🌴 За графіком у вас вихідний");
    } catch (e) { }
  }
  const shown = vis.slice(0, 40);
  lines.push(...shown.map(b => `${b.time ? "<b>" + tgEsc(b.time) + "</b>" : "без часу"} ${ST_ICON[b.status || "new"] || "•"} ${tgEsc(petLabel(b))} · ${tgEsc(cut(b.service, 40))}${!mine && b.staff ? " · " + tgEsc(b.staff) : ""}`));
  if (!vis.length) lines.push("Записів немає.");
  if (vis.length > shown.length) lines.push(`… і ще ${vis.length - shown.length} — у CRM`);
  if (cancelled) lines.push(`<i>Скасовано: ${cancelled}</i>`);
  const kbRows = chunk(shown.map(b => ({ text: cut(`${b.time || "—"} ${petLabel(b)}`, 28), callback_data: `s:b:${b.id}` })), 2);
  kbRows.push([{ text: "◀ " + fmtDdMm(isoShift(iso, -1)), callback_data: `s:d:${isoShift(iso, -1)}` }, { text: fmtDdMm(isoShift(iso, 1)) + " ▶", callback_data: `s:d:${isoShift(iso, 1)}` }], MENU_ROW);
  await tgShow(env, chat, cq, lines.join("\n"), kbRows);
}
async function staffWeek(env, chat, cq, s) {
  if (s.role !== "master" || !s.master) { await staffMenu(env, chat, cq, s); return; }
  const today = isoInTz(new Date(), BUSINESS.tz);
  const rows = (await env.DB.prepare(`SELECT ${STAFF_COLS} FROM bookings WHERE staff=? AND date>=? AND date<=? AND service<>'Блокування'
      AND COALESCE(status,'new') IN ('new','confirmed','arrived','in_progress') ORDER BY date, time`).bind(s.master, today, isoShift(today, 6)).all()).results || [];
  const lines = ["🗓 <b>Мій тиждень</b>"];
  let day = "";
  for (const b of rows.slice(0, 40)) {
    if (b.date !== day) { day = b.date; lines.push("", `<b>${dayTitle(day)}</b>`); }
    lines.push(`${tgEsc(b.time || "без часу")} ${ST_ICON[b.status || "new"] || "•"} ${tgEsc(petLabel(b))} · ${tgEsc(cut(b.service, 40))}`);
  }
  if (!rows.length) lines.push("Найближчі 7 днів записів немає.");
  const kbRows = chunk(rows.slice(0, 40).map(b => ({ text: cut(`${fmtDdMm(b.date)} ${b.time || ""} ${petLabel(b)}`, 28), callback_data: `s:b:${b.id}` })), 2);
  kbRows.push(MENU_ROW);
  await tgShow(env, chat, cq, lines.join("\n"), kbRows);
}
async function staffNew(env, chat, cq, s) {
  const rows = (await env.DB.prepare(`SELECT ${STAFF_COLS} FROM bookings WHERE COALESCE(status,'new')='new' AND service<>'Блокування'
      ORDER BY CASE WHEN date IS NULL OR date='' THEN 1 ELSE 0 END, date, time LIMIT 30`).all()).results || [];
  const lines = ["🆕 <b>Непідтверджені записи</b>"].concat(rows.map(b =>
    `${isIso(b.date) ? fmtDdMm(b.date) : "без дати"}${b.time ? " <b>" + tgEsc(b.time) + "</b>" : ""} · ${tgEsc(petLabel(b))} · ${tgEsc(cut(b.service, 30))} · ${tgEsc(b.name || "")}`));
  if (!rows.length) lines.push("Усе підтверджено 👌");
  const kbRows = chunk(rows.map(b => ({ text: cut(`${isIso(b.date) ? fmtDdMm(b.date) : "—"} ${b.time || ""} ${petLabel(b)}`, 28), callback_data: `s:b:${b.id}` })), 2);
  kbRows.push(MENU_ROW);
  await tgShow(env, chat, cq, lines.join("\n"), kbRows);
}
// Картка запису. opts.note — рядок-підтвердження зверху («✅ Статус: готово»), opts.ready — клієнту вже сказали «готовий».
async function staffCard(env, chat, cq, s, id, opts) {
  const o = opts || {};
  const b = await env.DB.prepare(`SELECT ${STAFF_COLS} FROM bookings WHERE id=?`).bind(id).first();
  if (!staffSees(s, b)) { await tgShow(env, chat, cq, "Запис не знайдено або він не ваш.", [MENU_ROW]); return; }
  const pet = b.pet_id ? await env.DB.prepare(`SELECT name,species,breed,weight,special,${PET_NOTES.map(x => x[0]).join(",")} FROM pets WHERE id=?`).bind(b.pet_id).first() : null;
  const st = b.status || "new", L = [];
  if (o.note) L.push(o.note, "");
  L.push(`${ST_ICON[st] || "•"} <b>${dayTitle(b.date)}</b>${b.time ? " о <b>" + tgEsc(b.time) + "</b>" : ""}${b.duration ? " · " + b.duration + " хв" : ""}`);
  L.push(`✂️ ${tgEsc(b.service || "—")}${Number(b.price) > 0 ? " · " + Math.round(b.price) + " ₴" : ""}`);
  const petTxt = [b.pet_name ? "«" + b.pet_name + "»" : "", b.pet, b.breed, b.weight].filter(Boolean).map(tgEsc).join(" · ");
  if (petTxt) L.push(`${(pet && pet.species === "cat") || /кіт|кот/i.test(b.pet || "") ? "🐱" : "🐶"} ${petTxt}`);
  if (s.role !== "master") L.push(`👩‍🔧 ${b.staff ? tgEsc(b.staff) : "<i>майстра не призначено</i>"}`);
  L.push(`👤 ${tgEsc(b.name || "—")}${b.phone ? " — " + tgEsc(b.phone) : ""}`);
  if (b.note) L.push(`💬 ${tgEsc(cut(b.note, 300))}`);
  if (pet) {
    if (pet.special) L.push("⭐ <b>Особлива увага</b>");
    for (const [f, lbl] of PET_NOTES) if (pet[f]) L.push(`${lbl} ${tgEsc(cut(pet[f], 300))}`);
  }
  L.push(`Статус: <b>${tgEsc(ST_UA[st] || st)}</b>${b.pay_method && PAY_UA[b.pay_method] ? " · " + PAY_UA[b.pay_method] : ""}`);
  if (o.ready) L.push(`📣 ${o.ready}`);
  const rows = [];
  if (st !== "cancelled" && st !== "waitlist") {
    const codes = (isAdm(s) && st === "new" ? ["cf"] : []).concat(["ar", "ip", "dn", "pd", "ns"]);
    const btn = c => ({ text: (ST_CODE[c] === st ? "• " : "") + ST_BTN[c], callback_data: `s:st:${b.id}:${c}` });
    rows.push(...chunk(codes.map(btn), 2));
  }
  if (isAdm(s) && st === "paid") rows.push(Object.keys(PAY_UA).map(k => ({ text: (b.pay_method === k ? "• " : "") + PAY_UA[k], callback_data: `s:pm:${b.id}:${k}` })));
  if (b.pet_id && st !== "cancelled") rows.push([{ text: "📷 Фото «До»", callback_data: `s:ph:${b.id}:b` }, { text: "📷 Фото «Після»", callback_data: `s:ph:${b.id}:a` }]);
  if (!o.ready && ["in_progress", "done"].includes(st) && await clientChatFor(env, b)) rows.push([{ text: `📣 Клієнту: «${cut(b.pet_name || "улюбленець", 14)} готовий»`, callback_data: `s:rd:${b.id}` }]);
  if (isAdm(s) && ["new", "confirmed"].includes(st)) rows.push([{ text: "❌ Скасувати запис", callback_data: `s:bx:${b.id}` }]);
  if (isAdm(s) && b.client_id) rows.push([{ text: "👤 Картка клієнта", callback_data: `s:c:${b.client_id}` }]);
  rows.push(isIso(b.date) ? [{ text: "◀ " + fmtDdMm(b.date), callback_data: `s:d:${b.date}` }, MENU_ROW[0]] : MENU_ROW);
  await tgShow(env, chat, cq, L.join("\n"), rows);
}
// Статус з бота — той самий шлях, що в CRM: запис, календар, повідомлення клієнту, майстру.
async function staffSetStatus(env, b, status) {
  if ((b.status || "new") === status) return;
  await env.DB.prepare(`UPDATE bookings SET status=? WHERE id=?`).bind(status, b.id).run();
  try { await syncCalendar(env, b.id); } catch (e) { }
  await tellClientChange(env, b.id, b, { status }, false);
  try { await tellMastersChange(env, b, Object.assign({}, b, { status })); } catch (e) { }
}
async function staffFindAsk(env, chat, cq) {
  await tgSetState(env, chat, { step: "s_find" });
  await tgShow(env, chat, cq, "🔎 Напишіть номер телефону (досить 4+ останніх цифр), ім'я клієнта або кличку улюбленця:", [MENU_ROW]);
}
async function staffFind(env, chat, s, text) {
  const q = String(text || "").trim().slice(0, 60), digits = q.replace(/\D/g, ""), low = q.toLowerCase();
  const cs = (await env.DB.prepare(`SELECT id,name,phone,tg_chat_id FROM clients`).all()).results || [];
  let hits = [];
  if (digits.length >= 4) {
    const nd = digits.length >= 9 ? normPhone(digits) : digits;
    hits = cs.filter(c => normPhone(c.phone).includes(nd));
  } else if (low.length >= 2) {
    const byPet = new Set((((await env.DB.prepare(`SELECT client_id,name FROM pets`).all()).results) || []).filter(p => String(p.name || "").toLowerCase().includes(low)).map(p => p.client_id));
    hits = cs.filter(c => String(c.name || "").toLowerCase().includes(low) || byPet.has(c.id));
  } else { await tgSendTo(env, chat, "Замало для пошуку — щонайменше 2 літери або 4 цифри.", kb([MENU_ROW])); return; }
  await tgSetState(env, chat, { step: "s_find" });   // наступне повідомлення — уточнений пошук
  if (hits.length === 1) { await staffClient(env, chat, null, s, hits[0].id); return; }
  if (!hits.length) { await tgSendTo(env, chat, `Нікого не знайдено за «${tgEsc(q)}». Спробуйте інакше або ☰ Меню.`, kb([MENU_ROW])); return; }
  hits.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "uk"));
  const rows = hits.slice(0, 10).map(c => [{ text: cut(`${c.name || "—"} · ${String(c.phone || "").slice(-4)}${c.tg_chat_id ? " · ✈" : ""}`, 40), callback_data: `s:c:${c.id}` }]);
  rows.push(MENU_ROW);
  await tgSendTo(env, chat, `Знайдено: ${hits.length}${hits.length > 10 ? " (показую 10 — уточніть)" : ""}`, kb(rows));
}
async function staffClient(env, chat, cq, s, id) {
  const c = await env.DB.prepare(`SELECT * FROM clients WHERE id=?`).bind(id).first();
  if (!c) { await tgShow(env, chat, cq, "Клієнта не знайдено.", [MENU_ROW]); return; }
  const pets = (await env.DB.prepare(`SELECT name,species,breed,weight,special,warnings,allergies FROM pets WHERE client_id=? ORDER BY id`).bind(c.id).all()).results || [];
  const bks = await clientBookings(env, c), today = isoInTz(new Date(), BUSINESS.tz);
  const done = bks.filter(b => b.status === "done" || b.status === "paid");
  const up = bks.filter(b => isIso(b.date) && b.date >= today && ["new", "confirmed", "arrived", "in_progress"].includes(b.status || "new"))
    .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  const L = [`👤 <b>${tgEsc(c.name || "—")}</b>`, `📞 ${tgEsc(c.phone || "—")} · ${c.tg_chat_id ? "Telegram ✅" : "без Telegram"}`];
  if (c.note) L.push(`📝 ${tgEsc(cut(c.note, 300))}`);
  if (pets.length) L.push("", ...pets.slice(0, 8).map(p => `${p.species === "cat" ? "🐱" : "🐶"} <b>${tgEsc(p.name || "—")}</b>${p.breed ? " — " + tgEsc(p.breed) : ""}${p.weight ? ", " + tgEsc(p.weight) : ""}${p.special ? " ⭐" : ""}` +
    (p.warnings ? `\n   ⚠️ ${tgEsc(cut(p.warnings, 150))}` : "") + (p.allergies ? `\n   🌡 ${tgEsc(cut(p.allergies, 150))}` : "")),
    ...(pets.length > 8 ? [`… і ще ${pets.length - 8} — у CRM`] : []));   // повідомлення Telegram — до 4096 знаків
  L.push("", `Візитів: ${done.length}${done.length ? ", останній " + fmtDdMm(done[0].date) + "." + String(done[0].date || "").slice(0, 4) : ""}`);
  if (up.length) L.push("Попереду:", ...up.slice(0, 6).map(b => `• ${fmtDdMm(b.date)} ${tgEsc(b.time || "")} — ${tgEsc(cut(b.service, 40))}${b.staff ? " · " + tgEsc(b.staff) : ""}`));
  const rows = chunk(up.slice(0, 6).map(b => ({ text: cut(`${fmtDdMm(b.date)} ${b.time || ""} ${b.pet_name || b.service || ""}`, 28), callback_data: `s:b:${b.id}` })), 2);
  if (c.tg_chat_id) rows.push([{ text: "✉️ Написати клієнту", callback_data: `s:w:${c.id}` }]);
  rows.push([{ text: "🔎 Новий пошук", callback_data: "s:f" }, MENU_ROW[0]]);
  await tgShow(env, chat, cq, L.join("\n"), rows);
}
async function staffWrite(env, chat, s, st, text) {
  await tgClearState(env, chat);
  const c = isAdm(s) ? await env.DB.prepare(`SELECT id,name,tg_chat_id FROM clients WHERE id=?`).bind(+st.client_id || 0).first() : null;
  if (!c || !c.tg_chat_id) { await tgSendTo(env, chat, "Клієнт недоступний — повідомлення не надіслано.", kb([MENU_ROW])); return; }
  const msg = String(text || "").trim().slice(0, 1500);
  // Власниця пише зі свого ж чату — копія «хто що написав» їй самій ні до чого.
  const r = ownerChat(env, chat) ? await tgSendTo(env, c.tg_chat_id, `💬 <b>${tgEsc(salonName(env))}</b>\n${tgEsc(msg)}`).then(x => x && x.ok ? { ok: true } : { ok: false, error: "Telegram не прийняв повідомлення" })
    : await sendClientMessage(env, s.name || s.username || ROLE_UA[s.role], c.tg_chat_id, c.name || "", msg);
  await tgSendTo(env, chat, r.ok ? `✅ Надіслано: ${tgEsc(c.name || "клієнту")}` : `⚠️ ${tgEsc(r.error || "Не вдалося надіслати")}`,
    kb([[{ text: "👤 Картка клієнта", callback_data: `s:c:${c.id}` }, MENU_ROW[0]]]));
}
async function staffTeam(env, chat, cq, note) {
  let rows = [];
  try {
    rows = (await env.DB.prepare(`SELECT u.id,u.name,u.username,u.role,u.active,s.chat_id,s.linked_at FROM users u LEFT JOIN staff_tg s ON s.user_id=u.id
        WHERE u.role IN ('owner','admin','master') ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name`).all()).results || [];
  } catch (e) { await tgShow(env, chat, cq, "👥 У базі ще немає таблиці staff_tg — потрібна міграція 0005_staff_tg.sql.", [MENU_ROW]); return; }
  const L = [];
  if (note) L.push(note, "");
  L.push("👥 <b>Команда в боті</b>", ...rows.map(u => `${u.chat_id ? "📲" : "▫️"} <b>${tgEsc(u.name || u.username || "—")}</b> — ${ROLE_UA[u.role] || u.role}${u.active ? "" : " (вимкнено)"}${u.chat_id ? " · з " + fmtKyiv(u.linked_at) : ""}`));
  L.push("", "Підключає співробітник сам: CRM → 📲 Telegram, майстер — у кабінеті майстра. Відключити — кнопкою нижче або в CRM → 👥 Доступи.");
  const kbRows = rows.filter(u => u.chat_id).map(u => [{ text: "🔌 Відключити: " + cut(u.name || u.username || "?", 24), callback_data: `s:tu:${u.id}` }]);
  kbRows.push(MENU_ROW);
  await tgShow(env, chat, cq, L.join("\n"), kbRows);
}
async function staffSupport(env, chat, cq, note) {
  const st = await supportState(env), L = [];
  if (note) L.push(note, "");
  L.push("🔧 <b>Доступ для підтримки</b>", st.open ? `🔓 Відкрито до ${fmtKyiv(st.until)}${st.prices ? " · з правом правити ціни" : ""}` : "🔒 Закрито");
  if (st.log.length) L.push("", "Останнє в журналі:", ...st.log.slice(0, 5).map(r => `• ${fmtKyiv(r.at)} · ${tgEsc(r.who)}: ${tgEsc(cut(r.act, 120))}`));
  const rows = st.open ? [[{ text: "🔒 Закрити доступ зараз", callback_data: "s:sx" }]]
    : [[{ text: "🔓 На 8 год", callback_data: "s:so:8" }, { text: "🔓 На 24 год", callback_data: "s:so:24" }], [{ text: "🔓 8 год + право правити ціни", callback_data: "s:so:8p" }]];
  rows.push(MENU_ROW);
  await tgShow(env, chat, cq, L.join("\n"), rows);
}
async function staffHealth(env, chat, cq) {
  const h = await health(env, env.ORIGIN || "");
  const yes = v => v ? "✅" : "—";
  const L = [`🩺 <b>Стан системи</b> — ${h.ok ? "✅ усе гаразд" : "⚠️ є що перевірити"}`, `Версія: ${tgEsc(h.version)} · ${tgEsc(h.build)}`];
  L.push(`База: ${h.db ? "⚠️ " + tgEsc(h.db) : (h.tables || 0) + " таблиць" + (h.missing_tables ? " · ⚠️ немає: " + tgEsc(h.missing_tables.join(", ")) : " ✅")}`);
  if (h.counts) L.push(`Записів попереду: ${h.upcoming || 0} · нових за добу: ${h.booked_last_24h || 0}`);
  L.push(`Календар Google: ${yes(h.calendar)}`);
  if (h.bot) L.push(`Бот: ${h.bot.ok ? "✅ @" + tgEsc(h.bot.username) : "⚠️ " + tgEsc(h.bot.problem || "")}`);
  const lb = h.last_backup;
  L.push(`Резервна копія: ${lb && lb.day ? "✅ " + tgEsc(lb.day) + " · " + (lb.rows || 0) + " рядків" : h.backups ? "⚠️ ще не було" : "— (немає бакета)"}`);
  if (h.warn) L.push(`⚠️ ${tgEsc(h.warn)}`);
  await tgShow(env, chat, cq, L.join("\n"), [[{ text: "🔄 Оновити", callback_data: "s:hl" }], MENU_ROW]);
}
async function staffPhotoAsk(env, chat, s, b, kind) {
  await tgSetState(env, chat, { step: "s_photo", booking_id: b.id, kind });
  await tgSendTo(env, chat, `📷 Надішліть фото «${kind === "after" ? "Після" : "До"}» для ${tgEsc(petLabel(b))} — одне чи кілька, звичайним фото. Фото потрапить у картку улюбленця.`,
    kb([[{ text: "✔ Готово", callback_data: `s:px:${b.id}` }]]));
}
// Telegram сам тримає кілька розмірів фото: беремо найбільший до 1600 px і копію ≥ 480 px по короткій
// стороні для сіток — так само, як браузер у CRM робить велике фото й мініатюру.
async function tgFileBytes(env, fileId, max) {
  const f = await tgApi(env, "getFile", { file_id: fileId });
  const path = f && f.ok && f.result && f.result.file_path;
  if (!path || (f.result.file_size && f.result.file_size > max)) return null;
  try {
    const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
    if (!r.ok) return null;
    const bin = new Uint8Array(await r.arrayBuffer());
    return bin.length && bin.length <= max ? bin : null;
  } catch (e) { return null; }
}
async function staffPhotoIn(env, chat, msg, st) {
  const s = await staffByChat(env, chat, msg.from);
  const b = s && st.booking_id ? await env.DB.prepare(`SELECT ${STAFF_COLS} FROM bookings WHERE id=?`).bind(+st.booking_id).first() : null;
  if (!staffSees(s, b) || !b.pet_id) { await tgClearState(env, chat); await tgSendTo(env, chat, "Цей запис більше недоступний — фото не збережено."); return; }
  const max = photoBucket(env) ? PHOTO_MAX_R2 : PHOTO_MAX_D1;
  let main = null, small = null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const sizes = msg.photo.slice().sort((x, y) => x.width * x.height - y.width * y.height);
    main = sizes.filter(p => Math.max(p.width, p.height) <= 1600).pop() || sizes[0];
    small = sizes.find(p => Math.min(p.width, p.height) >= 480 && p.file_id !== main.file_id && p.width * p.height < main.width * main.height) || null;
  } else if (msg.document && /^image\/(jpeg|png|webp)$/.test(msg.document.mime_type || "")) main = msg.document;
  if (!main) { await tgSendTo(env, chat, "Потрібне фото (JPEG, PNG або WebP). Надішліть його звичайним фото, не файлом іншого формату."); return; }
  const bin = await tgFileBytes(env, main.file_id, max);
  const mime = bin && sniffImage(bin);
  if (!mime) { await tgSendTo(env, chat, bin ? "Файл не схожий на фото JPEG / PNG / WebP." : "Не вдалося отримати фото з Telegram (завелике або збій) — спробуйте ще раз."); return; }
  let thumb = null;
  if (small && photoBucket(env)) { const t = await tgFileBytes(env, small.file_id, PHOTO_THUMB_MAX), tm = t && sniffImage(t); if (tm) thumb = { mime: tm, bin: t }; }
  const kind = st.kind === "after" ? "after" : "before";
  const r = await savePetPhotoBytes(env, env.ORIGIN || "", { pet_id: b.pet_id, booking_id: b.id, kind, mime, bin, thumb });
  await tgSetState(env, chat, st);   // ще 45 хвилин на наступні фото
  await tgSendTo(env, chat, r && r.ok ? `✅ Фото «${kind === "after" ? "Після" : "До"}» додано до картки ${tgEsc(petLabel(b))}.` : `⚠️ ${tgEsc((r && r.error) || "Не вдалося зберегти фото")}`);
}
async function staffCallback(env, cq, chat) {
  let toast = "";
  try {
    const s = await staffByChat(env, chat, cq.from);
    if (!s) { toast = "Кабінет недоступний. Підключіть Telegram у CRM → 📲 Telegram."; return; }
    const a = cq.data.split(":"), k = a[1], id = +a[2] || 0;
    const need = (ok, msg) => { if (!ok) toast = msg || "Недоступно для вашої ролі"; return ok; };
    const st = await tgGetState(env, chat);
    if (st && /^s_/.test(st.step || "") && !["ph", "px"].includes(k)) await tgClearState(env, chat);   // будь-яка кнопка закриває пошук / лист / фото
    if (k === "m") { await staffMenu(env, chat, cq, s); return; }
    if (k === "d") { if (isIso(a[2])) await staffDay(env, chat, cq, s, a[2]); return; }
    if (k === "wk") { await staffWeek(env, chat, cq, s); return; }
    if (k === "n") { if (need(isAdm(s))) await staffNew(env, chat, cq, s); return; }
    if (k === "b") { await staffCard(env, chat, cq, s, id); return; }
    if (k === "o") { await staffCard(env, chat, null, s, id); return; }   // зі сповіщення — новим повідомленням, сповіщення лишається
    if (k === "f") { if (need(isAdm(s))) await staffFindAsk(env, chat, cq); return; }
    if (k === "c") { if (need(isAdm(s))) await staffClient(env, chat, cq, s, id); return; }
    if (k === "t") { if (need(s.role === "owner")) await staffTeam(env, chat, cq); return; }
    if (k === "sp") { if (need(s.role === "owner")) await staffSupport(env, chat, cq); return; }
    if (k === "hl") { if (need(s.role === "owner")) await staffHealth(env, chat, cq); return; }
    if (k === "nt") {
      if (!s.user_id) return;
      await env.DB.prepare(`UPDATE staff_tg SET notify=CASE WHEN COALESCE(notify,1)=1 THEN 0 ELSE 1 END WHERE user_id=?`).bind(s.user_id).run();
      const s2 = await staffByChat(env, chat, cq.from); if (s2) await staffMenu(env, chat, cq, s2);
      toast = s2 && s2.notify ? "Сповіщення увімкнено" : "Сповіщення вимкнено"; return;
    }
    if (k === "tu" || k === "ty") {
      if (!need(s.role === "owner")) return;
      const u = await env.DB.prepare(`SELECT id,name,username FROM users WHERE id=?`).bind(id).first();
      if (!u) { await staffTeam(env, chat, cq); return; }
      if (k === "tu") { await tgShow(env, chat, cq, `🔌 Відключити Telegram <b>${tgEsc(u.name || u.username)}</b> від кабінету в боті? Акаунт у CRM лишається, підключити знову можна з CRM.`,
        [[{ text: "Так, відключити", callback_data: `s:ty:${id}` }, { text: "◀ Ні", callback_data: "s:t" }]]); return; }
      const was = await staffTgUnlink(env, id, "Власниця відключила ваш Telegram від кабінету салону.");
      await staffTeam(env, chat, cq, was ? `🔌 ${tgEsc(u.name || u.username)} відключено.` : "Цей Telegram уже не був підключений.");
      return;
    }
    if (k === "so" || k === "sx") {
      if (!need(s.role === "owner")) return;
      if (k === "sx") { await supportCloseDo(env); toast = "Доступ закрито"; await staffSupport(env, chat, cq, "🔒 Доступ закрито, сесії підтримки завершено."); return; }
      const v = String(a[2] || ""), hours = parseInt(v, 10) === 24 ? 24 : 8;
      await supportOpenDo(env, hours, /p$/.test(v));
      toast = "Доступ відкрито"; await staffSupport(env, chat, cq); return;
    }
    if (k === "w") {   // написати клієнту від імені салону
      if (!need(isAdm(s))) return;
      const c = await env.DB.prepare(`SELECT id,name,tg_chat_id FROM clients WHERE id=?`).bind(id).first();
      if (!c || !c.tg_chat_id) { toast = "Клієнт не підключив бота"; return; }
      await tgSetState(env, chat, { step: "s_write", client_id: c.id });
      await tgShow(env, chat, cq, `✉️ Напишіть повідомлення для <b>${tgEsc(c.name || "клієнта")}</b> — надішлю від імені салону.${ownerChat(env, chat) ? "" : " Власниця бачить кожне таке повідомлення."}`,
        [[{ text: "✖ Не надсилати", callback_data: `s:c:${c.id}` }]]);
      return;
    }
    // Далі — дії над конкретним записом.
    const b = id ? await env.DB.prepare(`SELECT ${STAFF_COLS} FROM bookings WHERE id=?`).bind(id).first() : null;
    if (!staffSees(s, b)) { toast = "Запис не знайдено або він не ваш"; return; }
    if (k === "st") {
      const status = ST_CODE[a[3]];
      if (!status || (a[3] === "cf" && !isAdm(s))) { toast = "Недоступно"; return; }
      if (["cancelled", "waitlist"].includes(b.status)) { toast = "Цей запис не можна змінити з бота — відкрийте CRM"; await staffCard(env, chat, cq, s, id); return; }
      await staffSetStatus(env, b, status);
      toast = "Статус: " + ST_UA[status];
      await staffCard(env, chat, cq, s, id); return;
    }
    if (k === "ok") {   // «✅ Підтвердити» прямо під сповіщенням про новий запис
      if (!need(isAdm(s))) return;
      if ((b.status || "new") === "new") { await staffSetStatus(env, b, "confirmed"); toast = "Підтверджено"; } else toast = "Уже: " + (ST_UA[b.status] || b.status);
      await tgApi(env, "editMessageReplyMarkup", { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: `${ST_ICON[(b.status || "new") === "new" ? "confirmed" : b.status] || "•"} ${(b.status || "new") === "new" ? "Підтверджено" : ST_UA[b.status] || ""} · відкрити`, callback_data: `s:o:${id}` }]] } });
      return;
    }
    if (k === "bx") { if (!need(isAdm(s))) return;
      await tgShow(env, chat, cq, `❌ Скасувати запис?\n${staffLine(b)}\n\nКлієнт отримає повідомлення в Telegram (якщо бот у нього підключений), майстер — теж.`,
        [[{ text: "Так, скасувати", callback_data: `s:by:${id}` }, { text: "◀ Ні", callback_data: `s:b:${id}` }]]); return; }
    if (k === "by") { if (!need(isAdm(s))) return;
      if (["new", "confirmed"].includes(b.status || "new")) { await staffSetStatus(env, b, "cancelled"); toast = "Запис скасовано"; }
      await staffCard(env, chat, cq, s, id, { note: "❌ Запис скасовано." }); return; }
    if (k === "pm") { if (!need(isAdm(s)) || !PAY_UA[a[3]]) return;
      await env.DB.prepare(`UPDATE bookings SET pay_method=? WHERE id=?`).bind(a[3], id).run();
      toast = PAY_UA[a[3]]; await staffCard(env, chat, cq, s, id); return; }
    if (k === "ph") { if (!b.pet_id) { toast = "У записі немає картки улюбленця — створіть її в CRM"; return; } await staffPhotoAsk(env, chat, s, b, a[3] === "a" ? "after" : "before"); return; }
    if (k === "px") { await tgClearState(env, chat); toast = "Готово"; await tgApi(env, "editMessageReplyMarkup", { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }); await staffCard(env, chat, null, s, id); return; }
    if (k === "rd") {
      const cc = await clientChatFor(env, b);
      if (!cc) { toast = "Клієнт не підключив бота"; return; }
      const r = await tgSendTo(env, cc, `🐾 <b>${tgEsc(b.pet_name || "Ваш улюбленець")}</b> готовий — можна забирати!\nЧекаємо вас у ${tgEsc(salonName(env))} 💜`);
      toast = r && r.ok ? "Надіслано клієнту" : "Telegram не прийняв повідомлення";
      if (r && r.ok) await staffCard(env, chat, cq, s, id, { ready: `Клієнту надіслано «готовий» о ${hhmm(kyivNow().min)}` });
      return;
    }
  } catch (e) {
    console.error(`telegram staff: ${errText(e)}`);
    toast = "Щось пішло не так — спробуйте ще раз";
  } finally {
    try { await tgApi(env, "answerCallbackQuery", toast ? { callback_query_id: cq.id, text: toast } : { callback_query_id: cq.id }); } catch (e) { }
  }
}

/* ---- Кабінет клієнта в боті ---- */
async function clientMenu(env, chat, cq, c, note) {
  const st = await loadSettings(env);
  const L = [];
  if (note) L.push(note);
  L.push(`🐾 <b>${tgEsc(c.name || "Ваш кабінет")}</b>${await nextVisitsText(env, c.id) || "\n\nНайближчих візитів немає."}`);
  const rows = [[{ text: "📅 Записатися", callback_data: "b:start" }, { text: "🗓 Мої візити", callback_data: "c:v" }],
    [{ text: "🐶 Улюбленці", callback_data: "c:p" }, { text: "📜 Історія", callback_data: "c:h" }]];
  rows.push(st.loyalty_enabled === "1" ? [{ text: "🎁 Бонуси", callback_data: "c:l" }, { text: "🔑 Кабінет на сайті", callback_data: "cab" }] : [{ text: "🔑 Кабінет на сайті", callback_data: "cab" }]);
  if (/^https:\/\//.test(siteUrl(env))) rows.push([{ text: "⭐ Залишити відгук", url: siteUrl(env) + "review.html" }]);
  await tgShow(env, chat, cq, L.join("\n"), rows);
}
async function clientCallback(env, cq, chat) {
  try { await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id }); } catch (e) { }
  const c = await clientByChat(env, chat);
  if (!c) { await askPhone(env, chat, "menu", "Щоб відкрити кабінет, поділіться номером телефону — ми знайдемо або створимо ваш профіль:"); return; }
  const k = cq.data.slice(2), back = [{ text: "◀ Меню", callback_data: "c:m" }];
  if (k === "m") { await clientMenu(env, chat, cq, c); return; }
  if (k === "v") { await sendVisits(env, chat, c); return; }
  const full = await env.DB.prepare(`SELECT * FROM clients WHERE id=?`).bind(c.id).first();
  const bks = await clientBookings(env, full || c), done = bks.filter(b => b.status === "done" || b.status === "paid");
  if (k === "p") {
    const pets = (await env.DB.prepare(`SELECT id,name,species,breed,weight FROM pets WHERE client_id=? ORDER BY id`).bind(c.id).all()).results || [];
    const n = {};
    try { ((await env.DB.prepare(`SELECT pet_id, COUNT(*) AS n FROM pet_photos WHERE pet_id IN (SELECT id FROM pets WHERE client_id=?) GROUP BY pet_id`).bind(c.id).all()).results || []).forEach(r => { n[r.pet_id] = r.n; }); } catch (e) { }
    const L = ["🐶 <b>Ваші улюбленці</b>"].concat(pets.map(p => {
      const last = done.find(b => String(b.pet_name || "").trim().toLowerCase() === String(p.name || "").trim().toLowerCase());
      return `${p.species === "cat" ? "🐱" : "🐶"} <b>${tgEsc(p.name || "—")}</b>${p.breed ? " — " + tgEsc(p.breed) : ""}${p.weight ? ", " + tgEsc(p.weight) : ""}` +
        (n[p.id] ? ` · 📷 ${n[p.id]}` : "") + (last ? `\n   останній грумінг ${fmtDdMm(last.date)}` : "");
    }));
    if (!pets.length) L.push("Поки що порожньо — улюбленець з'явиться після першого запису.");
    L.push("", "Змінити дані чи додати фото — у кабінеті на сайті.");
    await tgShow(env, chat, cq, L.join("\n"), [[{ text: "🔑 Кабінет на сайті", callback_data: "cab" }], back]); return;
  }
  if (k === "h") {
    const L = ["📜 <b>Історія візитів</b>"].concat(done.slice(0, 10).map(b => `• ${fmtDdMm(b.date)}.${String(b.date || "").slice(2, 4)} — ${tgEsc(b.service || "")}${b.pet_name ? " · " + tgEsc(b.pet_name) : ""}${b.staff ? " · " + tgEsc(b.staff) : ""}`));
    if (!done.length) L.push("Завершених візитів ще немає.");
    else if (done.length > 10) L.push(`… усього ${done.length}. Повна історія — у кабінеті на сайті.`);
    await tgShow(env, chat, cq, L.join("\n"), [back]); return;
  }
  if (k === "l") {   // той самий розрахунок, що в clientMe — картка в кабінеті і в боті мусять збігатися
    const st = await loadSettings(env);
    if (st.loyalty_enabled !== "1") { await tgShow(env, chat, cq, "🎁 Бонусна програма зараз не діє.", [back]); return; }
    const every = Math.max(2, parseInt(st.loyalty_every, 10) || 6), filled = done.length % every, bonusNow = filled === every - 1;
    const reward = st.loyalty_reward || "приємний бонус";
    const bar = "●".repeat(filled) + "○".repeat(Math.max(0, every - 1 - filled)) + " 🎁";
    const L = ["🎁 <b>Бонусна картка</b>", bar, `Кожен ${every}-й візит: ${tgEsc(reward)}.`, "",
      bonusNow ? `🎉 Наступний візит — з бонусом!` : `До бонусу: ще ${supMany(every - 1 - filled, "візит", "візити", "візитів")}.`, `Усього завершених візитів: ${done.length}.`];
    await tgShow(env, chat, cq, L.join("\n"), [back]); return;
  }
}

async function tgWebhook(request, env) {
  if ((request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "") !== await tgWebhookSecret(env)) {
    // Секрет виводиться з токена: після зміни токена він не збігається, доки власниця не натисне
    // «Підключити бота». Інших легальних причин для цього рядка в логах немає.
    console.warn("telegram webhook: чужий секрет — токен змінено, а «Підключити бота» не натиснуто (або запит не від Telegram)");
    const e = new Error("forbidden"); e.status = 403; throw e;
  }
  const update = await request.json().catch(() => null);
  // Адреса воркера — для «🩺 Стан системи» і посилань на фото з кабінету в боті.
  try { await handleTgUpdate(Object.assign({}, env, { ORIGIN: new URL(request.url).origin }), update); } catch (e) { console.error(`telegram update: ${errText(e)}`); }
  return { ok: true };
}
async function tgSetup(request, env) { // owner: remember the bot username and register the webhook
  await requireOwner(request, env);
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN не задано" };
  const me = await tgApi(env, "getMe", {});
  const username = me && me.ok && me.result ? me.result.username : "";
  if (!username) return { ok: false, error: "Telegram не відповів: " + (me && me.description || "getMe failed") };
  await env.DB.prepare(`INSERT INTO settings (company_id,key,value) VALUES (${env.CID},'tg_bot',?) ON CONFLICT(company_id,key) DO UPDATE SET value=?`).bind(username, username).run();
  const url = new URL(request.url).origin + "/tg/webhook/" + (env.CID || DEFAULT_COMPANY_ID);
  const wh = await tgApi(env, "setWebhook", { url, secret_token: await tgWebhookSecret(env), allowed_updates: ["message", "callback_query"] });
  try { await tgApi(env, "setMyCommands", { commands: [{ command: "menu", description: "Меню: візити, улюбленці, бонуси" }, { command: "book", description: "Записатися на грумінг" }, { command: "visits", description: "Мої візити — перенести чи скасувати" }, { command: "cabinet", description: "Мій кабінет на сайті" }, { command: "start", description: "Підключити нагадування" }] }); } catch (e) { }
  // Персоналу — свій список команд у його особистому чаті (scope: chat), клієнти його не бачать.
  try {
    if (/^\d+$/.test(String(env.TELEGRAM_CHAT_ID || ""))) await setStaffCommands(env, env.TELEGRAM_CHAT_ID, "owner");
    for (const r of await staffChats(env)) await setStaffCommands(env, r.chat_id, r.role);
  } catch (e) { }
  return { ok: !!(wh && wh.ok), bot: username, webhook: url, set: (wh && wh.description) || "", error: wh && !wh.ok ? wh.description : undefined };
}
/* ----------------------------- Default price catalog -----------------------------
   Fallback / seed for the site's «Ціни» section. Edited from the CRM → stored in
   the `catalog` D1 table; this constant is served only until the first CRM save. */
const DEFAULT_PRICES = {
  currency: "грн",
  note_gift: "За умови проживання в готелі від 7 діб — гігієнічний комплекс у подарунок для вашого улюбленця! 🎁",
  note_big: "Перша година очікування після грумінгу — безкоштовно, кожна наступна — 100 ₴/год. Ціна може залежати від стану шерсті та розміру улюбленця.",
  categories: [
    {
      id: "hygiene-dogs", title: "Повний гігієнічний догляд для песиків", icon: "paw",
      columns: ["Порода", "Ціна, грн"], searchable: true,
      rows: [
        ["Чихуахуа", "1000"], ["Чихуахуа довгошерста", "1100"], ["Йорк тер'єр", "1100"], ["Бівер тер'єр", "1200"],
        ["Той тер'єр", "1000"], ["Такса", "1200"], ["Такса довгошерста", "1200"], ["Шпіц до 4 кг", "1200"],
        ["Шпіц від 4 кг", "1300"], ["Пудель до 4 кг", "1350"], ["Пудель 4–7 кг", "1500"], ["Пудель від 7 кг", "1700"],
        ["Лабрадудль до 15 кг", "2500"], ["Лабрадудль від 15 кг", "2700"], ["Мальтійська болонка", "1200"],
        ["Мальтіпу, Кавапу до 4 кг", "1500"], ["Мальтіпу, Кавапу від 4 кг", "1550"], ["Бішон, Пушон", "1600"],
        ["Ши-тцу до 5 кг", "1200"], ["Ши-тцу від 5 кг", "1400"], ["Пекінес до 5 кг", "1100"], ["Пекінес від 5 кг", "1250"],
        ["Китайська чубата", "1000"], ["Папільйон", "1100"], ["Мопс", "1200"], ["Бігль", "1400"],
        ["Грифон короткошерстий", "1100"], ["Французький бульдог", "1200"], ["Англійський бульдог", "1400"],
        ["Амстафф", "1400"], ["Бультер'єр", "1300"], ["Вельш-коргі до 15 кг", "1300"], ["Вельш-коргі від 15 кг", "1500"],
        ["Спанієль", "1350"], ["Кавалер Кінг Чарльз", "1200"], ["Цвергшнауцер", "1300"], ["Фокстер'єр", "1500"],
        ["Вест-хайленд-тер'єр", "1200"], ["Мітельшнауцер", "1500"], ["Шелті", "1500"], ["Шиба-іну", "1300"],
        ["Лабрадор", "1500"], ["Кане-корсо", "1800"], ["Ретривер", "1600"], ["Малінуа", "1300"], ["Вівчарка Аусі", "1500"],
        ["Вівчарка довгошерста", "1800"], ["Хаскі", "1800"], ["Маламут", "2300"], ["Акіта", "1900"], ["Чау-чау", "2500"],
        ["Самоїд", "2500"], ["Бернський Зенненхунд", "2500"], ["Мікси (метиси) до 10 кг", "1300"],
        ["Мікси від 10 до 20 кг", "1500"], ["Мікси від 20 кг", "1800"],
      ],
    },
    {
      id: "haircut-dogs", title: "Комплексний догляд + стрижка для песиків", icon: "scissors",
      columns: ["Порода", "Ціна, грн"], searchable: true,
      rows: [
        ["Чихуахуа довгошерста", "1200"], ["Йорк тер'єр", "1300"], ["Бівер тер'єр", "1300"], ["Такса довгошерста", "1300"],
        ["Шпіц до 4 кг", "1300"], ["Шпіц від 4 кг", "1600"], ["Пудель до 4 кг", "1600"], ["Пудель 4–7 кг", "1800"],
        ["Пудель від 7 кг", "2000"], ["Лабрадудль до 15 кг", "2800"], ["Лабрадудль від 15 кг", "3000"],
        ["Мальтійська болонка", "1350"], ["Мальтіпу, Кавапу до 4 кг", "1600"], ["Мальтіпу, Кавапу від 4 кг", "1800"],
        ["Бішон, Пушон", "1700"], ["Ши-тцу до 5 кг", "1350"], ["Ши-тцу від 5 кг", "1600"], ["Пекінес до 5 кг", "1300"],
        ["Пекінес від 5 кг", "1400"], ["Китайська чубата", "1200"], ["Папільйон", "1200"], ["Спанієль (коротка)", "1300"],
        ["Спанієль (модельна)", "1700"], ["Кавалер Кінг Чарльз", "1400"], ["Вельш-коргі до 15 кг", "1400"],
        ["Вельш-коргі від 15 кг", "1500"], ["Цвергшнауцер", "1600"], ["Фокстер'єр", "1700"], ["Вест-хайленд-тер'єр", "1600"],
        ["Мітельшнауцер", "2100"], ["Шелті", "1600"], ["Ретривер", "1900"], ["Вівчарка Аусі", "1600"],
        ["Вівчарка довгошерста", "2000"], ["Чау-чау", "2800"], ["Самоїд", "2900"], ["Мікси (метиси) до 10 кг", "1500"],
        ["Мікси від 10 до 20 кг", "1700"], ["Мікси від 20 кг", "2000"],
      ],
    },
    {
      id: "cats", title: "Догляд для котиків", icon: "cat",
      columns: ["Послуга", "Вага до 5 кг", "Вага від 5 кг"], searchable: false,
      rows: [
        ["Вичісування (45 хв)", "1100", "1200"], ["Купання + сушіння (1 год 30 хв)", "1000", "1200"],
        ["Вичісування ковтунів (15 хв)", "250–450", "250–450"], ["Гігієнічний комплекс (2 год 30 хв)", "1700", "2000"],
        ["Комплекс: вичісування + кігті + вушка (1 год 20 хв)", "1250", "1450"], ["Підстригання кігтів", "200", "250"],
        ["Чищення вушок", "250", "300"], ["Підстригання кігтів + чищення вушок", "350", "400"],
        ["Чищення зубів (щітка + паста)", "300", "350"],
      ],
    },
    {
      id: "extra", title: "Окремі види послуг", icon: "star",
      columns: ["Послуга", "Ціна, грн"], searchable: false,
      rows: [
        ["Трімінг (стрипінг) жорсткошерсних порід", "1000 / година"], ["Вичісування ковтунів", "+ 20%"],
        ["Застосування лікувальних шампунів (вартість шампуню)", "+ 300"], ["Зрізання і шліфування кігтиків", "200"],
        ["Зрізання кігтиків (адаптаційні візити)", "300"], ["Чищення вушок", "250"], ["Зрізання кігтиків + чищення вушок", "400"],
        ["Чищення зубів (щітка + паста)", "300"], ["Підстригання шерсті навколо очей", "250"],
        ["Вистригання шерсті в інтимних зонах", "350"], ["Вистригання шерсті між подушечок лап + окантування", "400"],
        ["Стрижка мордочки", "300–600"],
      ],
    },
    {
      id: "hotel", title: "Міні-готель 24/7", icon: "home",
      columns: ["", "Собаки до 10 кг", "Котики"], searchable: false,
      rows: [["1 доба", "1300", "700"], ["Від 10 діб і більше", "1200", "600"], ["Друга тварина з родини", "−20%", "−20%"]],
    },
    {
      id: "daycare", title: "Денний садочок (погодинно)", icon: "play",
      columns: ["Тариф", "Ціна, грн"], searchable: false,
      rows: [["1 година", "220"], ["Половина дня (5 годин)", "1000"], ["Повний день (10 годин)", "1800"], ["Друга тварина з родини", "−20%"]],
    },
  ],
};

// Unified seed: each service = a bookable item + its own price list (from DEFAULT_PRICES).
const DEFAULT_SERVICES = (() => {
  const cat = id => (DEFAULT_PRICES.categories.find(c => c.id === id) || { columns: [], rows: [] });
  return [
    { name: "Гігієнічний комплекс (собаки)", species: "dog", duration: 120, is_request: 0, bookable: 1, active: 1, price_type: "breed", price: "", unit: "₴", note: "", columns: ["Порода", "Ціна, ₴"], rows: cat("hygiene-dogs").rows },
    { name: "Комплекс зі стрижкою (собаки)", species: "dog", duration: 150, is_request: 0, bookable: 1, active: 1, price_type: "breed", price: "", unit: "₴", note: "", columns: ["Порода", "Ціна, ₴"], rows: cat("haircut-dogs").rows },
    { name: "Догляд для котиків", species: "cat", duration: 120, is_request: 0, bookable: 1, active: 1, price_type: "table", price: "", unit: "₴", note: "", columns: cat("cats").columns, rows: cat("cats").rows },
    { name: "Вичісування / експрес-линька", species: "both", duration: 90, is_request: 0, bookable: 1, active: 1, price_type: "flat", price: "", unit: "₴", note: "Ціна залежить від стану шерсті та розміру улюбленця.", columns: [], rows: [] },
    { name: "Окремі види послуг (допи)", species: "both", duration: 0, is_request: 0, bookable: 0, active: 1, price_type: "addon", price: "", unit: "₴", note: "Додаються до основної послуги при записі", columns: ["Послуга", "Ціна, ₴"], rows: cat("extra").rows },
    { name: "Міні-готель", species: "both", duration: 0, is_request: 1, bookable: 1, active: 1, price_type: "table", price: "", unit: "₴/доба", note: "", columns: cat("hotel").columns, rows: cat("hotel").rows },
    { name: "Денний садочок", species: "both", duration: 0, is_request: 1, bookable: 1, active: 1, price_type: "options", price: "", unit: "₴", note: "", columns: cat("daycare").columns, rows: cat("daycare").rows },
  ];
})();
