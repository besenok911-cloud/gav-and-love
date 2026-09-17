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
      if (url.pathname === "/catalog" && request.method === "GET") {
        return json(await publicCatalog(env), { ...cors, "Cache-Control": "public, max-age=60" });
      }
      if (url.pathname === "/admin/services" && request.method === "GET") {
        return json(await adminServices(request, env), cors);
      }
      if (url.pathname === "/admin/service-save" && request.method === "POST") {
        return json(await serviceSave(request, env), cors);
      }
      if (url.pathname === "/admin/service-delete" && request.method === "POST") {
        return json(await serviceDelete(request, env), cors);
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
      if (url.pathname === "/admin/send-digest" && request.method === "POST") {
        requireAdmin(request, env);
        return json(await runDailyDigest(env, true), cors);
      }
      return json({ ok: false, error: "not found" }, cors, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, cors, e && e.status || 500);
    }
  },

  // Cloudflare Cron Trigger — daily reminder digest to the salon's Telegram.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyDigest(env).catch(() => {}));
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
  const events = await listEvents(env, token, dayStart, dayEnd);

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
      t >= mst.startMin && t + duration <= mst.endMin &&
      !overlappingAt(events, start, end).some(ev => ev.staff === mst.name));
    if (avail) slots.push(hhmm(t));
  }
  return { ok: true, slots };
}

async function book(body, env) {
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
      masterWorks(mst, date, dow) &&
      !overlappingAt(events, start.getTime(), end.getTime()).some(ev => ev.staff === mst.name);
    if (staff) {
      const mst = masters.find(x => x.name === staff);
      if (!mst || !isFree(mst)) return { ok: false, error: "На жаль, цей час уже зайнятий у майстра. Оберіть інший." };
    } else {
      const freeM = masters.find(isFree);
      if (!freeM) return { ok: false, error: "На жаль, цей час щойно зайняли. Оберіть інший, будь ласка." };
      staff = freeM.name;
    }

    const ev = await calCreate(env, token, { pet, pet_name, service, breed, weight, name, phone, note, date, time, staff, source: "site" });
    eventLink = ev.htmlLink;
    eventId = ev.id;
  }

  await notifyTelegram(env, { pet, service, breed, name, phone, date, time, note, isRequest, staff, waitlist });
  await saveBooking(env, { pet, pet_name, service, breed, weight, name, phone, date, time, note, isRequest, eventLink, eventId, staff, source: "site", waitlist, addons: (body && body.addons) });
  return { ok: true, request: isRequest, staff, waitlist };
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
    await env.DB.prepare(
      `INSERT INTO bookings (created_at,pet,service,breed,name,phone,date,time,note,is_request,event_link,status,source,event_id,price,staff,weight,client_id,pet_id,pet_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, ?, 'site', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      new Date().toISOString(), b.pet || "", b.service || "", b.breed || "",
      b.name || "", b.phone || "", b.date || "", b.time || "", b.note || "",
      b.isRequest ? 1 : 0, b.eventLink || null, b.waitlist ? "waitlist" : "new", b.eventId || null,
      (b.price != null && b.price !== "") ? b.price : null, b.staff || "", b.weight || "",
      link.client_id, link.pet_id, b.pet_name || ""
    ).run();
  } catch (e) { /* CRM logging must never break a booking */ }
}

function requireAdmin(request, env) {
  const h = request.headers.get("Authorization") || "";
  const tok = h.replace(/^Bearer\s+/i, "").trim();
  if (!env.ADMIN_TOKEN || tok !== env.ADMIN_TOKEN) {
    const e = new Error("unauthorized"); e.status = 401; throw e;
  }
}

async function adminList(request, env) {
  requireAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings ORDER BY created_at DESC LIMIT 1000`
  ).all();
  return { ok: true, bookings: results || [] };
}

const EDITABLE = ["pet", "pet_name", "service", "breed", "name", "phone", "date", "time", "note", "status", "source", "price", "staff", "weight", "client_id", "pet_id"];

