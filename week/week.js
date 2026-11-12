// My week: class times, the student's own sections, study blocks they paint, deadlines and exams.
// Everything stays in this browser (and the student's own sync). Nothing is written to Canvas.
import {
  DAYS, KINDS, KIND_LABEL, CHOOSABLE, emptyWeek, toMin, hhmm, niceTime, ymd, dayIndex, mondayOf, addDays,
  weekEvents, paintWeekly, paintOnce, sectionGroups, groupKey, normalizeMeeting, buildIcs, timeChangeNotices,
} from "../lib/schedule.js";
import { ZipWriter } from "../lib/zipwrite.js";
import { planDays, planInfo } from "../lib/planner.js";

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") for (const [p, val] of Object.entries(v)) { if (p.startsWith("--")) el.style.setProperty(p, val); else el.style[p] = val; }
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const send = (type, payload = {}) => new Promise((res, rej) => chrome.runtime.sendMessage({ type, payload }, (r) => (r?.ok ? res(r.data) : rej(new Error(r?.error || "No answer")))));
let toastT = null;
function toast(msg, ms = 4000) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

const S = { week: emptyWeek(), snapshot: null, settings: {}, exams: [], monday: mondayOf(new Date()), mode: "week", drag: null, adding: null };
const ROW = 22; // pixels per half hour

// ---------- data ----------
async function load() {
  const got = await chrome.storage.local.get(["week", "snapshot", "settings", "plan", "planDone", "planDay", "checklists", "itemStats"]);
  S.planData = got;
  S.week = { ...emptyWeek(), ...(got.week || {}) };
  S.snapshot = got.snapshot || null;
  S.settings = got.settings || {};
  const theme = S.settings.look?.theme || (S.settings.darkMode ? "dark" : "default");
  document.documentElement.dataset.look = theme;
  if (S.settings.look?.accent) document.documentElement.style.setProperty("--accent", S.settings.look.accent);
  S.exams = await send("ALL_EXAMS").catch(() => []);
}
async function save(change) {
  S.week = { ...S.week, ...change, at: Date.now() };
  await chrome.storage.local.set({ week: S.week });
  draw();
}
const courses = () => {
  const hidden = new Set(S.settings.hiddenCourses || []);
  return (S.snapshot?.courses || []).filter((c) => !hidden.has(c.id));
};
const courseOf = (id) => courses().find((c) => String(c.id) === String(id));
const nameOf = (id) => { const c = courseOf(id); return c ? c.code || c.name : "Course"; };
function color(id) {
  const own = S.settings.look?.courseColors?.[id];
  return (own && own !== "none" ? own : null) || S.snapshot?.colors?.[id] || "#8a8a8a";
}
const terms = () => Object.fromEntries(courses().map((c) => [c.id, { start: c.term_start ? ymd(new Date(c.term_start)) : null, end: c.term_end ? ymd(new Date(c.term_end)) : null }]));

// ---------- the calendar ----------
function draw() {
  drawGrid();
  drawSide();
  const end = addDays(S.monday, 6);
  const f = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  $("#range").textContent = `${f(S.monday)} – ${f(end)}`;
  $("#office").checked = !!S.week.showOffice;
  $("#mode-week").setAttribute("aria-checked", String(S.mode === "week"));
  $("#mode-once").setAttribute("aria-checked", String(S.mode === "once"));
}

function hoursFor(events) {
  let a = 7 * 60, b = 23 * 60;
  for (const e of events) { a = Math.min(a, toMin(e.start)); b = Math.max(b, toMin(e.end)); }
  return [Math.floor(a / 60) * 60, Math.min(24 * 60, Math.ceil(b / 60) * 60)];
}

// The study plan's sittings (from Today's plan and the days after), shown inside the study blocks.
function plannedByDate() {
  const d = S.planData || {};
  if (!d.plan) return {};
  const info = planInfo({ snapshot: S.snapshot, checklists: d.checklists, itemStats: d.itemStats, masteryLevel: S.settings.masteryLevel || {} });
  const days = planDays(d.plan, S.week, { today: ymd(new Date()), done: d.planDone || {}, info, day: d.planDay, nowMin: new Date().getHours() * 60 + new Date().getMinutes(), courses: courses(), terms: terms() });
  const out = {};
  for (const c of [...days.today.map((x) => ({ ...x, date: ymd(new Date()) })), ...days.later]) (out[c.date] ||= []).push(c);
  return out;
}

