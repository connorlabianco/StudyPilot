// My week: class times (found by the student's AI in the syllabus and course pages), the student's own sections,
// study blocks they paint, deadlines and exams. Pure functions (tested in Node); the week page and panel use them.
//
// Stored in chrome.storage.local "week":
//   blocks:     [{ id, day, start, end }]                 weekly study blocks (day 0 = Monday; times "HH:MM")
//   changes:    { "YYYY-MM-DD": { off: [blockId], add: [{ id, start, end }] } }   one-week changes to study blocks
//   classes:    { [courseId]: { meetings: [...], noClass: ["YYYY-MM-DD"], at } }
//   picks:      { [courseId]: { [groupKey]: sectionLabel | "none" } }           the student's own sections
//   showOffice: false
//   at:         last change (for sync)

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_WORDS = [/^mo/i, /^tu/i, /^we/i, /^th/i, /^fr/i, /^sa/i, /^su/i];
export const KINDS = ["lecture", "section", "lab", "office", "review", "exam", "other"];
export const KIND_LABEL = { lecture: "Lecture", section: "Section", lab: "Lab", office: "Office hours", review: "Review session", exam: "Exam", other: "Class" };
// Kinds where a course often has several options and each student goes to one.
// Lectures too, when a course has several lecture sections (each with its own "section" label).
export const CHOOSABLE = new Set(["section", "lab", "lecture"]);

export const emptyWeek = () => ({ blocks: [], changes: {}, classes: {}, picks: {}, showOffice: false, at: 0 });

// ---------- times and dates ----------
export function toMin(t) {
  const m = String(t || "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0);
  const ap = (m[3] || "").toLowerCase()[0];
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return h >= 0 && h <= 24 && min < 60 ? h * 60 + min : null;
}
export const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export function niceTime(t) {
  const min = typeof t === "number" ? t : toMin(t);
  if (min == null) return "";
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}
export const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const dayIndex = (d) => (d.getDay() + 6) % 7; // Monday = 0
export function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - dayIndex(x)); return x; }
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export function parseDay(v) {
  if (typeof v === "number" && v >= 0 && v <= 6) return v;
  const s = String(v || "").trim();
  const i = DAY_WORDS.findIndex((re) => re.test(s));
  return i >= 0 ? i : null;
}
// "MWF", "TR", "TTh", "MW" → [0, 2, 4] etc.
export function parseDayLetters(s) {
  const t = String(s || "").replace(/\s+/g, "");
  if (!/^[MTWRFSU]+$|^(M|Tu|W|Th|F|Sa|Su|T|R)+$/i.test(t)) return null;
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const two = t.slice(i, i + 2).toLowerCase();
    if (two === "th") { out.push(3); i++; } else if (two === "tu") { out.push(1); i++; } else if (two === "sa") { out.push(5); i++; } else if (two === "su") { out.push(6); i++; }
    else out.push({ m: 0, t: 1, w: 2, r: 3, f: 4, s: 5, u: 6 }[t[i].toLowerCase()]);
  }
  return out.filter((x) => x != null);
}

// ---------- the request ----------
export const SCHEDULE_FORMAT = `Reply with ONLY one code block tagged \`studypilot-schedule\`, written directly in your reply (not in an artifact, canvas or file), in exactly this shape:
\`\`\`studypilot-schedule
{"courses":[
  {"course":"<the course name exactly as I wrote it>","meetings":[
    {"kind":"lecture","label":"Lecture","days":["Mon","Wed","Fri"],"start":"10:00","end":"10:50","location":"<room or Zoom, if given>","who":"<instructor, if given>","section":null},
    {"kind":"section","label":"<as the course names it, e.g. Section 0103 or Dis 3>","days":["Wed"],"start":"09:00","end":"09:50","location":"…","who":"<TA, if given>","section":"<the section's own label>"},
    {"kind":"office","label":"Office hours","days":["Tue"],"start":"14:00","end":"15:00","location":"…","who":"<whose office hours>","section":null},
    {"kind":"review","label":"Midterm review","date":"2026-11-03","start":"18:00","end":"19:30","location":"…","who":"…","section":null}
  ],"noClass":["2026-11-11"]}
],"end":true}
\`\`\`
"kind" is one of: lecture, section, lab, office, review, exam, other. Use "section" for discussion sections, recitations and quiz sections; "lab" for labs.
List EVERY section and lab option the course lists, each as its own meeting with its own "section" label: each student goes to only one, and I'll pick mine.
If a course has several lecture sections (different students go to different lecture times), give each lecture meeting its own "section" label too; if everyone goes to the same lecture, use "section": null.
Times are 24-hour "HH:MM" in the course's local time. "days" for weekly meetings; "date" (YYYY-MM-DD) instead for one-time meetings like review sessions.
"noClass" lists dates with no class (holidays, cancelled lectures) if the material says so.
Only include what the material actually says. If a course gives no times at all, include it with an empty "meetings" list. End with "end": true.`;

