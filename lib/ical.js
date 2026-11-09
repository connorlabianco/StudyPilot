// Reads an .ics calendar feed (Google "secret address in iCal format", Outlook, Apple) into busy blocks.
// Handles time zones, all-day events, cancelled/free events, and repeating events (daily/weekly/monthly)
// with INTERVAL, COUNT, UNTIL, BYDAY, EXDATE and single-instance changes (RECURRENCE-ID).

const DAY = 864e5;
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function unfold(text) { return String(text).replace(/\r?\n[ \t]/g, ""); }

function parseProps(block) {
  const props = [];
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(";");
    const p = {};
    for (const kv of params) { const [k, v] = kv.split("="); p[k.toUpperCase()] = (v || "").replace(/^"|"$/g, ""); }
    props.push({ name: name.toUpperCase(), params: p, value: line.slice(i + 1) });
  }
  return props;
}

// Offset (ms) of a time zone at a UTC instant.
function tzOffset(utcMs, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

// Wall-clock time in a zone → UTC ms (two passes handle DST edges).
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  if (!tz) return guess;
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}

const validTz = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

// Windows zone names that Outlook feeds sometimes use
const WIN_TZ = { "Pacific Standard Time": "America/Los_Angeles", "Mountain Standard Time": "America/Denver", "Central Standard Time": "America/Chicago", "Eastern Standard Time": "America/New_York", "GMT Standard Time": "Europe/London", "W. Europe Standard Time": "Europe/Berlin", "India Standard Time": "Asia/Kolkata", "China Standard Time": "Asia/Shanghai", "Tokyo Standard Time": "Asia/Tokyo", "AUS Eastern Standard Time": "Australia/Sydney" };

