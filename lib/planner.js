// Study plan. The student's AI makes the judgment calls (how big each assignment is, read once from its files;
// what matters most this week); StudyPilot fits the work into the study time the student marked on My week,
// every day, and moves anything missed. Pure functions (tested in Node).
//
// chrome.storage.local:
//   plan:      { selection, tasks: [...], advice, at, from, to, left0: { ref: items left at plan time } }
//   planSizes: { "a:<course>:<id>": { hours, parts, needs, hard, at, due } }   (one AI read per assignment)
//   planDone:  { ref: minutes done }
//   planDay:   { date, at, chunks: [{ id, ref, title, start, end, minutes, done }] }   today's plan, frozen for the day

import { toMin, hhmm, ymd, addDays, mondayOf, weekEvents } from "./schedule.js";
import { allItems, itemLevel } from "./checklist.js";

// ---------- shared ----------
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
const str = (v, n = 160) => (v == null ? "" : String(v)).trim().slice(0, n);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtHours = (min) => (min >= 90 ? `${Math.round(min / 6) / 10} h` : `${Math.round(min)} min`);

// ---------- 1. sizing assignments (once each) ----------
export const SIZES_FORMAT = `Reply with ONLY one code block tagged \`studypilot-sizes\`, written directly in your reply (not in an artifact, canvas or file), in exactly this shape:
\`\`\`studypilot-sizes
{"assignments":[
  {"ref":"<the ref given>","hours":4,"parts":["Problems 1–2: about 1 h","Problem 3: about 2 h (the longest)"],"needs":["<titles of lectures it uses, from my list>"],"hard":"<the hardest part, in a few words>"}
],"end":true}
\`\`\`
"hours" is the total time a student who has studied the lectures would need, including reading the instructions and checking work. Be realistic, not optimistic. Include every assignment I listed, and end with "end": true.`;

export function sizesPrompt({ items, lectures = [] }) {
  return `# How long will these take?

Estimate how long each assignment below will take me, from its actual instructions and files (attached, or copied below). I only want time estimates and what each one needs; don't solve anything.
${lectures.length ? `\nMy lectures, for "needs":\n${lectures.map((l) => `- ${l}`).join("\n")}\n` : ""}
${SIZES_FORMAT}

${items.map((a) => `## [${a.ref}] ${a.name} (${a.course}), due ${a.due}${a.points ? `, ${a.points} points` : ""}
${a.kind === "quiz" ? "(A quiz: estimate how long to prepare for it. Its questions aren't available.)" : a.details ? `Instructions: ${a.details}` : "(No written instructions.)"}
${(a.files || []).map((f) => f.text ? `### File: ${f.name}\n${f.text}` : f.attached ? `### File: ${f.name} (attached)` : `### File: ${f.name} (couldn't be read${f.note ? `: ${f.note}` : ""})`).join("\n")}`).join("\n\n")}`;
}

export function parseSizes(text) {
  const obj = blockJson(text, "studypilot-sizes");
  if (!obj || !Array.isArray(obj.assignments)) throw new Error("StudyPilot couldn't find the estimates in that reply. Copy the AI's whole answer, including the block that starts with ```studypilot-sizes.");
  const out = {};
  for (const a of obj.assignments) {
    const ref = str(a.ref, 80);
    const hours = Number(a.hours);
    if (!/^a:/.test(ref) || !(hours > 0) || hours > 80) continue;
    out[ref] = { hours: Math.round(hours * 4) / 4, parts: (a.parts || []).map((p) => str(p, 120)).filter(Boolean).slice(0, 8), needs: (a.needs || []).map((p) => str(p, 120)).filter(Boolean).slice(0, 8), hard: str(a.hard, 160) };
  }
  if (!Object.keys(out).length) throw new Error("The reply had no usable estimates. Ask your AI to follow the format exactly.");
  return out;
}

