/**
 * Little Paw by Hanna — booking Worker
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
 */

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
// Майстри (roster) — keep in sync with data/config.js `staff`
const STAFF = ["Дар'я", "Катерина", "Марія"];
// DEFAULT_SERVICES (unified: booking + price) is defined at the bottom of the
// file, built from DEFAULT_PRICES so the seed data lives in one place.

/* ----------------------------- HTTP entry ----------------------------- */
export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    try {
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
      if (url.pathname === "/client/profile" && request.method === "POST") return json(await clientProfile(request, env), cors);
      if (url.pathname === "/client/logout" && request.method === "POST") return json(await clientLogout(request, env), cors);
      if (url.pathname === "/master/data" && request.method === "GET") {
        return json(await masterData(request, url, env), cors);
      }
      if (url.pathname === "/master/status" && request.method === "POST") {
        return json(await masterStatus(request, await request.json(), env), cors);
      }
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
      if (url.pathname === "/tg/webhook" && request.method === "POST") {
        return json(await tgWebhook(request, env), cors);        // called by Telegram (secret header checked inside)
      }
      if (url.pathname === "/admin/tg-setup" && request.method === "POST") {
        return json(await tgSetup(request, env), cors);          // owner: register webhook, remember bot username
      }
      if (url.pathname === "/admin/tg-test" && request.method === "POST") {
        return json(await tgTest(request, env), cors);           // owner: feed a synthetic update (QA)
      }
      if (url.pathname === "/admin/notify-client" && request.method === "POST") return json(await notifyClientManual(request, env), cors);
      if (url.pathname === "/admin/notify-broadcast" && request.method === "POST") return json(await notifyBroadcast(request, env), cors);
      if (url.pathname === "/admin/send-client-reminders" && request.method === "POST") {
        await requireAdmin(request, env);
        const b = await request.json().catch(() => ({}));
        return json(await runClientReminders(env, b && b.kind === "soon" ? "soon" : "day", true), cors);
      }
      if (url.pathname.startsWith("/photo/") && request.method === "GET") return photoServe(url, env, cors);
      if (url.pathname === "/admin/photos" && request.method === "GET") return json(await adminPhotos(request, url, env), cors);
      if (url.pathname === "/admin/photo-upload" && request.method === "POST") return json(await photoUpload(request, env), cors);
      if (url.pathname === "/admin/photo-delete" && request.method === "POST") return json(await photoDelete(request, env), cors);
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
      if (url.pathname === "/admin/settings" && request.method === "GET") {
        return json(await adminSettings(request, env), cors);
      }
      if (url.pathname === "/admin/settings-save" && request.method === "POST") {
        return json(await settingsSave(request, env), cors);
      }
      // ---- Site CMS (CRM «Сайт» tab): hidden sections + text overrides for index.html ----
      if (url.pathname === "/site" && request.method === "GET") {
        return json(await publicSite(env), { ...cors, "Cache-Control": "public, max-age=60" });   // public: read by the site
      }
      if (url.pathname === "/admin/site-save" && request.method === "POST") {
        return json(await siteSave(request, env), cors);
      }
      if (url.pathname === "/admin/send-digest" && request.method === "POST") {
        await requireAdmin(request, env);
        return json(await runDailyDigest(env, true), cors);
      }
      return json({ ok: false, error: "not found" }, cors, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, cors, e && e.status || 500);
    }
  },

  // Cloudflare Cron Triggers: daily → salon digest + day-before client reminders; every 30 min → "starting soon" client reminders.
  async scheduled(event, env, ctx) {
    const cron = (event && event.cron) || "";
    if (cron.startsWith("*/30")) ctx.waitUntil(runClientReminders(env, "soon").catch(() => {}));
    else ctx.waitUntil(Promise.all([runDailyDigest(env).catch(() => {}), runClientReminders(env, "day").catch(() => {})]));
  },
};

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
async function freeBusy(env, token, timeMin, timeMax) {
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
      timeZone: BUSINESS.tz, items: [{ id: env.CALENDAR_ID }],
    }),
  });
  const data = await res.json();
  const cal = data.calendars && data.calendars[env.CALENDAR_ID];
  if (!cal) throw new Error("freeBusy failed: " + JSON.stringify(data));
  return (cal.busy || []).map(b => [new Date(b.start).getTime(), new Date(b.end).getTime()]);
}

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
// Is a slot free for the given staff? "" (any) → free while capacity remains.
function slotFree(events, start, end, staff) {
  const ov = overlappingAt(events, start, end);
  if (staff) return !ov.some(ev => ev.staff === staff);
  return ov.length < STAFF.length;               // any master: capacity of the roster
}
// Pick a free master for an "any" booking, or null if none.
function pickFreeStaff(events, start, end) {
  const ov = overlappingAt(events, start, end);
  const busy = new Set(ov.map(ev => ev.staff).filter(Boolean));
  return STAFF.find(s => !busy.has(s)) || null;
}