function drawGrid() {
  const grid = $("#grid");
  const planned = plannedByDate();
  const events = weekEvents(S.week, S.monday, { courses: courses(), terms: terms() });
  const [from, to] = hoursFor(events);
  S.range = [from, to];
  const todayKey = ymd(new Date());
  const cal = h("div", { class: "cal", style: { "--row": `${ROW}px` } });
  // header
  cal.append(h("div", {}));
  for (let d = 0; d < 7; d++) {
    const date = addDays(S.monday, d);
    cal.append(h("div", { class: `dayhead${ymd(date) === todayKey ? " today" : ""}` }, DAYS[d], h("small", {}, date.toLocaleDateString(undefined, { month: "short", day: "numeric" }))));
  }
  // deadlines and exams (by day; time shown on each)
  cal.append(h("div", { class: "corner" }, "Due"));
  for (let d = 0; d < 7; d++) {
    const key = ymd(addDays(S.monday, d));
    const cell = h("div", { class: "allday" });
    for (const x of S.exams.filter((e) => ymd(new Date(e.date)) === key)) {
      cell.append(h("div", { class: "chip exam", style: { "--c": color(x.courseId) }, title: `${x.title} (${x.course})${x.hasTime ? ` at ${niceTime(new Date(x.date).getHours() * 60 + new Date(x.date).getMinutes())}` : ""}` },
        `${x.hasTime ? niceTime(new Date(x.date).getHours() * 60 + new Date(x.date).getMinutes()) + " " : ""}${x.title}`));
    }
    for (const c of courses()) for (const a of c.assignments || []) {
      if (!a.due_at || a.blocked || ymd(new Date(a.due_at)) !== key) continue;
      const t = new Date(a.due_at);
      const done = a.submitted || a.graded;
      cell.append(h("div", { class: `chip${done ? " done" : ""}`, style: { "--c": color(c.id) }, title: `${a.name} · ${c.code || c.name} · due ${niceTime(t.getHours() * 60 + t.getMinutes())}${done ? " (submitted)" : ""}` },
        `${niceTime(t.getHours() * 60 + t.getMinutes())} ${a.name}`));
    }
    cal.append(cell);
  }
  // time labels
  const times = h("div", { class: "times" });
  for (let m = from; m < to; m += 60) times.append(h("div", {}, m === from ? "" : niceTime(m)));
  cal.append(times);
  // day columns
  const height = ((to - from) / 30) * ROW;
  for (let d = 0; d < 7; d++) {
    const date = addDays(S.monday, d), key = ymd(date);
    const col = h("div", { class: `col${key === todayKey ? " today" : ""}`, style: { height: `${height}px` }, "data-day": d, "data-date": key,
      role: "group", "aria-label": `${DAYS[d]} ${date.toLocaleDateString()}` });
    const mine = events.filter((e) => e.day === d);
    // side by side when two classes overlap
    const cls = mine.filter((e) => e.type !== "study").sort((a, b) => toMin(a.start) - toMin(b.start));
    cls.forEach((e, i) => { const prev = cls[i - 1]; if (prev && toMin(prev.end) > toMin(e.start)) { prev._split = "narrow2"; e._split = "narrow"; } });
    for (const e of mine) col.append(eventEl(e, from));
    for (const c of planned[key] || []) {
      const top = ((toMin(c.start) - from) / 30) * ROW, hgt = Math.max(ROW - 4, ((toMin(c.end) - toMin(c.start)) / 30) * ROW - 4);
      col.append(h("div", { class: `ev planned${c.done ? " done" : ""}`, style: { top: `${top + 1}px`, height: `${hgt}px`, "--c": color(c.ref.split(":")[1]) }, title: `${c.title} · ${niceTime(c.start)}–${niceTime(c.end)}` },
        h("b", {}, c.title), h("span", {}, `${niceTime(c.start)}–${niceTime(c.end)}`)));
    }
    if (key === todayKey) {
      const n = new Date(), nm = n.getHours() * 60 + n.getMinutes();
      if (nm >= from && nm <= to) col.append(h("div", { class: "now", style: { top: `${((nm - from) / 30) * ROW}px` }, "aria-hidden": "true" }));
    }
    col.addEventListener("pointerdown", (ev) => startPaint(ev, col));
    cal.append(col);
  }
  grid.replaceChildren(cal);
}