// ---------- 2. this week's priorities ----------
export const PRIORITIES_FORMAT = `Reply with ONLY one code block tagged \`studypilot-priorities\`, written directly in your reply (not in an artifact, canvas or file), in exactly this shape:
\`\`\`studypilot-priorities
{"tasks":[
  {"ref":"<a ref from my list>","title":"<short, specific: e.g. HW 5: problems 1–3>","minutes":120,"earliest":"YYYY-MM-DD","latest":"YYYY-MM-DD","priority":1,"why":"<a few words>"},
  {"ref":"review:<course id>","title":"<e.g. Midterm 2: practice assessment on Lectures 10–13>","minutes":60,"earliest":"YYYY-MM-DD","latest":"YYYY-MM-DD","priority":1,"why":"…"}
],"advice":"<one or two sentences for me about this stretch>","end":true}
\`\`\`
Rules:
- Use only refs from my list, or "review:<course id>" for exam review (practice assessments, going back over weak spots). You may split one piece of work into several tasks with the same ref (e.g. an assignment's first and second half), each with its own minutes and dates.
- "minutes" is the work time for that task. Use my estimates; adjust for my pace and weak spots.
- "latest" is the last day it should be done (the day before a deadline that's early in the day; earlier when later work depends on it). "earliest" is when it makes sense to start (for example after the lecture it needs).
- "priority": 1 = must happen, 2 = should, 3 = nice to have.
- Fit the plan to the study time I have. If it can't all fit, keep the priority 1 work and say so in "advice".
- End with "end": true.`;

/**
 * ctx: { today, to, days: [{ date, minutes }], paceSec, note, courses: [{ id, name, weights, exams, assignments, lectures, weak }] }
 * assignments: [{ ref, name, due, points, size }]; lectures: [{ ref, title, left, total, partsLeft, minutes, sections }]
 */
export function prioritiesPrompt(ctx) {
  const avail = ctx.days.map((d) => `${fmtDay(d.date)} ${fmtHours(d.minutes)}`).join(" · ");
  const total = ctx.days.reduce((a, d) => a + d.minutes, 0);
  const lines = [`# My study plan: ${fmtDay(ctx.today)} to ${fmtDay(ctx.to)}`, "",
    "Help me plan what to study and when. I only need priorities and time estimates; StudyPilot fits them into my calendar.", "",
    `Study time I have (from my calendar): ${avail} (about ${fmtHours(total)} in all).`,
    `My pace: about ${Math.round(ctx.paceSec)} seconds per practice question.`,
    ctx.note ? `A note from me: ${ctx.note}` : null, ""];
  for (const c of ctx.courses) {
    lines.push(`## ${c.name} (course id ${c.id})${c.weights?.length ? `. Grade weights: ${c.weights.map((w) => `${w.name} ${w.w}%`).join(", ")}` : ""}`);
    for (const e of c.exams) lines.push(`- Exam: ${e.title} on ${fmtDay(e.date)}${e.covers?.length ? ` (covers ${e.covers.join(", ")})` : ""}`);
    for (const a of c.assignments) lines.push(`- [${a.ref}] ${a.name}, due ${a.due}${a.points ? `, ${a.points} pts` : ""}. ${a.size ? `Estimate: about ${a.size.hours} h${a.size.needs?.length ? `; needs ${a.size.needs.join(", ")}` : ""}${a.size.hard ? `; hardest: ${a.size.hard}` : ""}${a.size.parts?.length ? `; parts: ${a.size.parts.join("; ")}` : ""}` : "No estimate yet."}`);
    for (const l of c.lectures) lines.push(`- [${l.ref}] Learn ${l.title}: ${l.left} of ${l.total} checklist items left${l.partsLeft ? ` (${l.partsLeft})` : ""}, about ${fmtHours(l.minutes)} at my pace. Topics: ${l.sections.join(", ")}`);
    if (c.weak?.length) lines.push(`- My weak spots: ${c.weak.join("; ")}`);
    lines.push("");
  }
  lines.push(PRIORITIES_FORMAT);
  return lines.filter((x) => x != null).join("\n");
}

export function parsePriorities(text, { refs = [] } = {}) {
  const obj = blockJson(text, "studypilot-priorities");
  if (!obj || !Array.isArray(obj.tasks)) throw new Error("StudyPilot couldn't find the plan in that reply. Copy the AI's whole answer, including the block that starts with ```studypilot-priorities.");
  const ok = new Set(refs);
  const tasks = [];
  obj.tasks.forEach((t, i) => {
    const ref = str(t.ref, 120);
    const minutes = Math.round(Number(t.minutes));
    if (!(minutes > 0) || minutes > 2400) return;
    if (!ok.has(ref) && !/^review:\w+/.test(ref)) return;
    tasks.push({ id: `t${i}`, ref, title: str(t.title, 120) || ref, minutes, earliest: isDate(t.earliest) ? t.earliest : null, latest: isDate(t.latest) ? t.latest : null,
      priority: [1, 2, 3].includes(Number(t.priority)) ? Number(t.priority) : 2, why: str(t.why, 160), order: i });
  });
  if (!tasks.length) throw new Error("The plan had no tasks StudyPilot could use. Ask your AI to use the refs from the list exactly.");
  return { tasks, advice: str(obj.advice, 400) };
}