export function classTimesPrompt(courses, { year = new Date().getFullYear() } = {}) {
  return `# Class times for my week

Below is text from my courses' syllabi and course pages (only the parts that mention days, times or places). For each course, find when and where it meets: lectures, every discussion section and lab option, office hours, review sessions and exams with times, and dates with no class. The current year is ${year}.

${SCHEDULE_FORMAT}

${courses.map((c) => `## ${c.name}\n${c.text || "(nothing found)"}`).join("\n\n")}`;
}

// ---------- reading the reply ----------
function blockJson(text, tag) {
  const t = String(text);
  const at = t.indexOf("```" + tag);
  const cands = [];
  if (at >= 0) { const rest = t.slice(at + tag.length + 3); const end = rest.lastIndexOf("```"); cands.push(end >= 0 ? rest.slice(0, end) : rest); }
  cands.push(t);
  for (const raw of cands) {
    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s < 0 || e < s) continue;
    try { return JSON.parse(raw.slice(s, e + 1)); } catch { /* next */ }
  }
  return null;
}

const str = (v, n = 120) => (v == null ? "" : String(v)).trim().slice(0, n);
let seq = 0;
const mid = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

/** One meeting from the AI (or typed by the student), checked. Returns null if it can't be placed on a calendar. */
export function normalizeMeeting(m, { source = "ai" } = {}) {
  const kind = KINDS.includes(String(m.kind).toLowerCase()) ? String(m.kind).toLowerCase() : "other";
  let days = [];
  if (Array.isArray(m.days)) days = m.days.map(parseDay).filter((d) => d != null);
  else if (typeof m.days === "string") days = parseDayLetters(m.days) || m.days.split(/[,/ ]+/).map(parseDay).filter((d) => d != null);
  days = [...new Set(days)].sort();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(m.date || "")) ? m.date : null;
  const start = toMin(m.start), end = toMin(m.end);
  if (start == null || end == null || end <= start || end - start > 6 * 60) return null;
  if (!days.length && !date) return null;
  return {
    id: m.id || mid(), kind, label: str(m.label, 60) || KIND_LABEL[kind], days: date ? [] : days, date,
    start: hhmm(start), end: hhmm(end), location: str(m.location, 100), who: str(m.who, 80),
    section: kind === "lecture" ? (str(m.section, 60) || null) : CHOOSABLE.has(kind) ? str(m.section || m.label, 60) : null, source,
  };
}

/** Parses the AI's schedule reply. names: the course names as sent, to match each block to a course id. */
export function parseSchedule(text, courses) {
  const obj = blockJson(text, "studypilot-schedule");
  if (!obj || !Array.isArray(obj.courses)) throw new Error("StudyPilot couldn't find the class times in that reply. Copy the AI's whole answer, including the block that starts with ```studypilot-schedule.");
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const out = {};
  for (const c of obj.courses) {
    const n = norm(c.course);
    const match = courses.find((x) => norm(x.name) === n) || courses.find((x) => n && (norm(x.name).includes(n) || n.includes(norm(x.code || x.name))));
    if (!match) continue;
    out[match.id] = {
      meetings: (c.meetings || []).map((m) => normalizeMeeting(m)).filter(Boolean).slice(0, 80),
      noClass: (c.noClass || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).slice(0, 60),
    };
  }
  if (!Object.keys(out).length) throw new Error("The reply didn't match any of your courses. Ask your AI to use the course names exactly as written.");
  return out;
}

