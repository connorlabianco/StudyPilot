// Finds exam dates in course text (syllabus, schedule pages, announcements) and in Canvas itself
// (assignments and calendar events named like exams). Pure functions (testable in Node).

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY_RE = "(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|rsday|urday|sday)?\\.?,?\\s+)?";
const DATE_RES = [
  // "Wednesday, October 28, 2026", "Oct. 28th", "28 October"
  new RegExp(`${WEEKDAY_RE}\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "i"),
  new RegExp(`${WEEKDAY_RE}\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?(?:,?\\s+(\\d{4}))?`, "i"),
  // "10/28", "10/28/2026", "10-28-26"
  /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/,
];
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i;

// What counts as an exam: midterms, finals (not "final project/paper/report"), exams, tests, prelims.
const EXAM_RE = /\b((?:(?:first|second|third|1st|2nd|3rd)\s+)?mid-?term(?:\s*(?:exam)?\s*(?:#\s*)?(?:\d|i{1,3}\b|one|two))?|final\s+exam(?:ination)?|final(?!\s+(?:project|paper|report|presentation|grade|draft|submission|portfolio|version|lab|homework|hw|essay))\b|(?:exam|test|prelim)(?:\s*(?:#\s*)?(?:\d|i{1,3}\b))?)/i;
const NOT_EXAM = /\b(practice|review session|sample|solutions?|study guide|regrade|make-?up policy|no exam|take-?home quiz|grades? (?:posted|released)|returned)\b/i;

function titleFor(m) {
  let t = m.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^final/.test(t)) return "Final exam";
  if (/mid-?term/.test(t)) {
    const o = t.match(/^(first|second|third|1st|2nd|3rd)\s/);
    const n = t.match(/(\d|iii|ii|i\b|one|two)\s*$/);
    const num = o ? { first: 1, second: 2, third: 3, "1st": 1, "2nd": 2, "3rd": 3 }[o[1]] : n ? { i: 1, ii: 2, iii: 3, one: 1, two: 2 }[n[1]] || n[1] : "";
    return `Midterm${num ? " " + num : ""}`;
  }
  const n = t.match(/(\d|iii|ii|i\b)\s*$/);
  const base = /prelim/.test(t) ? "Prelim" : /test/.test(t) ? "Test" : "Exam";
  return n ? `${base} ${({ i: 1, ii: 2, iii: 3 })[n[1]] || n[1]}` : base;
}

// Pick the year that puts the date closest to the reference date (the course term).
function resolveDate(month, day, year, ref) {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  if (year) { const y = year < 100 ? 2000 + year : year; return new Date(y, month, day); }
  const r = new Date(ref);
  const cands = [r.getFullYear() - 1, r.getFullYear(), r.getFullYear() + 1].map((y) => new Date(y, month, day));
  return cands.sort((a, b) => Math.abs(a - r) - Math.abs(b - r))[0];
}

export function findDate(text, ref = Date.now()) {
  for (let i = 0; i < DATE_RES.length; i++) {
    const m = text.match(DATE_RES[i]);
    if (!m) continue;
    let month, day, year;
    if (i === 0) { month = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith("sept") ? 4 : 3)]; day = +m[2]; year = m[3] ? +m[3] : null; }
    else if (i === 1) { day = +m[1]; month = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith("sept") ? 4 : 3)]; year = m[3] ? +m[3] : null; }
    else { month = +m[1] - 1; day = +m[2]; year = m[3] ? +m[3] : null; }
    if (month == null) continue;
    const d = resolveDate(month, day, year, ref);
    if (!d || isNaN(d)) continue;
    const t = text.slice(m.index).match(TIME_RE);
    if (t && t.index < 40) {
      let h = +t[1] % 12; if (/p/i.test(t[3])) h += 12;
      d.setHours(h, t[2] ? +t[2] : 0, 0, 0);
      return { date: d, hasTime: true, index: m.index };
    }
    return { date: d, hasTime: false, index: m.index };
  }
  return null;
}

/**
 * text → [{ title, date (ISO), hasTime, snippet }]
 * Looks at each line; an exam word and a date on the same line (or the date on the next line, as in tables).
 */
export function findExamDates(text, { ref = Date.now() } = {}) {
  const lines = String(text || "").replace(/\r/g, "").split(/\n|(?<=[.;])\s+(?=[A-Z])/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 300 || NOT_EXAM.test(line)) continue;
    const em = line.match(EXAM_RE);
    if (!em) continue;
    // Percentages ("Midterm 30%") are grading weights, not dates.
    let found = findDate(line, ref);
    let snippet = line;
    if (!found && lines[i + 1] && lines[i + 1].length < 120 && !EXAM_RE.test(lines[i + 1])) { found = findDate(lines[i + 1], ref); snippet = `${line} ${lines[i + 1]}`; }
    if (!found) continue;
    out.push({ title: titleFor(em[1]), date: found.date.toISOString(), hasTime: found.hasTime, snippet: snippet.slice(0, 200) });
  }
  return dedupe(out);
}

export function dedupe(list) {
  const seen = new Map();
  for (const e of list) {
    const k = `${e.title.toLowerCase()}|${e.date.slice(0, 10)}`;
    const prev = seen.get(k);
    if (!prev || (e.hasTime && !prev.hasTime) || (e.rank || 0) > (prev.rank || 0)) seen.set(k, { ...prev, ...e });
  }
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export const looksLikeExam = (name) => EXAM_RE.test(name || "") && !NOT_EXAM.test(name || "");

/**
 * Combine every source for one course. Canvas assignments and calendar events with dates are most reliable,
 * then announcements (newest wins, since they announce changes), then syllabus/schedule text.
 * sources: { assignments: [{name, due_at}], events: [{title, start_at}], announcements: [{title, message, posted_at}], texts: [{name, text}] }
 */
export function collectExams({ assignments = [], events = [], announcements = [], texts = [] }, { ref = Date.now() } = {}) {
  const out = [];
  for (const a of assignments) if (a.due_at && looksLikeExam(a.name)) out.push({ title: a.name, date: a.due_at, hasTime: true, source: "Canvas assignment", rank: 3 });
  for (const e of events) if (e.start_at && looksLikeExam(e.title)) out.push({ title: e.title, date: e.start_at, hasTime: !e.all_day, source: "Canvas calendar", rank: 3 });
  const sortedAnn = [...announcements].sort((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)));
  for (const a of sortedAnn) for (const x of findExamDates(`${a.title}\n${a.message || ""}`, { ref: a.posted_at ? Date.parse(a.posted_at) : ref }))
    out.push({ ...x, source: `Announcement: ${a.title}`.slice(0, 80), rank: 2 });
  for (const t of texts) for (const x of findExamDates(t.text, { ref })) out.push({ ...x, source: t.name, rank: 1 });

  // Same exam named slightly differently ("Midterm 1" vs "Midterm Exam 1"): keep the best-ranked per day.
  const byDay = new Map();
  for (const e of out) {
    const key = `${e.date.slice(0, 10)}|${titleFor(e.title.match(EXAM_RE)?.[1] || e.title)}`;
    const prev = byDay.get(key);
    if (!prev || e.rank > prev.rank || (e.rank === prev.rank && e.hasTime && !prev.hasTime)) byDay.set(key, e);
  }
  // A later announcement can move an exam: if the same exam title has several dates, prefer higher rank, then the announcement.
  const byTitle = new Map();
  for (const e of byDay.values()) {
    const k = titleFor(e.title.match(EXAM_RE)?.[1] || e.title);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(e);
  }
  const final = [];
  for (const [k, list] of byTitle) {
    if (/^Exam$|^Test$/.test(k)) { final.push(...list); continue; } // generic names can be several exams
    list.sort((a, b) => b.rank - a.rank);
    const best = list[0];
    final.push({ ...best, also: list.slice(1).map((x) => ({ date: x.date, source: x.source })) });
  }
  return final.sort((a, b) => a.date.localeCompare(b.date));
}