async function adminUpdate(request, env) {
  requireAdmin(request, env);
  const body = await request.json();
  const id = body && body.id;
  if (!id) return { ok: false, error: "id required" };
  const sets = [], vals = [];
  for (const f of EDITABLE) {
    if (body[f] != null) { sets.push(`${f}=?`); vals.push(body[f]); }
  }
  if (sets.length) {
    vals.push(id);
    await env.DB.prepare(`UPDATE bookings SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();
  }
  let calendar = "unchanged";
  try { calendar = await syncCalendar(env, id); }
  catch (e) { calendar = "error: " + String(e && e.message || e); }
  return { ok: true, calendar };
}

async function adminCreate(request, env) {
  requireAdmin(request, env);
  const b = await request.json();
  if (!b || !b.name || !b.phone) return { ok: false, error: "Вкажіть ім'я і телефон" };
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
    `INSERT INTO bookings (created_at,pet,service,breed,name,phone,date,time,note,is_request,event_link,status,source,event_id,price,staff,weight,client_id,pet_id,pet_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    new Date().toISOString(), b.pet || "", b.service || "", b.breed || "",
    b.name || "", b.phone || "", b.date || "", b.time || "", b.note || "",
    hasTime ? 0 : 1, eventLink, b.status || "new", b.source || "phone", eventId,
    (b.price != null && b.price !== "") ? b.price : null, b.staff || "", b.weight || "",
    link.client_id, link.pet_id, b.pet_name || ""
  ).run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
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
  requireAdmin(request, env);
  const { results } = await env.DB.prepare(`SELECT * FROM clients ORDER BY name COLLATE NOCASE`).all();
  return { ok: true, clients: results || [] };
}
async function adminPets(request, env) {
  requireAdmin(request, env);
  const { results } = await env.DB.prepare(`SELECT * FROM pets ORDER BY name COLLATE NOCASE`).all();
  return { ok: true, pets: results || [] };
}
const CLIENT_FIELDS = ["name", "phone", "email", "messenger", "source", "note", "consent", "status"];
async function clientSave(request, env) {
  requireAdmin(request, env);
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
  requireAdmin(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  await env.DB.prepare(`DELETE FROM pets WHERE client_id=?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM clients WHERE id=?`).bind(id).run();
  return { ok: true };
}
const PET_FIELDS = ["client_id", "name", "species", "breed", "birthdate", "weight", "sex", "color",
  "allergies", "behavior", "reactions", "prefs", "vet_notes", "warnings", "special"];
async function petSave(request, env) {
  requireAdmin(request, env);
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
  requireAdmin(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  await env.DB.prepare(`DELETE FROM pets WHERE id=?`).bind(id).run();
  return { ok: true };
}

/* ----------------------------- Masters (schedule) ----------------------------- */
async function publicMasters(env) {
  const masters = await loadMasters(env);
  return { ok: true, masters: masters.filter(m => m.active).map(m => m.name) };
}
async function adminMasters(request, env) {
  requireAdmin(request, env);
  const { results } = await env.DB.prepare(`SELECT * FROM masters ORDER BY sort, id`).all();
  return { ok: true, masters: results || [] };
}
const MASTER_FIELDS = ["name", "active", "work_start", "work_end", "days_off", "vacations", "sort"];
async function masterSave(request, env) {
  requireAdmin(request, env);
  const b = await request.json();
  if (b.id) {
    const sets = [], vals = [];
    for (const f of MASTER_FIELDS) if (b[f] != null) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (sets.length) { vals.push(b.id); await env.DB.prepare(`UPDATE masters SET ${sets.join(",")} WHERE id=?`).bind(...vals).run(); }
    return { ok: true, id: b.id };
  }
  if (!b.name) return { ok: false, error: "name required" };
  const r = await env.DB.prepare(
    `INSERT INTO masters (name,active,work_start,work_end,days_off,vacations,sort) VALUES (?,?,?,?,?,?,?)`
  ).bind(b.name, b.active ? 1 : 0, b.work_start || "10:00", b.work_end || "20:00", b.days_off || "", b.vacations || "", b.sort || 0).run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
}
async function masterDelete(request, env) {
  requireAdmin(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  await env.DB.prepare(`DELETE FROM masters WHERE id=?`).bind(id).run();
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
  const bm = (rows || []).filter(r => { const l = normBreed(r[0]); return l && (l === b || b.includes(l) || l.includes(b)); });
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
async function loadAddonItems(env) {
  const items = {};
  (await loadServices(env)).forEach(s => { if (s.price_type === "addon" && s.active) (s.rows || []).forEach(r => { if (r[0]) items[r[0]] = r[r.length - 1]; }); });
  return items;
}
async function computeAddons(env, addons, base) {
  if (!Array.isArray(addons) || !addons.length) return { addTotal: 0, hasManual: false, names: [] };
  const items = await loadAddonItems(env);
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
  const ad = await computeAddons(env, b.addons, base);
  if ((b.price == null || b.price === "") && base != null) b.price = base + ad.addTotal;
  if (ad.names.length) b.note = (b.note ? b.note + " · " : "") + "Допи: " + ad.names.join(", ") + (ad.hasManual ? " (уточнити)" : "");
}
// Public: the full service+price list for the site (form + «Ціни»), single fetch.
async function publicCatalog(env) {
  const services = (await loadServices(env)).filter(s => s.active);
  const st = await loadSettings(env);
  return { ok: true, services, notes: { gift: st.note_gift || DEFAULT_PRICES.note_gift, big: st.note_big || DEFAULT_PRICES.note_big } };
}
async function adminServices(request, env) { requireAdmin(request, env); return { ok: true, services: await loadServices(env) }; }
async function serviceSave(request, env) {
  requireAdmin(request, env);
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
  requireAdmin(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
  await env.DB.prepare(`DELETE FROM services WHERE id=?`).bind(id).run();
  return { ok: true };
}

/* ----------------------------- Settings & reminders ----------------------------- */
async function loadSettings(env) {
  const def = { reminders_enabled: "1", repeat_weeks: "6" };
  if (!env.DB) return def;
  try {
    const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
    (results || []).forEach(r => { def[r.key] = r.value; });
  } catch (e) { }
  return def;
}
async function adminSettings(request, env) {
  requireAdmin(request, env);
  return { ok: true, settings: await loadSettings(env) };
}
async function settingsSave(request, env) {
  requireAdmin(request, env);
  const b = await request.json();
  for (const k of ["reminders_enabled", "repeat_weeks", "note_gift", "note_big"]) {
    if (b[k] != null) await env.DB.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?`).bind(k, String(b[k]), String(b[k])).run();
  }
  return { ok: true, settings: await loadSettings(env) };
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
  requireAdmin(request, env);
  const { id } = await request.json();
  if (!id) return { ok: false, error: "id required" };
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
    : b.isRequest ? "📩 <b>Нова заявка (готель/садочок)</b>" : "🗓️ <b>Новий запис</b>";
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