/** New class times replace the AI's earlier ones for those courses; anything the student typed in stays. */
export function mergeClasses(week, found, at = Date.now()) {
  const classes = { ...(week.classes || {}) };
  for (const [id, c] of Object.entries(found)) {
    const mine = (classes[id]?.meetings || []).filter((m) => m.source === "manual");
    classes[id] = { meetings: [...c.meetings, ...mine], noClass: [...new Set([...(c.noClass || []), ...(classes[id]?.noClass || [])])], at };
  }
  return { ...week, classes, at };
}

// ---------- sections: each student goes to one ----------
// Options group by course + kind ("section" options together, "lab" options together).
export const groupKey = (m) => m.kind;
export function sectionGroups(meetings) {
  const groups = {};
  for (const m of meetings) if (CHOOSABLE.has(m.kind) && (m.kind !== "lecture" || m.section)) (groups[groupKey(m)] ||= new Set()).add(m.section || m.label);
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, [...v]]));
}
/** Is this meeting one of the student's? true (theirs / everyone's), false (another section), null (not picked yet). */
export function isMine(m, picks = {}, groups = null) {
  if (!CHOOSABLE.has(m.kind) || (m.kind === "lecture" && !m.section)) return true;
  const g = groups || {};
  const opts = g[groupKey(m)];
  if (!opts || opts.length === 1) return true; // only one option: it's everyone's
  const p = picks[groupKey(m)];
  if (p == null) return null;
  return p === (m.section || m.label);
}

// ---------- one week, expanded ----------
/**
 * Everything on the calendar for the week starting `monday` (a Date):
 * [{ type: "class"|"study"|"choose", date, day, start, end, ... }]
 */
export function weekEvents(week, monday, { courses = [], terms = {} } = {}) {
  const out = [];
  for (let d = 0; d < 7; d++) {
    const date = addDays(monday, d), key = ymd(date);
    // classes
    for (const c of courses) {
      const rec = week.classes?.[c.id];
      if (!rec) continue;
      const term = terms[c.id];
      if (term?.start && key < term.start) continue;
      if (term?.end && key > term.end) continue;
      const groups = sectionGroups(rec.meetings);
      const off = new Set(rec.noClass || []);
      for (const m of rec.meetings) {
        const on = m.date ? m.date === key : m.days.includes(d);
        if (!on) continue;
        if (!m.date && off.has(key) && m.kind !== "office") continue;
        if (m.kind === "office" && !week.showOffice) continue;
        const mine = isMine(m, week.picks?.[c.id], groups);
        if (mine === false) continue;
        out.push({ type: mine === null ? "choose" : "class", date: key, day: d, start: m.start, end: m.end, courseId: c.id, meeting: m, options: groups[groupKey(m)] || null });
      }
    }
    // study blocks: the weekly pattern, minus this week's removals, plus this week's additions
    const ch = week.changes?.[key] || {};
    for (const b of week.blocks || []) if (b.day === d && !(ch.off || []).includes(b.id)) out.push({ type: "study", date: key, day: d, start: b.start, end: b.end, id: b.id, repeat: true });
    for (const b of ch.add || []) out.push({ type: "study", date: key, day: d, start: b.start, end: b.end, id: b.id, repeat: false });
  }
  return out;
}