function eventEl(e, from) {
  const top = ((toMin(e.start) - from) / 30) * ROW, height = Math.max(ROW - 2, ((toMin(e.end) - toMin(e.start)) / 30) * ROW - 2);
  const pos = { top: `${top}px`, height: `${height}px` };
  const when = `${niceTime(e.start)}–${niceTime(e.end)}`;
  if (e.type === "study") return h("div", { class: `ev study${e.repeat ? "" : " once"}`, style: pos, title: `Study time ${when}${e.repeat ? " (every week)" : " (this week only)"}` }, h("b", {}, "Study"), h("span", {}, when));
  const m = e.meeting;
  const cls = e.type === "choose" ? "choose" : m.kind === "office" ? "class office" : "class";
  const label = `${nameOf(e.courseId)} ${m.label}`;
  return h("button", { class: `ev ${cls} ${e._split || ""}`, style: { ...pos, "--c": color(e.courseId) }, title: `${label} · ${when}${m.location ? ` · ${m.location}` : ""}`,
    onclick: (ev) => { ev.stopPropagation(); openPop(ev.currentTarget, e); }, onpointerdown: (ev) => ev.stopPropagation() },
    h("b", {}, label), h("span", {}, [when, m.location].filter(Boolean).join(" · ")), m.kind === "office" && m.who ? h("span", {}, m.who) : null);
}

// ---------- painting study time ----------
function slotAt(col, y) {
  const r = col.getBoundingClientRect();
  const [from, to] = S.range;
  const m = from + Math.floor(Math.max(0, Math.min(r.height - 1, y - r.top)) / ROW) * 30;
  return Math.min(to - 30, m);
}
function isStudy(day, date, min) {
  return weekEvents(S.week, S.monday, { courses: [], terms: {} }).some((e) => e.type === "study" && e.date === date && toMin(e.start) <= min && min < toMin(e.end));
}
function startPaint(ev, col) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  closePop();
  const day = Number(col.dataset.day), date = col.dataset.date;
  const a = slotAt(col, ev.clientY);
  S.drag = { col, day, date, a, b: a, erase: isStudy(day, date, a) };
  col.setPointerCapture(ev.pointerId);
  const prev = h("div", { class: `ev preview${S.drag.erase ? " erase" : ""}` });
  col.append(prev);
  S.drag.prev = prev;
  const show = () => {
    const [lo, hi] = [Math.min(S.drag.a, S.drag.b), Math.max(S.drag.a, S.drag.b) + 30];
    prev.style.top = `${((lo - S.range[0]) / 30) * ROW}px`;
    prev.style.height = `${((hi - lo) / 30) * ROW - 2}px`;
    prev.textContent = `${S.drag.erase ? "Remove" : "Study"} ${niceTime(lo)}–${niceTime(hi)}`;
  };
  show();
  const move = (e) => { S.drag.b = slotAt(col, e.clientY); show(); };
  const up = async () => {
    col.removeEventListener("pointermove", move);
    col.removeEventListener("pointerup", up);
    col.removeEventListener("pointercancel", up);
    const { day: d, date: dt, erase } = S.drag;
    const lo = Math.min(S.drag.a, S.drag.b), hi = Math.max(S.drag.a, S.drag.b) + 30;
    S.drag = null;
    if (S.mode === "week") await save({ blocks: paintWeekly(S.week.blocks || [], d, lo, hi, erase) });
    else await save({ changes: paintOnce(S.week, dt, d, lo, hi, erase) });
    toast(`${erase ? "Removed" : "Added"} study time ${niceTime(lo)}–${niceTime(hi)} ${S.mode === "week" ? `every ${DAYS[d]}` : "this week only"}.`);
  };
  col.addEventListener("pointermove", move);
  col.addEventListener("pointerup", up);
  col.addEventListener("pointercancel", up);
}