// ---------- 3. fitting work into study time ----------
const MIN_CHUNK = 20, MAX_CHUNK = 90;

/**
 * Free study time from My week, per date, from `from` to `to` (inclusive). Starting at `nowMin` on the first day if
 * given. Class times (the student's own; office hours don't count) are taken out, in case study time was painted over them.
 */
export function studySlots(week, from, to, { nowMin = null, courses = [], terms = {} } = {}) {
  const out = [];
  for (let m = mondayOf(new Date(`${from}T12:00:00`)); ymd(m) <= to; m = addDays(m, 7)) {
    const evs = weekEvents(week, m, { courses, terms });
    const busy = {};
    for (const e of evs) if (e.type === "class" && e.meeting?.kind !== "office") (busy[e.date] ||= []).push([toMin(e.start), toMin(e.end)]);
    for (const e of evs) {
      if (e.type !== "study" || e.date < from || e.date > to) continue;
      let a = toMin(e.start); const b = toMin(e.end);
      if (nowMin != null && e.date === from) a = Math.max(a, Math.ceil(nowMin / 5) * 5);
      let parts = [[a, b]];
      for (const [x, y] of busy[e.date] || []) parts = parts.flatMap(([p, q]) => (y <= p || x >= q ? [[p, q]] : [[p, Math.min(q, x)], [Math.max(p, y), q]].filter(([u, v]) => v > u)));
      for (const [p, q] of parts) if (q - p >= MIN_CHUNK) out.push({ date: e.date, a: p, b: q });
    }
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || x.a - y.a);
}

/**
 * tasks: [{ id, ref, title, remaining (minutes), earliest, latest, priority, order }]
 * Places work earliest-deadline-first (then priority) into the slots, in sittings of 20 to 90 minutes.
 * Returns { chunks: [{ taskId, ref, title, date, start, end, minutes }], short: [{ taskId, title, minutes, latest }] }
 */