// Painting: merge touching/overlapping study blocks on a day; erasing cuts a range out.
export function mergeRanges(list) {
  const r = list.map((b) => [toMin(b.start), toMin(b.end), b]).filter(([a, b]) => a != null && b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of r) { const last = out[out.length - 1]; if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out;
}
export function cutRange(ranges, a, b) {
  const out = [];
  for (const [x, y] of ranges) { if (b <= x || a >= y) out.push([x, y]); else { if (x < a) out.push([x, a]); if (y > b) out.push([b, y]); } }
  return out;
}

/** Paints (or erases) [a, b) minutes on day d of the weekly pattern. Returns new blocks. */
export function paintWeekly(blocks, d, a, b, erase = false) {
  const day = blocks.filter((x) => x.day === d);
  const others = blocks.filter((x) => x.day !== d);
  let ranges = mergeRanges(day);
  ranges = erase ? cutRange(ranges, a, b) : mergeRanges([...ranges.map(([x, y]) => ({ start: hhmm(x), end: hhmm(y) })), { start: hhmm(a), end: hhmm(b) }]);
  return [...others, ...ranges.map(([x, y]) => ({ id: `b${d}-${x}-${y}`, day: d, start: hhmm(x), end: hhmm(y) }))];
}
/** Paints (or erases) [a, b) on one date only: the weekly blocks of that day become this date's own set. */
export function paintOnce(week, date, d, a, b, erase = false) {
  const ch = week.changes?.[date] || {};
  const current = [
    ...(week.blocks || []).filter((x) => x.day === d && !(ch.off || []).includes(x.id)),
    ...(ch.add || []),
  ];
  let ranges = mergeRanges(current);
  ranges = erase ? cutRange(ranges, a, b) : mergeRanges([...ranges.map(([x, y]) => ({ start: hhmm(x), end: hhmm(y) })), { start: hhmm(a), end: hhmm(b) }]);
  const weeklyIds = (week.blocks || []).filter((x) => x.day === d).map((x) => x.id);
  return { ...(week.changes || {}), [date]: { off: weeklyIds, add: ranges.map(([x, y]) => ({ id: `o${date}-${x}-${y}`, start: hhmm(x), end: hhmm(y) })) } };
}

// ---------- calendar file (.ics) ----------
// A time zone description for the file (Outlook needs it; Google and Apple use the name), worked out from the
// browser's own time zone rules: the yearly switch to and from daylight time, as "2nd Sunday of March" style rules.
function offsetMin(tz, t) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(t)).find((x) => x.type === "timeZoneName")?.value || "GMT";
  const m = p.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
}
const fmtOff = (m) => `${m < 0 ? "-" : "+"}${String(Math.floor(Math.abs(m) / 60)).padStart(2, "0")}${String(Math.abs(m) % 60).padStart(2, "0")}`;
export function vtimezone(tz, year = new Date().getFullYear()) {
  const L = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
  const changes = [];
  try {
    let prev = offsetMin(tz, Date.UTC(year, 0, 1));
    for (let d = 1; d <= 366; d++) {
      const t = Date.UTC(year, 0, 1) + d * 864e5;
      const cur = offsetMin(tz, t);
      if (cur !== prev) {
        // find the hour it changed
        let lo = t - 864e5, hi = t;
        while (hi - lo > 60e3) { const mid = Math.floor((lo + hi) / 2); if (offsetMin(tz, mid) === prev) lo = mid; else hi = mid; }
        changes.push({ at: hi, from: prev, to: cur });
        prev = cur;
      }
    }
  } catch { /* unknown zone: plain block below */ }
  if (!changes.length) {
    const o = (() => { try { return offsetMin(tz, Date.now()); } catch { return 0; } })();
    L.push("BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${fmtOff(o)}`, `TZOFFSETTO:${fmtOff(o)}`, "END:STANDARD", "END:VTIMEZONE");
    return L;
  }
  const BY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  for (const c of changes) {
    const local = new Date(c.at + c.from * 60e3); // wall-clock time just before the switch
    const mo = local.getUTCMonth() + 1, day = local.getUTCDate(), wd = local.getUTCDay();
    const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), mo, 0)).getUTCDate();
    const nth = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7);
    const kind = c.to > c.from ? "DAYLIGHT" : "STANDARD";
    L.push(`BEGIN:${kind}`, `DTSTART:1970${String(mo).padStart(2, "0")}${String(day).padStart(2, "0")}T${String(local.getUTCHours()).padStart(2, "0")}${String(local.getUTCMinutes()).padStart(2, "0")}00`,
      `TZOFFSETFROM:${fmtOff(c.from)}`, `TZOFFSETTO:${fmtOff(c.to)}`, `RRULE:FREQ=YEARLY;BYMONTH=${mo};BYDAY=${nth}${BY[wd]}`, `END:${kind}`);
  }
  L.push("END:VTIMEZONE");
  return L;
}
const icsText = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => `\\${c}`);
const icsLocal = (date, t) => `${date.replace(/-/g, "")}T${t.replace(":", "")}00`;
const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
function fold(line) { const out = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = " " + s.slice(74); } out.push(s); return out.join("\r\n"); }