// ---------- class details ----------
function openPop(anchor, e) {
  const pop = $("#pop"), m = e.meeting, cid = e.courseId;
  const r = anchor.getBoundingClientRect();
  const kids = [h("h3", {}, `${nameOf(cid)} ${m.label}`),
    h("div", {}, `${m.date ? new Date(`${m.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : m.days.map((d) => DAYS[d]).join(", ")} · ${niceTime(m.start)}–${niceTime(m.end)}`),
    m.location ? h("div", { class: "muted" }, m.location) : null,
    m.who ? h("div", { class: "muted" }, m.who) : null,
    h("div", { class: "hint", style: { marginTop: "6px" } }, m.source === "manual" ? "Added by you." : "Found in your syllabus or course pages by your AI. Check it against Canvas if anything looks off.")];
  const acts = h("div", { class: "acts" });
  if (e.type === "choose") {
    acts.append(h("button", { class: "btn primary small", onclick: () => pickSection(cid, groupKey(m), m.section || m.label) }, `This is my ${KIND_LABEL[m.kind].toLowerCase()}`));
    kids.push(h("div", { class: "hint", style: { marginTop: "6px" } }, `${e.options?.length || "Several"} ${KIND_LABEL[m.kind].toLowerCase()} options are listed. Pick yours and the others disappear.`));
  } else if (CHOOSABLE.has(m.kind) && (e.options?.length || 0) > 1) {
    acts.append(h("button", { class: "btn soft small", onclick: () => pickSection(cid, groupKey(m), null) }, "Change my section"));
  }
  acts.append(h("button", { class: "btn soft small", onclick: () => removeMeeting(cid, m.id) }, "Remove"), h("button", { class: "btn ghost small", onclick: closePop }, "Close"));
  kids.push(acts);
  pop.replaceChildren(...kids.filter(Boolean));
  pop.hidden = false;
  const w = 280, left = Math.min(window.innerWidth - w - 12, Math.max(12, r.right + 8 + w > window.innerWidth ? r.left - w - 8 : r.right + 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.min(window.innerHeight - pop.offsetHeight - 12, Math.max(12, r.top))}px`;
  pop.querySelector("button")?.focus();
}
function closePop() { $("#pop").hidden = true; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
document.addEventListener("pointerdown", (e) => { if (!$("#pop").hidden && !$("#pop").contains(e.target)) closePop(); });

async function pickSection(cid, group, label) {
  const picks = { ...(S.week.picks || {}) };
  const mine = { ...(picks[cid] || {}) };
  if (label == null) delete mine[group]; else mine[group] = label;
  picks[cid] = mine;
  closePop();
  await save({ picks });
  if (label && label !== "none") toast(`${nameOf(cid)}: ${label} is yours.`);
}
async function removeMeeting(cid, id) {
  const classes = { ...(S.week.classes || {}) };
  const rec = classes[cid];
  if (!rec) return;
  classes[cid] = { ...rec, meetings: rec.meetings.filter((m) => m.id !== id) };
  closePop();
  await save({ classes });
  toast("Removed.");
}

// ---------- side: courses, sections, adding class times ----------
function drawSide() {
  const side = $("#side");
  const cs = courses();
  const any = cs.some((c) => S.week.classes?.[c.id]?.meetings?.length);
  const find = h("div", { class: "card" },
    h("h2", {}, "Class times"),
    h("p", { class: "hint", style: { margin: "0 0 8px" } }, any
      ? "Found in your syllabi and course pages. Pick your own section where a course has several, and add anything that's missing."
      : "Your AI can read your syllabi and course pages and find your lectures, sections, labs and office hours (one request for all your courses). You can also add them yourself."),
    h("button", { class: `btn ${any ? "soft" : "primary"}`, onclick: findWithAI }, any ? "Find class times again" : "Find class times with my AI"));
  const list = h("div", { class: "card" }, h("h2", {}, "Your courses"),
    cs.length ? cs.map(courseCard) : h("div", { class: "hint" }, "Open StudyPilot and connect Canvas to see your courses here."));
  side.replaceChildren(find, studyCard(), list);
}

// Study time as a list too (and a form), so it works with a keyboard or screen reader as well as by dragging.
function studyCard() {
  const blocks = [...(S.week.blocks || [])].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  const study = blocks.reduce((a, b) => a + toMin(b.end) - toMin(b.start), 0);
  const day = h("select", { name: "day", "aria-label": "Day" }, DAYS.map((d, i) => h("option", { value: i }, d)));
  const from = h("input", { type: "time", value: "18:00", "aria-label": "From", required: true });
  const to = h("input", { type: "time", value: "20:00", "aria-label": "To", required: true });
  const once = h("input", { type: "checkbox", "aria-label": "Only this week" });
  const form = h("form", { class: "add", onsubmit: async (e) => {
    e.preventDefault();
    const a = toMin(from.value), b = toMin(to.value), d = Number(day.value);
    if (a == null || b == null || b <= a) return toast("Pick a start time before the end time.");
    if (once.checked) await save({ changes: paintOnce(S.week, ymd(addDays(S.monday, d)), d, a, b) });
    else await save({ blocks: paintWeekly(S.week.blocks || [], d, a, b) });
    toast(`Added study time ${niceTime(a)}–${niceTime(b)} ${once.checked ? `this ${DAYS[d]} only` : `every ${DAYS[d]}`}.`);
  } },
    h("div", { class: "row" }, h("label", {}, "Day", day), h("label", {}, "From", from), h("label", {}, "To", to)),
    h("label", { style: { display: "flex", gap: "6px", alignItems: "center" } }, once, "Only the week shown"),
    h("button", { class: "btn small", type: "submit" }, "Add study time"));
  return h("div", { class: "card" }, h("h2", {}, "Study time"),
    h("div", {}, study ? `${Math.round((study / 60) * 10) / 10} hours a week` : "None yet."),
    h("div", { class: "hint" }, "Drag on the calendar where you're free to study, or add it here. Your study plan fills these times."),
    blocks.map((b) => h("div", { class: "mtg" }, h("span", { class: "grow" }, h("b", {}, DAYS[b.day]), " ", h("small", {}, `${niceTime(b.start)}–${niceTime(b.end)} every week`)),
      h("button", { class: "x", title: "Remove", "aria-label": `Remove study time ${DAYS[b.day]} ${niceTime(b.start)}`, onclick: () => save({ blocks: (S.week.blocks || []).filter((x) => x.id !== b.id) }) }, "×"))),
    form);
}


function courseCard(c) {
  const rec = S.week.classes?.[c.id] || { meetings: [], noClass: [] };
  const groups = sectionGroups(rec.meetings);
  const picks = S.week.picks?.[c.id] || {};
  const box = h("div", { class: "course", style: { "--c": color(c.id) } }, h("h3", {}, h("span", { class: "dot" }), c.code || c.name));
  // Announcements that may move a class: a flag to check, never a silent change.
  for (const a of timeChangeNotices((S.snapshot?.announcements || []).filter((x) => x.course_id === c.id), S.week)) {
    box.append(h("div", { class: "note warn" }, h("b", {}, "Possible change: "), h("a", { href: a.url, target: "_blank", rel: "noopener" }, a.title),
      ` (${new Date(a.posted_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}). Check it and update the times below if needed. `,
      h("button", { class: "linkish", onclick: () => save({ dismissed: [...new Set([...(S.week.dismissed || []), a.id])].slice(-200) }) }, "Got it")));
  }
  // section pickers
  for (const [g, opts] of Object.entries(groups)) {
    if (opts.length < 2) continue;
    const sel = h("select", { "aria-label": `Your ${KIND_LABEL[g].toLowerCase()} for ${c.code || c.name}`, onchange: (e) => pickSection(c.id, g, e.target.value || null) },
      h("option", { value: "" }, `Pick your ${KIND_LABEL[g].toLowerCase()}…`),
      opts.map((o) => { const m = rec.meetings.find((x) => (x.section || x.label) === o && x.kind === g); return h("option", { value: o, selected: picks[g] === o }, `${o}${m ? ` (${m.days.map((d) => DAYS[d]).join("/")} ${niceTime(m.start)})` : ""}`); }),
      h("option", { value: "none", selected: picks[g] === "none" }, "None of these"));
    box.append(h("div", { class: "pick" }, h("span", {}, `Your ${KIND_LABEL[g].toLowerCase()}:`), sel));
  }
  // meetings, everyone's first; other sections hidden once picked
  const shown = rec.meetings.filter((m) => !CHOOSABLE.has(m.kind) || (groups[groupKey(m)]?.length || 0) < 2 || !picks[groupKey(m)] || picks[groupKey(m)] === (m.section || m.label));
  const order = (m) => KINDS.indexOf(m.kind);
  for (const m of shown.sort((a, b) => order(a) - order(b) || a.start.localeCompare(b.start))) {
    if (m.kind === "office" && !S.week.showOffice) continue;
    box.append(h("div", { class: "mtg" },
      h("span", { class: "grow" }, h("b", {}, m.label), " ", h("small", {}, `${m.date ? new Date(`${m.date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : m.days.map((d) => DAYS[d]).join("/")} ${niceTime(m.start)}–${niceTime(m.end)}${m.location ? ` · ${m.location}` : ""}`)),
      h("button", { class: "x", title: "Remove", "aria-label": `Remove ${m.label}`, onclick: () => removeMeeting(c.id, m.id) }, "×")));
  }
  const offices = rec.meetings.filter((m) => m.kind === "office").length;
  if (offices && !S.week.showOffice) box.append(h("div", { class: "hint" }, `${offices} office hour${offices > 1 ? "s" : ""} (hidden; “Show office hours” at the top)`));
  if (rec.noClass?.length) box.append(h("div", { class: "hint" }, `No class on ${rec.noClass.slice(0, 4).map((d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })).join(", ")}${rec.noClass.length > 4 ? "…" : ""}`));
  if (!rec.meetings.length) box.append(h("div", { class: "hint" }, "No class times yet."));
  box.append(S.adding === c.id ? addForm(c) : h("button", { class: "linkish", style: { fontSize: ".9em" }, onclick: () => { S.adding = c.id; drawSide(); } }, "+ Add a class time"));
  return box;
}

function addForm(c) {
  const f = h("form", { class: "add", onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const days = fd.getAll("day").map(Number);
    const m = normalizeMeeting({ kind: fd.get("kind"), label: fd.get("label") || KIND_LABEL[fd.get("kind")], days, start: fd.get("start"), end: fd.get("end"), location: fd.get("location"), section: fd.get("label") }, { source: "manual" });
    if (!m) return toast("Pick at least one day and a start time before the end time.");
    const classes = { ...(S.week.classes || {}) };
    const rec = classes[c.id] || { meetings: [], noClass: [] };
    classes[c.id] = { ...rec, meetings: [...rec.meetings, m] };
    // A section the student adds themselves is theirs.
    const picks = { ...(S.week.picks || {}) };
    if (CHOOSABLE.has(m.kind)) picks[c.id] = { ...(picks[c.id] || {}), [groupKey(m)]: m.section || m.label };
    S.adding = null;
    await save({ classes, picks });
    toast(`Added ${m.label}.`);
  } },
    h("label", {}, "What", h("select", { name: "kind" }, KINDS.filter((k) => k !== "exam").map((k) => h("option", { value: k }, KIND_LABEL[k])))),
    h("label", {}, "Name (optional)", h("input", { name: "label", placeholder: "e.g. Section 0103" })),
    h("div", { class: "days", role: "group", "aria-label": "Days" }, DAYS.map((d, i) => h("label", {}, h("input", { type: "checkbox", name: "day", value: i }), d))),
    h("div", { class: "row" }, h("label", {}, "Starts", h("input", { type: "time", name: "start", required: true, value: "10:00" })), h("label", {}, "Ends", h("input", { type: "time", name: "end", required: true, value: "10:50" }))),
    h("label", {}, "Where (optional)", h("input", { name: "location" })),
    h("div", { class: "row" }, h("button", { class: "btn primary small", type: "submit" }, "Add"), h("button", { class: "btn ghost small", type: "button", onclick: () => { S.adding = null; drawSide(); } }, "Cancel")));
  return f;
}

// Opens the StudyPilot panel and asks it to send the request to the student's AI (the panel does the hand-off).
function findWithAI() {
  chrome.runtime.sendMessage({ type: "OPEN_PANEL", payload: { action: "classTimes", courseIds: courses().map((c) => c.id) } });
  toast("StudyPilot is gathering your syllabi for your AI. Watch the StudyPilot panel; class times appear here when your AI answers.", 9000);
}

// ---------- calendar file ----------
async function downloadIcs() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const deadlines = courses().flatMap((c) => (c.assignments || []).filter((a) => a.due_at && !a.blocked && !a.submitted).map((a) => ({ name: a.name, due_at: a.due_at, url: a.url, courseId: c.id })));
  const exams = S.exams.map((x) => { const d = new Date(x.date); return { title: x.title, courseId: x.courseId, date: ymd(d), time: x.hasTime ? hhmm(d.getHours() * 60 + d.getMinutes()) : null }; });
  const ends = courses().map((c) => terms()[c.id]?.end).filter(Boolean).sort();
  const ics = buildIcs(S.week, { courses: courses(), terms: terms(), deadlines, exams, from: S.monday, until: ends[ends.length - 1], tz });
  const zip = new ZipWriter();
  await zip.add("StudyPilot calendar.ics", ics);
  await zip.add("How to import.txt", "Open Google Calendar, Apple Calendar or Outlook and import \"StudyPilot calendar.ics\" (Google Calendar: Settings > Import & export).\nIt's a copy: if your week changes, download and import it again.\n");
  const url = URL.createObjectURL(zip.finish());
  try { await chrome.downloads.download({ url, filename: "StudyPilot/StudyPilot calendar.zip", saveAs: false }); toast("Saved to Downloads › StudyPilot. Unzip it and import the .ics file into your calendar."); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 60e3); }
}

// ---------- wiring ----------
$("#prev").onclick = () => { S.monday = addDays(S.monday, -7); draw(); };
$("#next").onclick = () => { S.monday = addDays(S.monday, 7); draw(); };
$("#today").onclick = () => { S.monday = mondayOf(new Date()); draw(); };
$("#office").onchange = (e) => save({ showOffice: e.target.checked });
$("#mode-week").onclick = () => { S.mode = "week"; draw(); };
$("#mode-once").onclick = () => { S.mode = "once"; draw(); };
$("#ics").onclick = () => downloadIcs().catch((e) => toast(e.message));
chrome.storage.local.onChanged.addListener((ch) => {
  if (ch.week && !S.drag) { S.week = { ...emptyWeek(), ...(ch.week.newValue || {}) }; draw(); }
  if (ch.snapshot) { S.snapshot = ch.snapshot.newValue; draw(); }
  if (ch.plan || ch.planDone || ch.planDay || ch.itemStats || ch.checklists) {
    for (const k of ["plan", "planDone", "planDay", "itemStats", "checklists"]) if (ch[k]) S.planData = { ...S.planData, [k]: ch[k].newValue };
    if (!S.drag) drawGrid();
  }
});
// Another "open My week" from the panel: focus this tab instead of opening another.
const channel = new BroadcastChannel("studypilot-week");
channel.onmessage = async (e) => { if (e.data?.type === "where") { const t = await chrome.tabs.getCurrent().catch(() => null); channel.postMessage({ type: "here", tabId: t?.id ?? null }); } };
setInterval(() => { if (!S.drag && $("#pop").hidden) drawGrid(); }, 5 * 60e3); // keep the "now" line current

load().then(draw).catch((e) => { $("#grid").textContent = `Couldn't load your week: ${e.message}`; });