export function fitPlan(tasks, slots) {
  const left = new Map(tasks.map((t) => [t.id, Math.max(0, Math.round(t.remaining))]));
  const chunks = [];
  const rank = (t) => [t.latest || "9999-12-31", t.priority, t.order];
  const cmp = (x, y) => { const a = rank(x), b = rank(y); for (let i = 0; i < 3; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
  for (const s of slots) {
    let t0 = s.a;
    while (s.b - t0 >= MIN_CHUNK) {
      const ready = tasks.filter((t) => left.get(t.id) > 0 && (!t.earliest || t.earliest <= s.date) && (!t.latest || t.latest >= s.date)).sort(cmp);
      if (!ready.length) break;
      const t = ready[0];
      const rem = left.get(t.id);
      let m = Math.min(rem, MAX_CHUNK, s.b - t0);
      // never leave a sliver (under 20 minutes) for later: finish it now if it fits, or stop earlier so the
      // rest is a proper sitting
      if (rem - m > 0 && rem - m < MIN_CHUNK) {
        if (s.b - t0 >= rem && rem <= MAX_CHUNK + MIN_CHUNK / 2) m = rem;
        else m = rem - MIN_CHUNK;
      }
      if (m < MIN_CHUNK && m < rem) break;
      chunks.push({ taskId: t.id, ref: t.ref, title: t.title, date: s.date, start: hhmm(t0), end: hhmm(t0 + m), minutes: m });
      left.set(t.id, rem - m);
      t0 += m + (s.b - (t0 + m) >= MIN_CHUNK + 5 ? 5 : 0); // a 5-minute break between sittings
    }
  }
  const short = tasks.filter((t) => left.get(t.id) > 0).map((t) => ({ taskId: t.id, title: t.title, minutes: left.get(t.id), latest: t.latest, priority: t.priority }));
  return { chunks, short };
}

/**
 * How much of each task is left. Assignments: done when submitted; otherwise minus logged time.
 * Lectures: scaled by checklist items still to learn. Everything else: minus logged time.
 * info: { submitted: Set(ref), leftNow: { ref: items left } }
 */
export function remainingTasks(plan, done = {}, info = {}) {
  const used = {};
  return (plan.tasks || []).map((t) => {
    let rem = t.minutes;
    if (t.ref.startsWith("a:") && info.submitted?.has(t.ref)) rem = 0;
    else if (t.ref.startsWith("lec:") && plan.left0?.[t.ref] && info.leftNow?.[t.ref] != null) rem = Math.round(t.minutes * Math.min(1, info.leftNow[t.ref] / plan.left0[t.ref]));
    // time logged against a ref is used up by its tasks in order (several tasks can share a ref)
    const avail = Math.max(0, (done[t.ref] || 0) - (used[t.ref] || 0));
    const take = t.ref.startsWith("lec:") ? 0 : Math.min(avail, rem);
    used[t.ref] = (used[t.ref] || 0) + take;
    return { ...t, remaining: Math.max(0, rem - take) };
  });
}

/** Today's plan (frozen for the day), and the rest from tomorrow assuming today's sittings happen. */
export function planDays(plan, week, { today, done = {}, info = {}, day = null, nowMin = null, courses = [], terms = {} }) {
  const tasks = remainingTasks(plan, done, info);
  const opts = { courses, terms };
  let todayChunks;
  if (day && day.date === today && day.at >= (plan.at || 0) && day.at >= (week.at || 0)) todayChunks = day.chunks;
  else if (day && day.date === today && day.at >= (plan.at || 0)) {
    // Study time changed today: keep what's checked off, and fit the rest into today's time from now on.
    const kept = day.chunks.filter((c) => c.done);
    const fresh = fitPlan(tasks, studySlots(week, today, today, { ...opts, nowMin })).chunks
      .filter((c) => !kept.some((k) => toMin(k.start) < toMin(c.end) && toMin(c.start) < toMin(k.end)));
    todayChunks = [...kept, ...fresh.map((c, i) => ({ ...c, id: `${today}-r${Date.now() % 1e6}-${i}`, done: false }))].sort((x, y) => toMin(x.start) - toMin(y.start));
  } else todayChunks = fitPlan(tasks, studySlots(week, today, today, opts)).chunks.map((c, i) => ({ ...c, id: `${today}-${i}`, done: false }));
  // assume today's open sittings will happen when planning the days after
  const pending = {};
  for (const c of todayChunks) if (!c.done) pending[c.taskId] = (pending[c.taskId] || 0) + c.minutes;
  const after = tasks.map((t) => ({ ...t, remaining: Math.max(0, t.remaining - (pending[t.id] || 0)) }));
  const tomorrow = ymd(addDays(new Date(`${today}T12:00:00`), 1));
  const rest = plan.to >= tomorrow ? fitPlan(after, studySlots(week, tomorrow, plan.to, opts)) : { chunks: [], short: after.filter((t) => t.remaining > 0).map((t) => ({ taskId: t.id, title: t.title, minutes: t.remaining, latest: t.latest, priority: t.priority })) };
  return { today: todayChunks, later: rest.chunks, short: rest.short };
}

/** Is the plan due for a fresh look from the AI? (weekly, or when something new needs fitting in) */
export function needsReplan(plan, { now = new Date(), refsNow = [] } = {}) {
  if (!plan?.tasks?.length) return null;
  if (ymd(now) > plan.to) return "Your plan ended.";
  if (now - (plan.at || 0) > 7 * 864e5) return "It's been a week since your plan was made.";
  const known = new Set((plan.selection?.assignments || []).concat(plan.tasks.map((t) => t.ref)));
  const fresh = refsNow.filter((r) => !known.has(r));
  if (fresh.length) return `${fresh.length} new assignment${fresh.length > 1 ? "s" : ""} since your plan was made.`;
  return null;
}

// ---------- what's left right now ----------
/** submitted: assignment refs that are turned in; leftNow: checklist items still to learn per lecture ref. */
export function planInfo({ snapshot, checklists = {}, itemStats = {}, masteryLevel = {} }) {
  const submitted = new Set();
  for (const c of snapshot?.courses || []) for (const a of c.assignments || []) if (a.submitted || a.graded) submitted.add(`a:${c.id}:${a.id}`);
  const leftNow = {};
  for (const [key, rec] of Object.entries(checklists)) {
    const rule = masteryLevel[rec.courseId] || "solid";
    leftNow[`lec:${key}`] = allItems(rec.cl).filter((it) => !["learning", "mastered"].includes(itemLevel(itemStats[key]?.[it.id], rule))).length;
  }
  return { submitted, leftNow };
}