/**
 * A calendar file with weekly classes and study blocks (repeating until `until`), one-time meetings,
 * and deadlines and exams. tz: the student's time zone name.
 */
export function buildIcs(week, { courses = [], terms = {}, deadlines = [], exams = [], from = new Date(), until, tz = "UTC", stamp = new Date() }) {
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//StudyPilot//My week//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:StudyPilot", `X-WR-TIMEZONE:${tz}`, ...vtimezone(tz, from.getFullYear())];
  const dtstamp = stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const end = until || ymd(addDays(from, 7 * 16));
  const untilUtc = `${end.replace(/-/g, "")}T235959Z`;
  const mon = mondayOf(from);
  const firstDate = (d) => ymd(addDays(mon, d));
  let n = 0;
  const ev = (props) => { L.push("BEGIN:VEVENT", `UID:sp-${dtstamp}-${n++}@studypilot`, `DTSTAMP:${dtstamp}`, ...props.filter(Boolean).map(fold), "END:VEVENT"); };
  const nameOf = (id) => { const c = courses.find((x) => String(x.id) === String(id)); return c ? c.code || c.name : "Class"; };
  for (const c of courses) {
    const rec = week.classes?.[c.id];
    if (!rec) continue;
    const groups = sectionGroups(rec.meetings);
    const cEnd = terms[c.id]?.end && terms[c.id].end < end ? terms[c.id].end : end;
    for (const m of rec.meetings) {
      if (m.kind === "office" && !week.showOffice) continue;
      if (isMine(m, week.picks?.[c.id], groups) !== true) continue;
      const title = `${nameOf(c.id)} ${m.label}`;
      const desc = [m.who, m.kind === "office" ? "Office hours" : ""].filter(Boolean).join(" · ");
      if (m.date) { ev([`SUMMARY:${icsText(title)}`, `DTSTART;TZID=${tz}:${icsLocal(m.date, m.start)}`, `DTEND;TZID=${tz}:${icsLocal(m.date, m.end)}`, m.location && `LOCATION:${icsText(m.location)}`, desc && `DESCRIPTION:${icsText(desc)}`]); continue; }
      for (const d of m.days) {
        const first = firstDate(d);
        const ex = (rec.noClass || []).filter((x) => parseDayOfDate(x) === d && m.kind !== "office").map((x) => icsLocal(x, m.start));
        ev([`SUMMARY:${icsText(title)}`, `DTSTART;TZID=${tz}:${icsLocal(first, m.start)}`, `DTEND;TZID=${tz}:${icsLocal(first, m.end)}`,
          `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[d]};UNTIL=${cEnd.replace(/-/g, "")}T235959Z`, ex.length && `EXDATE;TZID=${tz}:${ex.join(",")}`,
          m.location && `LOCATION:${icsText(m.location)}`, desc && `DESCRIPTION:${icsText(desc)}`]);
      }
    }
  }
  for (const b of week.blocks || []) {
    const first = firstDate(b.day);
    const ex = Object.entries(week.changes || {}).filter(([date, ch]) => (ch.off || []).includes(b.id)).map(([date]) => icsLocal(date, b.start));
    ev(["SUMMARY:Study (StudyPilot)", `DTSTART;TZID=${tz}:${icsLocal(first, b.start)}`, `DTEND;TZID=${tz}:${icsLocal(first, b.end)}`, `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[b.day]};UNTIL=${untilUtc}`, ex.length && `EXDATE;TZID=${tz}:${ex.join(",")}`]);
  }
  for (const [date, ch] of Object.entries(week.changes || {})) for (const b of ch.add || []) ev(["SUMMARY:Study (StudyPilot)", `DTSTART;TZID=${tz}:${icsLocal(date, b.start)}`, `DTEND;TZID=${tz}:${icsLocal(date, b.end)}`]);
  for (const x of deadlines) {
    const t = new Date(x.due_at);
    if (!(t > from)) continue;
    const s = t.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const e = new Date(t.getTime() + 15 * 60e3).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    ev([`SUMMARY:${icsText(`Due: ${x.name} (${nameOf(x.courseId)})`)}`, `DTSTART:${s}`, `DTEND:${e}`, x.url && `URL:${x.url}`]);
  }
  for (const x of exams) {
    if (!x.date) continue;
    const d = String(x.date).slice(0, 10);
    if (x.time && toMin(x.time) != null) ev([`SUMMARY:${icsText(`${x.title || "Exam"} (${nameOf(x.courseId)})`)}`, `DTSTART;TZID=${tz}:${icsLocal(d, hhmm(toMin(x.time)))}`, `DTEND;TZID=${tz}:${icsLocal(d, hhmm(Math.min(24 * 60 - 1, toMin(x.time) + 120)))}`]);
    else ev([`SUMMARY:${icsText(`${x.title || "Exam"} (${nameOf(x.courseId)})`)}`, `DTSTART;VALUE=DATE:${d.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${ymd(addDays(new Date(`${d}T12:00:00`), 1)).replace(/-/g, "")}`]);
  }
  L.push("END:VCALENDAR");
  return L.join("\r\n") + "\r\n";
}
function parseDayOfDate(s) { const d = new Date(`${s}T12:00:00`); return dayIndex(d); }

