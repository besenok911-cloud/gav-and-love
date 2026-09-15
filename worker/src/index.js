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
      return json({ ok: false, error: "not found" }, cors, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, cors, e && e.status || 500);
    }
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

async function getSlots(url, env) {
  const { y, m, d } = parseDate(url.searchParams.get("date"));
  const service = url.searchParams.get("service") || "";
  const staff = url.searchParams.get("staff") || "";     // "" = будь-який майстер
  const duration = SERVICE_DURATIONS[service] || DEFAULT_DURATION;

  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (!BUSINESS.workingDays.includes(dow)) return { ok: true, slots: [] };

  const token = await getAccessToken(env);
  const dayStart = wallToUTC(y, m, d, 0, BUSINESS.tz);
  const dayEnd = wallToUTC(y, m, d, 24 * 60, BUSINESS.tz);
  const events = await listEvents(env, token, dayStart, dayEnd);

  const earliest = Date.now() + BUSINESS.minLeadMin * 60000;
  const maxTime = Date.now() + BUSINESS.maxAheadDays * 86400000;
  const slots = [];
  for (let t = BUSINESS.openMin; t + duration <= BUSINESS.closeMin; t += BUSINESS.slotStepMin) {
    const start = wallToUTC(y, m, d, t, BUSINESS.tz).getTime();
    const end = start + duration * 60000;
    if (start < earliest || start > maxTime) continue;
    if (slotFree(events, start, end, staff)) slots.push(hhmm(t));
  }
  return { ok: true, slots };
}

async function book(body, env) {
  const { pet, service, breed, name, phone, date, time, note, weight } = body || {};
  let staff = (body && body.staff) || "";
  if (!name || !phone) return { ok: false, error: "Вкажіть ім'я і телефон" };
  if (staff && !STAFF.includes(staff)) staff = "";      // ignore unknown master

  const isRequest = REQUEST_SERVICES.has(service) || !time;
  let eventLink = null, eventId = null;

  if (!isRequest) {
    const { y, m, d } = parseDate(date);
    const tm = /^(\d{2}):(\d{2})$/.exec(time);
    if (!tm) return { ok: false, error: "bad time" };
    const startMin = (+tm[1]) * 60 + (+tm[2]);
    const duration = SERVICE_DURATIONS[service] || DEFAULT_DURATION;

    const token = await getAccessToken(env);
    const start = wallToUTC(y, m, d, startMin, BUSINESS.tz);
    const end = new Date(start.getTime() + duration * 60000);
    // re-check availability (per chosen master, or capacity for "any")
    const events = await listEvents(env, token,
      new Date(start.getTime() - BUSINESS.bufferMin * 60000),
      new Date(end.getTime() + BUSINESS.bufferMin * 60000));
    if (!slotFree(events, start.getTime(), end.getTime(), staff)) {
      return { ok: false, error: "На жаль, цей час щойно зайняли. Оберіть інший, будь ласка." };
    }
    if (!staff) staff = pickFreeStaff(events, start.getTime(), end.getTime()) || "";  // auto-assign a free master

    const ev = await calCreate(env, token, { pet, service, breed, weight, name, phone, note, date, time, staff, source: "site" });
    eventLink = ev.htmlLink;
    eventId = ev.id;
  }

  await notifyTelegram(env, { pet, service, breed, name, phone, date, time, note, isRequest, staff });
  await saveBooking(env, { pet, service, breed, weight, name, phone, date, time, note, isRequest, eventLink, eventId, staff });
  return { ok: true, request: isRequest, staff };
}

/* ----------------------------- Calendar events ----------------------------- */
function calEventBody(b) {
  const { y, m, d } = parseDate(b.date);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(b.time || "");
  const startMin = (+tm[1]) * 60 + (+tm[2]);
  const duration = SERVICE_DURATIONS[b.service] || DEFAULT_DURATION;
  const src = { site: "сайт", phone: "телефон", instagram: "Instagram", manual: "вручну", other: "вручну" }[b.source] || b.source || "—";
  const price = (b.price != null && b.price !== "") ? `\nСума: ${b.price} ₴` : "";
  const petLine = [b.breed, b.weight].filter(Boolean).join(", ") || "—";
  return {
    summary: `${b.pet || "🐾"} · ${b.service || "грумінг"} — ${b.name || ""}${b.staff ? " · " + b.staff : ""}`,
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
  const res = await fetch(calUrl(env), { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(calEventBody(b)) });
  const ev = await res.json();
  if (!ev.id) throw new Error("event insert failed: " + JSON.stringify(ev));
  return ev;
}
async function calPatch(env, token, id, b) {
  const res = await fetch(calUrl(env, id), { method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(calEventBody(b)) });
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
    await env.DB.prepare(
      `INSERT INTO bookings (created_at,pet,service,breed,name,phone,date,time,note,is_request,event_link,status,source,event_id,price,staff,weight)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'new', 'site', ?, ?, ?, ?)`
    ).bind(
      new Date().toISOString(), b.pet || "", b.service || "", b.breed || "",
      b.name || "", b.phone || "", b.date || "", b.time || "", b.note || "",
      b.isRequest ? 1 : 0, b.eventLink || null, b.eventId || null,
      (b.price != null && b.price !== "") ? b.price : null, b.staff || "", b.weight || ""
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

const EDITABLE = ["pet", "service", "breed", "name", "phone", "date", "time", "note", "status", "source", "price", "staff", "weight"];

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
  const hasTime = !!(b.date && b.time);
  let eventId = null, eventLink = null;
  if (hasTime && (b.status || "new") !== "cancelled") {
    try {
      const token = await getAccessToken(env);
      const ev = await calCreate(env, token, b);
      eventId = ev.id; eventLink = ev.htmlLink;
    } catch (e) { /* keep the record even if calendar fails */ }
  }
  const r = await env.DB.prepare(
    `INSERT INTO bookings (created_at,pet,service,breed,name,phone,date,time,note,is_request,event_link,status,source,event_id,price,staff,weight)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    new Date().toISOString(), b.pet || "", b.service || "", b.breed || "",
    b.name || "", b.phone || "", b.date || "", b.time || "", b.note || "",
    hasTime ? 0 : 1, eventLink, b.status || "new", b.source || "phone", eventId,
    (b.price != null && b.price !== "") ? b.price : null, b.staff || "", b.weight || ""
  ).run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
}

// Keep the Google Calendar event in sync with the CRM row (source of truth).
async function syncCalendar(env, id) {
  if (!env.DB || !env.CALENDAR_ID || !env.SA_EMAIL) return "skip";
  const row = await env.DB.prepare(`SELECT * FROM bookings WHERE id=?`).bind(id).first();
  if (!row) return "no-row";
  const hasTime = !!(row.date && row.time);
  const active = hasTime && row.status !== "cancelled";
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
  const head = b.isRequest ? "📩 <b>Нова заявка (готель/pawplay)</b>" : "🗓️ <b>Новий запис</b>";
  const when = b.isRequest ? (b.date ? `\n📅 Бажана дата: ${b.date}` : "") : `\n📅 ${b.date} о ${b.time}`;
  const text =
    `${head}\n\n🐾 ${b.pet || "—"} · ${b.breed || ""}\n✂️ ${b.service}${when}\n👤 ${b.name}\n📞 ${b.phone}` +
    (b.note ? `\n💬 ${b.note}` : "");
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
  });
}