// Returns { allDay, wall: {y,mo,d,h,mi,s}, tz, utc }
function parseDate(prop, fallbackTz) {
  const v = prop.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const wall = { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  const allDay = prop.params.VALUE === "DATE" || !m[4];
  let tz = null;
  if (m[7]) tz = "UTC";
  else if (prop.params.TZID) { const t = WIN_TZ[prop.params.TZID] || prop.params.TZID; tz = validTz(t) ? t : fallbackTz; }
  else tz = fallbackTz;
  const utc = zonedToUtc(wall.y, wall.mo, wall.d, wall.h, wall.mi, wall.s, tz === "UTC" ? null : tz);
  return { allDay, wall, tz, utc };
}

function parseDuration(v) {
  const m = String(v).match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return ((+m[2] || 0) * 7 * DAY + (+m[3] || 0) * DAY + (+m[4] || 0) * 3600e3 + (+m[5] || 0) * 60e3 + (+m[6] || 0) * 1e3) * (m[1] === "-" ? -1 : 1);
}

function parseRule(v) {
  const r = Object.fromEntries(v.split(";").map((kv) => kv.split("=")).map(([k, x]) => [k.toUpperCase(), x]));
  return {
    freq: r.FREQ, interval: Math.max(1, +r.INTERVAL || 1), count: r.COUNT ? +r.COUNT : null,
    until: r.UNTIL || null, byday: r.BYDAY ? r.BYDAY.split(",").map((d) => d.replace(/^[+-]?\d+/, "")) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null,
  };
}

/**
 * Busy blocks between `from` and `to` (ms). Returns [{start, end}] as ISO strings, merged and sorted.
 * `tz` is the student's zone, used for floating times.
 */
export function icsBusy(text, { from = Date.now(), to = Date.now() + 14 * DAY, tz = "UTC", max = 400 } = {}) {
  const src = unfold(text);
  const blocks = [...src.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)].map((m) => parseProps(m[1]));
  const overrides = new Map(); // UID → Set of RECURRENCE-ID utc
  const events = [];
  for (const props of blocks) {
    const get = (n) => props.find((p) => p.name === n);
    const all = (n) => props.filter((p) => p.name === n);
    const status = get("STATUS")?.value.toUpperCase();
    const transp = get("TRANSP")?.value.toUpperCase();
    const ds = get("DTSTART") && parseDate(get("DTSTART"), tz);
    if (!ds) continue;
    const uid = get("UID")?.value || Math.random().toString(36);
    const rid = get("RECURRENCE-ID") && parseDate(get("RECURRENCE-ID"), tz);
    if (rid) { if (!overrides.has(uid)) overrides.set(uid, new Set()); overrides.get(uid).add(rid.utc); }
    if (status === "CANCELLED" || transp === "TRANSPARENT" || ds.allDay) continue;
    const de = get("DTEND") && parseDate(get("DTEND"), tz);
    const dur = de ? de.utc - ds.utc : get("DURATION") ? parseDuration(get("DURATION").value) : 0;
    if (dur <= 0) continue;
    const exdates = new Set(all("EXDATE").flatMap((p) => p.value.split(",").map((v) => parseDate({ value: v, params: p.params }, tz)?.utc)).filter(Boolean));
    const rrule = get("RRULE") && !rid ? parseRule(get("RRULE").value) : null;
    events.push({ uid, ds, dur, exdates, rrule, isOverride: !!rid });
  }

  const out = [];
  const push = (s, e) => { if (e > from && s < to) out.push([Math.max(s, from), Math.min(e, to)]); };

  for (const ev of events) {
    const skip = (t) => ev.exdates.has(t) || (!ev.isOverride && overrides.get(ev.uid)?.has(t));
    if (!ev.rrule) { if (!skip(ev.ds.utc)) push(ev.ds.utc, ev.ds.utc + ev.dur); continue; }

    const r = ev.rrule;
    const until = r.until ? (parseDate({ value: r.until, params: {} }, ev.ds.tz)?.utc ?? Infinity) : Infinity;
    const { wall, tz: etz } = ev.ds;
    const zone = etz === "UTC" ? null : etz;
    const at = (y, mo, d) => zonedToUtc(y, mo, d, wall.h, wall.mi, wall.s, zone);
    let n = 0;
    const emit = (t) => {
      if (t < ev.ds.utc) return true;
      if (t > until || t > to || (r.count != null && n >= r.count)) return false;
      n++;
      if (!skip(t)) push(t, t + ev.dur);
      return true;
    };
    const startDay = Date.UTC(wall.y, wall.mo, wall.d);

    if (r.freq === "DAILY") {
      for (let i = 0; i < 4000; i++) {
        const d = new Date(startDay + i * r.interval * DAY);
        if (!emit(at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))) break;
      }
    } else if (r.freq === "WEEKLY") {
      const days = (r.byday?.length ? r.byday : [Object.keys(WD)[new Date(startDay).getUTCDay()]]).map((x) => WD[x]).filter((x) => x != null).sort();
      const weekStart = startDay - new Date(startDay).getUTCDay() * DAY;
      outer: for (let w = 0; w < 1000; w++) {
        for (const wd of days) {
          const d = new Date(weekStart + (w * r.interval * 7 + wd) * DAY);
          if (!emit(at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))) break outer;
        }
      }
    } else if (r.freq === "MONTHLY") {
      const mdays = r.bymonthday?.length ? r.bymonthday : [wall.d];
      outer2: for (let i = 0; i < 400; i++) {
        const y = wall.y + Math.floor((wall.mo + i * r.interval) / 12), mo = (wall.mo + i * r.interval) % 12;
        for (const md of mdays) {
          const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
          const day = md < 0 ? last + md + 1 : md;
          if (day < 1 || day > last) continue;
          if (!emit(at(y, mo, day))) break outer2;
        }
      }
    } else if (!skip(ev.ds.utc)) {
      push(ev.ds.utc, ev.ds.utc + ev.dur); // unsupported rule: at least the first one
    }
  }

  // merge overlapping blocks
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of out) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else merged.push([s, e]);
  }
  return merged.slice(0, max).map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() }));
}

// webcal:// → https://, and basic sanity checks
export function normalizeFeedUrl(input) {
  const u = new URL(String(input).trim().replace(/^webcals?:\/\//i, "https://"));
  if (u.protocol !== "https:") throw new Error("Use the https or webcal link of your calendar.");
  return u.toString();
}