// ---------- finding the text that mentions times ----------
const TIME_RE = /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)|\b\d{1,2}:\d{2}\b|\bnoon\b/i;
const DAY_RE = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|s|\.)?\b|\b(MWF|MW|TR|TTh|TuTh|WF|MTWR|MTWRF)\b/i;
const PLACE_RE = /\b(office hours?|section|discussion|recitation|lab(oratory)?|lecture|meets?|meeting|room|hall|building|bldg|zoom|location|no class|holiday|cancel(l)?ed|review session|midterm|final exam)\b/i;
/** The lines of a document that talk about when and where things meet, with a line of context on each side. */
export function timeSnippets(text, { max = 6000 } = {}) {
  const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const keep = new Set();
  lines.forEach((l, i) => {
    const hits = (TIME_RE.test(l) ? 2 : 0) + (DAY_RE.test(l) ? 1 : 0) + (PLACE_RE.test(l) ? 1 : 0);
    if (hits >= 2 || (TIME_RE.test(l) && l.length < 200)) { keep.add(i - 1); keep.add(i); keep.add(i + 1); }
  });
  const out = [];
  let len = 0, last = -2;
  for (const i of [...keep].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b)) {
    const l = lines[i].slice(0, 400);
    if (len + l.length > max) break;
    if (i > last + 1 && out.length) out.push("…");
    out.push(l); len += l.length + 1; last = i;
  }
  return out.join("\n");
}

// ---------- announcements that may change class times ----------
const ABOUT = /\b(office hours?|section|discussion|recitation|lab|lecture|class(es)?|review session)\b/i;
const CHANGE = /\b(mov(e|ed|ing)|chang(e|ed|ing)|cancel(l)?(ed|ing)?|reschedul\w*|postpon\w*|new (time|room|location)|room|location|instead|zoom|online|no (class|lecture|section|office hours))\b/i;
/** Recent announcements that look like they change when or where a class meets (after the class times were found). */
export function timeChangeNotices(announcements = [], week = {}, { now = Date.now() } = {}) {
  const dismissed = new Set(week.dismissed || []);
  return announcements.filter((a) => {
    const rec = week.classes?.[a.course_id];
    if (!rec?.meetings?.length || dismissed.has(a.id)) return false;
    const at = Date.parse(a.posted_at || 0);
    if (!(at > (rec.at || 0) - 864e5) || now - at > 21 * 864e5) return false;
    const text = `${a.title}\n${a.message || ""}`;
    return ABOUT.test(text) && CHANGE.test(text);
  });
}