/* ----------------------------- Masters & schedule ----------------------------- */
function hmToMin(t) { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function parseVac(s) { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
const DEFAULT_MASTERS = () => STAFF.map(n => ({ name: n, active: 1, startMin: 600, endMin: 1200, daysOff: [], vacations: [] }));
async function loadMasters(env) {
  if (!env.DB) return DEFAULT_MASTERS();
  try {
    const { results } = await env.DB.prepare(`SELECT * FROM masters ORDER BY sort, id`).all();
    if (!results || !results.length) return DEFAULT_MASTERS();
    return results.map(r => ({
      name: r.name, active: r.active ? 1 : 0,
      startMin: hmToMin(r.work_start) || 600, endMin: hmToMin(r.work_end) || 1200,
      breakStart: hmToMin(r.break_start), breakEnd: hmToMin(r.break_end),
      daysOff: String(r.days_off || "").split(",").map(x => x.trim()).filter(x => x !== "").map(Number),
      vacations: parseVac(r.vacations),
    }));
  } catch (e) { return DEFAULT_MASTERS(); }
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
  const svc = (await loadServices(env)).find(s => s.name === service);
  const duration = (svc && svc.duration) ? svc.duration : (SERVICE_DURATIONS[service] || DEFAULT_DURATION);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  const masters = await loadMasters(env);
  let working = masters.filter(mst => masterWorks(mst, iso, dow));
  if (reqStaff) working = working.filter(mst => mst.name === reqStaff);
  if (!working.length) return { ok: true, slots: [] };      // day off / vacation / inactive

  const token = await getAccessToken(env);
  const dayStart = wallToUTC(y, m, d, 0, BUSINESS.tz);
  const dayEnd = wallToUTC(y, m, d, 24 * 60, BUSINESS.tz);
  let events = await listEvents(env, token, dayStart, dayEnd);
  const excl = Number(url.searchParams.get("exclude"));   // booking being rescheduled: its own event must not block the picker
  if (Number.isInteger(excl) && excl > 0 && env.DB) {
    const row = await env.DB.prepare(`SELECT event_id FROM bookings WHERE id=?`).bind(excl).first();
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
      !overlappingAt(events, start, end).some(ev => ev.staff === mst.name));
    if (avail) slots.push(hhmm(t));
  }
  return { ok: true, slots };
}

async function book(body, env, source) {
  source = source || "site";   // "site" (booking form) or "telegram" (bot conversation)
  const { pet, pet_name, service, breed, name, phone, date, time, note, weight } = body || {};
  let staff = (body && body.staff) || "";
  const waitlist = !!(body && body.waitlist);
  if (!name || !phone) return { ok: false, error: "Вкажіть ім'я і телефон" };

  const masters = await loadMasters(env);
  if (staff && !masters.some(mst => mst.name === staff)) staff = "";  // ignore unknown master

  const isRequest = (await serviceIsRequest(env, service)) || !time || waitlist;
  let eventLink = null, eventId = null;

  if (!isRequest) {
    const { y, m, d } = parseDate(date);
    const tm = /^(\d{2}):(\d{2})$/.exec(time);
    if (!tm) return { ok: false, error: "bad time" };
    const startMin = (+tm[1]) * 60 + (+tm[2]);
    const duration = await serviceDuration(env, service);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

    const token = await getAccessToken(env);
    const start = wallToUTC(y, m, d, startMin, BUSINESS.tz);
    const end = new Date(start.getTime() + duration * 60000);
    const events = await listEvents(env, token,
      new Date(start.getTime() - BUSINESS.bufferMin * 60000),
      new Date(end.getTime() + BUSINESS.bufferMin * 60000));
    const isFree = mst => startMin >= mst.startMin && startMin + duration <= mst.endMin &&
      !inBreak(mst, startMin, startMin + duration) && masterWorks(mst, date, dow) &&
      !overlappingAt(events, start.getTime(), end.getTime()).some(ev => ev.staff === mst.name);
    if (staff) {
      const mst = masters.find(x => x.name === staff);
      if (!mst || !isFree(mst)) return { ok: false, error: "На жаль, цей час уже зайнятий у майстра. Оберіть інший." };
    } else {
      const freeM = masters.find(isFree);
      if (!freeM) return { ok: false, error: "На жаль, цей час щойно зайняли. Оберіть інший, будь ласка." };
      staff = freeM.name;
    }

    const ev = await calCreate(env, token, { pet, pet_name, service, breed, weight, name, phone, note, date, time, staff, source });
    eventLink = ev.htmlLink;
    eventId = ev.id;
  }

  await notifyTelegram(env, { pet, service, breed, name, phone, date, time, note, isRequest, staff, waitlist, source });
  const saved = (await saveBooking(env, { pet, pet_name, service, breed, weight, name, phone, date, time, note, isRequest, eventLink, eventId, staff, source, waitlist, addons: (body && body.addons) })) || {};
  let tgLink = "";
  try {
    tgLink = await tgDeepLink(env, saved.tg_code);                       // "" until the bot is connected in the CRM
    if (saved.id && !isRequest) await tgNotifyClient(env, saved.id, "created"); // only if this client already linked Telegram
  } catch (e) { }
  return { ok: true, request: isRequest, staff, waitlist, id: saved.id || null, tg_link: tgLink };
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
  const dur = await serviceDuration(env, b.service);
  const res = await fetch(calUrl(env), { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(calEventBody(b, dur)) });
  const ev = await res.json();
  if (!ev.id) throw new Error("event insert failed: " + JSON.stringify(ev));
  return ev;
}
async function calPatch(env, token, id, b) {
  const dur = await serviceDuration(env, b.service);
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
      `INSERT INTO bookings (created_at,pet,service,breed,name,phone,date,time,note,is_request,event_link,status,source,event_id,price,staff,weight,client_id,pet_id,pet_name,tg_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      new Date().toISOString(), b.pet || "", b.service || "", b.breed || "",
      b.name || "", b.phone || "", b.date || "", b.time || "", b.note || "",
      b.isRequest ? 1 : 0, b.eventLink || null, b.waitlist ? "waitlist" : "new", b.source || "site", b.eventId || null,
      (b.price != null && b.price !== "") ? b.price : null, b.staff || "", b.weight || "",
      link.client_id, link.pet_id, b.pet_name || "", tgCode
    ).run();
    return { id: r.meta && r.meta.last_row_id, tg_code: tgCode };
  } catch (e) { /* CRM logging must never break a booking */ }
}

/* ----------------------------- Auth: accounts, roles, sessions ----------------------------- */
function bearer(request) { return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim(); }
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
async function requireAdmin(request, env) {
  const tok = bearer(request);
  if (env.ADMIN_TOKEN && tok === env.ADMIN_TOKEN) return { role: "owner", user_id: 0, name: "Власник" };
  const s = await sessionUser(env, tok);
  if (!s || (s.role !== "owner" && s.role !== "admin")) { const e = new Error("unauthorized"); e.status = 401; throw e; }
  return s;
}
async function requireOwner(request, env) {
  const s = await requireAdmin(request, env);
  if (s.role !== "owner") { const e = new Error("Доступ лише для власника"); e.status = 403; throw e; }
  return s;
}
async function authLogin(body, env) {
  const username = String(body && body.username || "").trim().toLowerCase();
  const password = String(body && body.password || "");
  if (env.ADMIN_TOKEN && password === env.ADMIN_TOKEN) return issueSession(env, { id: 0, role: "owner", name: "Власник", username: "owner", must_change: 0 });
  if (!username || !password) { const e = new Error("Вкажіть логін і пароль"); e.status = 400; throw e; }
  const u = await env.DB.prepare(`SELECT * FROM users WHERE lower(username)=? AND active=1`).bind(username).first();
  if (!u || !u.pass_hash) { const e = new Error("Невірний логін або пароль"); e.status = 401; throw e; }
  const hash = await pbkdf2(password, u.pass_salt || "");
  if (hash !== u.pass_hash) { const e = new Error("Невірний логін або пароль"); e.status = 401; throw e; }
  return issueSession(env, u);
}
async function issueSession(env, u) {
  const token = randHex(24);
  const now = new Date();
  const name = u.name || u.username || "";
  const exp = new Date(now.getTime() + 30 * 864e5).toISOString();
  await env.DB.prepare(`INSERT INTO sessions (token,user_id,role,master_id,name,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(token, u.id || 0, u.role, u.master_id || null, name, now.toISOString(), exp).run();
  return { ok: true, token, role: u.role, name, username: u.username || "", must_change: u.must_change ? 1 : 0 };
}
async function authMe(request, env) {
  const tok = bearer(request);
  if (env.ADMIN_TOKEN && tok === env.ADMIN_TOKEN) return { ok: true, role: "owner", name: "Власник", username: "owner", must_change: 0 };
  const s = await sessionUser(env, tok);
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
  return { ok: true };
}
/* ---- User management (owner only) ---- */
async function adminUsers(request, env) {
  await requireOwner(request, env);
  const { results } = await env.DB.prepare(`SELECT id,username,name,role,master_id,active,must_change,created_at FROM users ORDER BY role, username`).all();
  return { ok: true, users: results || [] };
}
async function userSave(request, env) {
  await requireOwner(request, env);
  const b = await request.json();
  const username = String(b.username || "").trim().toLowerCase();
  if (b.id) {
    const sets = [], vals = [];
    for (const f of ["name", "role", "master_id", "active"]) if (b[f] != null) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (b.username != null) { sets.push("username=?"); vals.push(username); }
    if (sets.length) { vals.push(b.id); await env.DB.prepare(`UPDATE users SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); }
    if (b.password) { const salt = randHex(16), hash = await pbkdf2(String(b.password), salt); await env.DB.prepare(`UPDATE users SET pass_hash=?, pass_salt=?, must_change=1 WHERE id=?`).bind(hash, salt, b.id).run(); }
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
  await env.DB.prepare(`DELETE FROM users WHERE id=? AND role!='owner'`).bind(id).run();
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run();
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
    const dur = await serviceDuration(env, b.service);
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
  const prev = (await env.DB.prepare(`SELECT status,date,time FROM bookings WHERE id=?`).bind(id).first()) || {};
  const moved = (body.date != null && body.date !== prev.date) || (body.time != null && body.time !== prev.time);
  if (moved) sets.push("remind_day_sent=0", "remind_hour_sent=0"); // rescheduled → remind the client again
  if (sets.length) {
    vals.push(id);
    await env.DB.prepare(`UPDATE bookings SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();
  }
  let calendar = "unchanged";
  try { calendar = await syncCalendar(env, id); }
  catch (e) { calendar = "error: " + String(e && e.message || e); }
  // tell a linked client what changed: confirmed / cancelled / moved to another date-time
  const newStatus = body.status != null ? body.status : prev.status;
  const newDate = body.date != null ? body.date : prev.date;
  const upcoming = !!newDate && newDate >= isoInTz(new Date(), BUSINESS.tz);   // past or finished visits get no messages
  if (body.status === "confirmed" && prev.status !== "confirmed" && upcoming) await tgNotifyClient(env, id, "confirmed");
  else if (body.status === "cancelled" && ["new", "confirmed"].includes(prev.status) && upcoming) await tgNotifyClient(env, id, "cancelled");
  else if (moved && ["new", "confirmed"].includes(newStatus) && upcoming) await tgNotifyClient(env, id, "moved");
  return { ok: true, calendar };
}

async function adminCreate(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  if (!b || !b.name || !b.phone) return { ok: false, error: "Вкажіть ім'я і телефон" };
  if ((b.status || "new") !== "cancelled") { const why = await staffScheduleProblem(env, b); if (why) return { ok: false, error: "Не можна призначити: " + why }; }
  await applyPricing(env, b);
  const hasTime = !!(b.date && b.time);
  let eventId = null, eventLink = null;
  if (hasTime && (b.status || "new") !== "cancelled") {
    try {
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
  return { ok: true, id: newId };
}

/* ----------------------------- Clients & Pets ----------------------------- */
function normPhone(p) { return (p || "").replace(/\D/g, "").slice(-9); }

// Find/create the client (by phone) and pet (by name under client) for a booking.
async function linkClientPet(env, b) {
  if (!env.DB) return { client_id: null, pet_id: null };
  let clientId = null, petId = null;
  const np = normPhone(b.phone);
  if (np) {
    const cs = await env.DB.prepare(`SELECT id, phone FROM clients`).all();
    const found = (cs.results || []).find(c => normPhone(c.phone) === np);
    if (found) clientId = found.id;
    else {
      const r = await env.DB.prepare(
        `INSERT INTO clients (created_at,name,phone,source,status) VALUES (?,?,?,?, 'active')`
      ).bind(new Date().toISOString(), b.name || "", b.phone || "", b.source || "site").run();
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
  let photos = []; try { photos = (await env.DB.prepare(`SELECT id,pet_id,kind,token,created_at FROM pet_photos WHERE pet_id IN (SELECT id FROM pets WHERE client_id=?) ORDER BY created_at DESC`).bind(c.id).all()).results || []; } catch (e) { }
  pets.forEach(p => { p.photos = photos.filter(x => x.pet_id === p.id).map(x => ({ id: x.id, kind: x.kind, created_at: x.created_at, url: photoUrl(url.origin, x) })); });
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
  try { await sendTelegram(env, `❌ <b>Клієнт скасував запис у кабінеті</b>\n${b.date && b.time ? visitText(b) : tgEsc(b.service || "")}\n👤 ${tgEsc(b.name || "")} — ${tgEsc(b.phone || "")}`); } catch (e) { }
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
  let staff = null; try { staff = await freeMasterAt(env, { date, time, service: b.service, prefer: b.staff, excludeEventId: b.event_id }); } catch (e) { staff = null; }
  if (!staff) return { ok: false, error: "На жаль, цей час уже зайнятий. Оберіть інший." };
  await env.DB.prepare(`UPDATE bookings SET date=?, time=?, staff=?, remind_day_sent=0, remind_hour_sent=0 WHERE id=?`).bind(date, time, staff, b.id).run();
  try { await syncCalendar(env, b.id); } catch (e) { }
  const nb = Object.assign({}, b, { date, time, staff });
  try { await sendTelegram(env, `🔁 <b>Клієнт переніс запис у кабінеті</b>\nБуло: ${fmtDdMm(b.date)} о ${tgEsc(b.time)}${b.staff ? " (" + tgEsc(b.staff) + ")" : ""}\nСтало: ${visitText(nb)}\n👤 ${tgEsc(b.name || "")} — ${tgEsc(b.phone || "")}`); } catch (e) { }
  try { await tgNotifyClient(env, b.id, "moved"); } catch (e) { }
  return { ok: true, staff };
}
const CLIENT_PET_FIELDS = ["name", "species", "breed", "weight", "birthdate", "sex", "color", "allergies", "behavior", "prefs", "client_notes"];   // vet_notes / warnings / reactions / special are staff-only
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

/* ----------------------------- Pet photos (before / after) — stored in D1, served by /photo/<id>/<token> ----------------------------- */
const PHOTO_MAX = 900 * 1024;   // after client-side shrinking a 1280px JPEG is ~100-250 KB
const photoUrl = (origin, p) => `${origin}/photo/${p.id}/${p.token}`;
async function photoUpload(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  const petId = Number(b.pet_id); if (!Number.isInteger(petId) || petId <= 0) return { ok: false, error: "pet_id required" };
  const kind = b.kind === "after" ? "after" : "before";
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ""));
  if (!m) return { ok: false, error: "Очікується зображення JPEG / PNG / WebP" };
  const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bin.length > PHOTO_MAX) return { ok: false, error: "Фото завелике (макс. 900 КБ після стиснення)" };
  const pet = await env.DB.prepare(`SELECT client_id FROM pets WHERE id=?`).bind(petId).first();
  if (!pet) return { ok: false, error: "Улюбленця не знайдено" };
  const token = randHex(8);
  const r = await env.DB.prepare(`INSERT INTO pet_photos (pet_id,client_id,booking_id,kind,mime,data,token,created_at,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(petId, pet.client_id || null, b.booking_id ? +b.booking_id : null, kind, m[1], bin.buffer, token, new Date().toISOString(), String(b.note || "").slice(0, 200)).run();
  const id = r.meta && r.meta.last_row_id;
  return { ok: true, id, url: photoUrl(new URL(request.url).origin, { id, token }) };
}
async function adminPhotos(request, url, env) {
  await requireAdmin(request, env);
  const petId = +url.searchParams.get("pet_id"); if (!petId) return { ok: false, error: "pet_id required" };
  const { results } = await env.DB.prepare(`SELECT id,pet_id,booking_id,kind,token,created_at,note,published,length(data) AS size FROM pet_photos WHERE pet_id=? ORDER BY created_at DESC, id DESC`).bind(petId).all();
  return { ok: true, photos: (results || []).map(p => ({ id: p.id, booking_id: p.booking_id, kind: p.kind, created_at: p.created_at, note: p.note, size: p.size, published: p.published ? 1 : 0, url: photoUrl(url.origin, p) })) };
}
// CRM: mark a photo for the public «До / після» gallery. A pair = «before» + «after» of the same pet on the same day, both published.
async function photoPublish(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  const id = Number(b.id); if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "id required" };
  await env.DB.prepare(`UPDATE pet_photos SET published=? WHERE id=?`).bind(b.published ? 1 : 0, id).run();
  return { ok: true, id, published: b.published ? 1 : 0 };
}
// Public: published pairs, newest first (max 40). Only pet name / breed / species leave the salon — no client data.
async function publicBeforeAfter(url, env) {
  let rows = [];
  try {
    rows = (await env.DB.prepare(`SELECT p.id,p.pet_id,p.kind,p.token,p.created_at,t.name AS pet_name,t.species,t.breed
      FROM pet_photos p JOIN pets t ON t.id=p.pet_id WHERE COALESCE(p.published,0)=1 ORDER BY p.created_at DESC, p.id DESC`).all()).results || [];
  } catch (e) { return { ok: true, items: [] }; }
  const groups = {}, order = [];
  rows.forEach(r => { const k = r.pet_id + "|" + String(r.created_at || "").slice(0, 10); if (!groups[k]) { groups[k] = {}; order.push(k); } if (!groups[k][r.kind]) groups[k][r.kind] = r; });
  const items = order.map(k => groups[k]).filter(g => g.before && g.after).slice(0, 40).map(g => ({
    id: "live" + g.after.id, before: photoUrl(url.origin, g.before), after: photoUrl(url.origin, g.after),
    name: g.after.pet_name || "", species: g.after.species === "cat" ? "cat" : "dog", breed: g.after.breed || "", date: String(g.after.created_at || "").slice(0, 10), w: 1280, h: 1280,
  }));
  return { ok: true, items };
}
async function photoDelete(request, env) {
  await requireAdmin(request, env);
  const { id } = await request.json(); if (!Number.isInteger(Number(id)) || Number(id) <= 0) return { ok: false, error: "id required" };
  await env.DB.prepare(`DELETE FROM pet_photos WHERE id=?`).bind(Number(id)).run();
  return { ok: true };
}
async function photoServe(url, env, cors) {   // public but unguessable (16-hex token), cached for a year
  const m = /^\/photo\/(\d+)\/([0-9a-f]{16})$/.exec(url.pathname);
  if (!m) return new Response("not found", { status: 404, headers: cors });
  const p = await env.DB.prepare(`SELECT mime,data,token FROM pet_photos WHERE id=?`).bind(+m[1]).first();
  if (!p || p.token !== m[2]) return new Response("not found", { status: 404, headers: cors });
  return new Response(p.data, { headers: Object.assign({ "Content-Type": p.mime || "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" }, cors) });
}
const CLIENT_FIELDS = ["name", "phone", "email", "messenger", "source", "note", "consent", "status"];
async function clientSave(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
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
  await env.DB.prepare(`DELETE FROM pets WHERE id=?`).bind(id).run();
  try { await env.DB.prepare(`DELETE FROM pet_photos WHERE pet_id=?`).bind(id).run(); } catch (e) { }
  return { ok: true };
}

/* ----------------------------- Masters (schedule) ----------------------------- */
async function publicMasters(env) {
  const masters = await loadMasters(env);
  return { ok: true, masters: masters.filter(m => m.active).map(m => m.name) };
}
async function adminMasters(request, env) {
  const auth = await requireAdmin(request, env);
  const { results } = await env.DB.prepare(`SELECT * FROM masters ORDER BY sort, id`).all();
  let masters = results || [];
  if (auth.role !== "owner") masters = masters.map(m => { const c = { ...m }; delete c.salary_type; delete c.salary_value; delete c.salary_base; return c; }); // salaries are owner-only
  return { ok: true, masters };
}
const MASTER_FIELDS = ["name", "active", "work_start", "work_end", "days_off", "vacations", "sort", "salary_type", "salary_value", "salary_base", "break_start", "break_end", "access_code"];
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
    `SELECT id,date,time,name,phone,pet,pet_name,breed,weight,service,price,status,note,source,pay_method
       FROM bookings WHERE staff=? AND (date>=? OR date='' OR date IS NULL) ORDER BY date, time`
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
    `INSERT INTO reviews (created_at,name,phone,rating,text,master,client_id,published) VALUES (?,?,?,?,?,?,?,0)`
  ).bind(new Date().toISOString(), name, String(b && b.phone || "").trim(), rating, text, String(b && b.master || "").trim(), clientId).run();
  try { await sendTelegram(env, `🌟 Новий відгук (${rating}/5)${name ? " від " + name : ""}\n${text || "(без тексту)"}\nПідтвердьте показ у CRM → Відгуки.`); } catch (e) { }
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
  if (s.price_type !== "breed") return s;
  if ((s.columns || []).length >= 3) return s;
  s.columns = ["Порода", "Вага", "Ціна, ₴"];
  s.rows = (s.rows || []).map(r => { const bw = splitBreedWeight(r[0]); return [bw[0], bw[1], (r[1] != null ? r[1] : "")]; });
  return s;
}
const svcDefaults = () => DEFAULT_SERVICES.map((s, i) => ({ id: null, sort: i, ...s }));
const SVC_COLS = ["name", "species", "duration", "is_request", "bookable", "active", "sort", "price_type", "price", "unit", "note", "columns", "rows"];
function svcBind(s) {
  return [s.name || "", s.species || "both", +s.duration || 0, s.is_request ? 1 : 0,
    s.bookable == null ? 1 : (s.bookable ? 1 : 0), s.active == null ? 1 : (s.active ? 1 : 0), +s.sort || 0,
    s.price_type || "flat", (s.price == null ? "" : String(s.price)), s.unit || "₴", s.note || "",
    JSON.stringify(s.columns || []), JSON.stringify(s.rows || [])];
}
async function seedServices(env) {
  const d = svcDefaults();
  for (const s of d) {
    await env.DB.prepare(`INSERT INTO services (${SVC_COLS.join(",")}) VALUES (${SVC_COLS.map(() => "?").join(",")})`).bind(...svcBind(s)).run();
  }
}
async function loadServices(env) {
  if (!env.DB) return svcDefaults().map(s => migrateBreedService(svcRow(s)));
  try {
    let r = await env.DB.prepare(`SELECT * FROM services ORDER BY sort, id`).all();
    if (!r.results || !r.results.length) { await seedServices(env); r = await env.DB.prepare(`SELECT * FROM services ORDER BY sort, id`).all(); }
    return (r.results || []).map(row => migrateBreedService(svcRow(row)));
  } catch (e) { return svcDefaults().map(s => migrateBreedService(svcRow(s))); }
}
async function serviceInfo(env, name) { return (await loadServices(env)).find(s => s.name === name) || null; }
async function serviceDuration(env, name) { const s = await serviceInfo(env, name); return (s && s.duration) ? s.duration : (SERVICE_DURATIONS[name] || DEFAULT_DURATION); }
async function serviceIsRequest(env, name) { const s = await serviceInfo(env, name); return s ? !!s.is_request : REQUEST_SERVICES.has(name); }
const numOf = v => { const m = /\d+/.exec(String(v == null ? "" : v)); return m ? +m[0] : null; };
const normBreed = x => String(x || "").toLowerCase().replace(/[’'ʼ`]/g, "'").replace(/\s+/g, " ").trim();
// Match a breed to a price row: exact (normalized), else substring either way.
function matchBreedRow(rows, breed) {
  const b = normBreed(breed); if (!b) return null;
  let row = (rows || []).find(r => normBreed(r[0]) === b);
  if (row) return row;
  return (rows || []).find(r => { const l = normBreed(r[0]); return l && (b.includes(l) || l.includes(b)); }) || null;
}
const normW = x => String(x || "").toLowerCase().replace(/\s+/g, " ").replace(/грн|кг/g, "").trim();
// Pick the price row for a breed (+optional weight). Rows are [breed, weight, price].
function pickBreedRow(rows, breed, weight) {
  const b = normBreed(breed); if (!b) return null;
  const all = rows || [];
  let bm = all.filter(r => normBreed(r[0]) === b);   // exact label wins ("Вичісування" must not resolve to "Мейн-кун (вичісування)")
  if (!bm.length) bm = all.filter(r => { const l = normBreed(r[0]); return l && (b.includes(l) || l.includes(b)); })
    .sort((x, y) => Math.abs(normBreed(x[0]).length - b.length) - Math.abs(normBreed(y[0]).length - b.length)); // closest label first
  if (!bm.length) return null;
  if (bm.length === 1) return bm[0];
  const w = normW(weight);
  return (w && bm.find(r => normW(r[1]) === w)) || bm.find(r => !String(r[1] || "").trim()) || null;
}
const rowPrice = r => (r ? r[r.length - 1] : null);
// Auto-price a booking from its service (only when unambiguous & numeric).
async function priceForBooking(env, b) {
  const s = await serviceInfo(env, b.service); if (!s) return null;
  if (s.price_type === "breed" && b.breed) { const p = rowPrice(pickBreedRow(s.rows, b.breed, b.weight)); if (p != null && /^\d+$/.test(String(p).trim())) return +p; }
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
  return { ok: true, services, notes: { gift: st.note_gift || DEFAULT_PRICES.note_gift, big: st.note_big || DEFAULT_PRICES.note_big } };
}
async function adminServices(request, env) { await requireAdmin(request, env); return { ok: true, services: await loadServices(env) }; }
async function serviceSave(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  if (b.id) {
    const sets = [], vals = [];
    for (const f of SVC_COLS) {
      if (b[f] == null) continue;
      sets.push(`${f}=?`);
      vals.push((f === "columns" || f === "rows") ? (typeof b[f] === "string" ? b[f] : JSON.stringify(b[f])) : b[f]);
    }
    if (sets.length) { vals.push(b.id); await env.DB.prepare(`UPDATE services SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); }
    return { ok: true, id: b.id };
  }
  if (!b.name) return { ok: false, error: "name required" };
  const r = await env.DB.prepare(`INSERT INTO services (${SVC_COLS.join(",")}) VALUES (${SVC_COLS.map(() => "?").join(",")})`).bind(...svcBind(b)).run();
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
    client_reminders_enabled: "1", remind_hours_before: "2", tg_bot: "" };
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
async function settingsSave(request, env) {
  await requireAdmin(request, env);
  const b = await request.json();
  for (const k of ["reminders_enabled", "repeat_weeks", "note_gift", "note_big", "loyalty_enabled", "loyalty_every", "loyalty_reward", "client_reminders_enabled", "remind_hours_before"]) {
    if (b[k] != null) await env.DB.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?`).bind(k, String(b[k]), String(b[k])).run();
  }
  return { ok: true, settings: await loadSettings(env) };
}

/* ----------------------------- Site CMS ----------------------------- */
// One JSON blob in `settings` (key "site_cms"): { hidden: [sectionId…], texts: { key: text } }.
// The site (scripts/main.js) hides the listed [data-cms-section] ids and replaces [data-cms] texts.
const SITE_CMS_MAX = 64 * 1024;
function normalizeSiteCms(b) {
  const hidden = [], texts = {}, seen = new Set();
  (Array.isArray(b && b.hidden) ? b.hidden : []).forEach(x => {
    const id = String(x == null ? "" : x).trim();
    if (/^[\w-]{1,40}$/.test(id) && !seen.has(id)) { seen.add(id); hidden.push(id); }
  });
  const t = b && b.texts;
  if (t && typeof t === "object" && !Array.isArray(t)) {
    for (const k of Object.keys(t)) {
      if (!/^[\w.-]{1,80}$/.test(k) || typeof t[k] !== "string") continue;
      const v = t[k].trim();
      if (v) texts[k] = v;
    }
  }
  return { hidden, texts };
}
async function loadSiteCms(env) {
  if (!env.DB) return { hidden: [], texts: {} };
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='site_cms'`).first();
    if (row && row.value) return normalizeSiteCms(JSON.parse(row.value));
  } catch (e) { }
  return { hidden: [], texts: {} };
}
async function publicSite(env) {
  const c = await loadSiteCms(env);
  return { ok: true, hidden: c.hidden, texts: c.texts };
}
async function siteSave(request, env) {
  await requireAdmin(request, env);
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") { const e = new Error("bad request"); e.status = 400; throw e; }
  const raw = JSON.stringify(normalizeSiteCms(b));
  if (raw.length > SITE_CMS_MAX) { const e = new Error("Занадто багато тексту (ліміт 64 КБ)"); e.status = 413; throw e; }
  await env.DB.prepare(`INSERT INTO settings (key,value) VALUES ('site_cms',?) ON CONFLICT(key) DO UPDATE SET value=?`).bind(raw, raw).run();
  return { ok: true };
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
async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return r.ok;
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
      `${b.time} — ${b.pet_name ? b.pet_name + " · " : ""}${b.service || ""}${b.staff ? " · " + b.staff : ""}\n👤 ${b.name || ""} — ${b.phone || ""}${contactLinks(b.phone)}`
    ).join("\n\n");
  } else {
    msg1 = `🔔 <b>Записи на завтра (${tomorrow})</b>\n\nНа завтра записів немає.`;
  }
  await sendTelegram(env, msg1);

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
      due.slice(0, 40).map(d => `${d.pet ? d.pet + " · " : ""}${d.name} — ${d.phone}${contactLinks(d.phone)}\n<i>останній: ${d.last}</i>`).join("\n\n");
    await sendTelegram(env, msg2);
  }
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
    const cur = await env.DB.prepare(`SELECT status,date FROM bookings WHERE id=?`).bind(id).first();
    if (cur && ["new", "confirmed"].includes(cur.status) && cur.date && cur.date >= isoInTz(new Date(), BUSINESS.tz)) await tgNotifyClient(env, id, "cancelled");
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
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const head = b.waitlist ? "⏳ <b>Лист очікування</b>"
    : b.isRequest ? "📩 <b>Нова заявка (готель/садочок)</b>" : "🗓️ <b>Новий запис</b>" + (b.source === "telegram" ? " · 🤖 через бота" : "");
  const when = b.isRequest ? (b.date ? `\n📅 Бажана дата: ${b.date}` : "") : `\n📅 ${b.date} о ${b.time}`;
  const text =
    `${head}\n\n🐾 ${b.pet || "—"} · ${b.breed || ""}\n✂️ ${b.service}${when}` +
    (b.staff ? `\n👩‍🔧 ${b.staff}` : "") + `\n👤 ${b.name}\n📞 ${b.phone}` +
    (b.note ? `\n💬 ${b.note}` : "");
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
  });
}

/* ----------------------------- Client reminders via Telegram -----------------------------
   The salon's bot also talks to clients. A client links their chat once (deep link after
   booking on the site, or by sharing their phone with the bot); after that they get a
   confirmation, a day-before and a "starting soon" reminder with ✅/❌ buttons. */
function tgEsc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
async function tgApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, description: "no bot token" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}) });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e && e.message || e) }; }
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
  const np = normPhone(b.phone); if (!np) return null;
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
  const r = await tgSendTo(env, chat, `💬 <b>GAV&amp;LOVE</b>\n${tgEsc(text)}`);
  if (!r || !r.ok) return { ok: false, error: "Telegram не прийняв повідомлення: " + ((r && r.description) || "помилка") };
  try { await sendTelegram(env, `✉️ <b>${tgEsc(who.name || "CRM")}</b> написав(ла) клієнту ${tgEsc(name)}:\n<i>${tgEsc(text)}</i>`); } catch (e) { }
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
    const r = await tgSendTo(env, c.tg_chat_id, `📣 <b>GAV&amp;LOVE</b>\n${tgEsc(text)}`);
    if (r && r.ok) sent++; else failed++;
    if ((sent + failed) % 20 === 0) await new Promise(res => setTimeout(res, 1100));
  }
  try { await sendTelegram(env, `📣 <b>Розсилка від ${tgEsc(who.name || "CRM")}</b> — надіслано ${sent}, помилок ${failed}\n<i>${tgEsc(text.slice(0, 300))}</i>`); } catch (e) { }
  return { ok: true, sent, failed, total: seen.size };
}
// Free master for a date-time (same rule as book()): prefer `prefer`, else the first free one; null = nobody.
async function freeMasterAt(env, { date, time, service, prefer, excludeEventId }) {
  const { y, m, d } = parseDate(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(time || ""); if (!tm) return null;
  const startMin = (+tm[1]) * 60 + (+tm[2]);
  const duration = await serviceDuration(env, service);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const masters = await loadMasters(env);
  const token = await getAccessToken(env);
  const start = wallToUTC(y, m, d, startMin, BUSINESS.tz), end = new Date(start.getTime() + duration * 60000);
  if (start.getTime() < Date.now() + BUSINESS.minLeadMin * 60000 || start.getTime() > Date.now() + BUSINESS.maxAheadDays * 86400000) return null; // same bounds as the slot picker
  const events = (await listEvents(env, token, new Date(start.getTime() - BUSINESS.bufferMin * 60000), new Date(end.getTime() + BUSINESS.bufferMin * 60000)))
    .filter(ev => !excludeEventId || ev.id !== excludeEventId);   // the booking's own event is not a conflict
  const isFree = mst => startMin >= mst.startMin && startMin + duration <= mst.endMin &&
    !inBreak(mst, startMin, startMin + duration) && masterWorks(mst, date, dow) &&
    !overlappingAt(events, start.getTime(), end.getTime()).some(ev => ev.staff === mst.name);
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
      : `⏰ <b>Вже скоро!</b>\nЧекаємо вас ${visitText(b)}\n\nДо зустрічі в GAV&amp;LOVE 🐾`;
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
function bookBtn() { return kb([[{ text: "📅 Записатися", callback_data: "b:start" }, { text: "🔑 Кабінет", callback_data: "cab" }]]); }
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
        try { await sendTelegram(env, `❌ <b>Клієнт скасував запис через бота</b>\n${visitText(b)}\n👤 ${tgEsc(b.name || "")} — ${tgEsc(b.phone || "")}`); } catch (e) { }
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
    const phone = "+" + String(msg.contact.phone_number).replace(/\D/g, "");
    const np = normPhone(phone);
    const after = (st && st.step === "contact" && st.after) || "";
    const cs = await env.DB.prepare(`SELECT id,name,phone FROM clients`).all();
    let c = (cs.results || []).find(x => normPhone(x.phone) === np), created = false;
    if (!c) {   // nobody with this number yet → register them right here
      const nm = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(" ") || "Клієнт з Telegram";
      const r = await env.DB.prepare(`INSERT INTO clients (created_at,name,phone,source,status) VALUES (?,?,?,'telegram','active')`).bind(new Date().toISOString(), nm, phone).run();
      c = { id: r.meta && r.meta.last_row_id, name: nm, phone }; created = true;
      try { await sendTelegram(env, `🆕 <b>Новий клієнт через Telegram-бот</b>\n👤 ${tgEsc(nm)} — ${tgEsc(phone)}`); } catch (e) { }
    }
    await linkClientChat(env, c.id, chat);
    await tgSendTo(env, chat, `✅ Готово, ${tgEsc(c.name || "")}! Нагадування про візити приходитимуть сюди.${created ? "" : await nextVisitsText(env, c.id)}`, { reply_markup: { remove_keyboard: true } });
    if (after === "book") { await bookingAskPet(env, chat, c); return; }
    await tgClearState(env, chat);
    if (after === "cab") { await sendCabinetLink(env, chat, c.id); return; }
    if (after === "visits") { await sendVisits(env, chat, c); return; }
    await tgSendTo(env, chat, "Записатися на грумінг можна прямо тут 👇", BOOK_BTN);
    return;
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
    if (code && !wantCab) {
      const b = await env.DB.prepare(`SELECT id,client_id,name FROM bookings WHERE tg_code=? LIMIT 1`).bind(code).first();
      if (b && b.client_id) {
        await linkClientChat(env, b.client_id, chat);
        await tgSendTo(env, chat, `✅ Готово, ${tgEsc(b.name || "")}! Нагадування про візити приходитимуть сюди.${await nextVisitsText(env, b.client_id)}`, BOOK_BTN);
        return;
      }
    }
    const c = await clientByChat(env, chat);
    if (c) {
      if (wantCab) { await sendCabinetLink(env, chat, c.id); return; }
      await tgSendTo(env, chat, `Вітаємо знову, ${tgEsc(c.name || "")} 🐾${await nextVisitsText(env, c.id)}`, BOOK_BTN);
      return;
    }
    await askPhone(env, chat, wantCab ? "cab" : "", "Вітаємо в GAV&amp;LOVE 🐾\nЩоб отримувати нагадування, записатися або відкрити кабінет, поділіться номером телефону:");
    return;
  }
  await tgSendTo(env, chat, "Я нагадую про візити в GAV&amp;LOVE і можу записати вас на грумінг — натисніть кнопку або /book.", BOOK_BTN);
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
  await env.DB.prepare(`INSERT INTO tg_sessions (chat_id,state,updated_at) VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`)
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
  try { staff = await freeMasterAt(env, { date: st.date, time: st.time, service: b.service, prefer: b.staff, excludeEventId: b.event_id }); } catch (e) { staff = null; }
  if (!staff) { await tgSendTo(env, chat, "На жаль, цей час щойно зайняли. Оберіть інший, будь ласка.", kb([[{ text: "🕐 Інший час", callback_data: "b:back:time" }], [{ text: "✖ Залишити як є", callback_data: "b:x" }]])); return; }
  await env.DB.prepare(`UPDATE bookings SET date=?, time=?, staff=?, remind_day_sent=0, remind_hour_sent=0 WHERE id=?`).bind(st.date, st.time, staff, b.id).run();
  try { await syncCalendar(env, b.id); } catch (e) { }
  await tgClearState(env, chat);
  const nb = Object.assign({}, b, { date: st.date, time: st.time, staff });
  try { await sendTelegram(env, `🔁 <b>Клієнт переніс запис через бота</b>\nБуло: ${fmtDdMm(b.date)} о ${tgEsc(b.time)}${b.staff ? " (" + tgEsc(b.staff) + ")" : ""}\nСтало: ${visitText(nb)}\n👤 ${tgEsc(b.name || "")} — ${tgEsc(b.phone || "")}`); } catch (e) { }
  await tgSendTo(env, chat, `🔁 Перенесено: ${visitText(nb)}${staff !== b.staff && b.staff ? "\n(інший майстер — попередній на цей час зайнятий)" : ""}\n\nНагадаємо напередодні 🐾`, visitButtons(nb));
}

async function tgWebhook(request, env) {
  if ((request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "") !== await tgWebhookSecret(env)) { const e = new Error("forbidden"); e.status = 403; throw e; }
  const update = await request.json().catch(() => null);
  try { await handleTgUpdate(env, update); } catch (e) { }
  return { ok: true };
}
async function tgSetup(request, env) { // owner: remember the bot username and register the webhook
  await requireOwner(request, env);
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN не задано" };
  const me = await tgApi(env, "getMe", {});
  const username = me && me.ok && me.result ? me.result.username : "";
  if (!username) return { ok: false, error: "Telegram не відповів: " + (me && me.description || "getMe failed") };
  await env.DB.prepare(`INSERT INTO settings (key,value) VALUES ('tg_bot',?) ON CONFLICT(key) DO UPDATE SET value=?`).bind(username, username).run();
  const url = new URL(request.url).origin + "/tg/webhook";
  const wh = await tgApi(env, "setWebhook", { url, secret_token: await tgWebhookSecret(env), allowed_updates: ["message", "callback_query"] });
  try { await tgApi(env, "setMyCommands", { commands: [{ command: "book", description: "Записатися на грумінг" }, { command: "visits", description: "Мої візити — перенести чи скасувати" }, { command: "cabinet", description: "Мій кабінет на сайті" }, { command: "start", description: "Підключити нагадування" }] }); } catch (e) { }
  return { ok: !!(wh && wh.ok), bot: username, webhook: url, set: (wh && wh.description) || "", error: wh && !wh.ok ? wh.description : undefined };
}
async function tgTest(request, env) { // owner-only QA hook: run a synthetic update through the same handler
  await requireOwner(request, env);
  const b = await request.json();
  const u = b && b.update; if (!u) return { ok: false, error: "update required" };
  if (b.use_owner_chat && env.TELEGRAM_CHAT_ID) { const id = +env.TELEGRAM_CHAT_ID; if (u.message) u.message.chat = { id }; if (u.callback_query && u.callback_query.message) u.callback_query.message.chat = { id }; }
  await handleTgUpdate(env, u);
  return { ok: true };
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
