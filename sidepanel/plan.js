// Study plan: the student picks what they're studying for; their AI sizes each assignment (once, from its files)
// and sets the priorities; StudyPilot fits the work into the study time marked on My week and moves missed work.
import { h, $, state, send, toast, plural, ai, visibleSnapshot, lecturesFor, courseColor, courseName, rerender, go, views } from "./core.js";
import { handToAI } from "./aiflow.js";
import { icon } from "../lib/icons.js";
import { ymd, addDays, emptyWeek, niceTime, toMin } from "../lib/schedule.js";
import { sizesPrompt, parseSizes, prioritiesPrompt, parsePriorities, studySlots, planDays, planInfo, needsReplan } from "../lib/planner.js";
import { allItems, itemLevel } from "../lib/checklist.js";
import { examLectures } from "../lib/examplan.js";
import { allSessions } from "../lib/quiz.js";

const DAYMS = 864e5;
const get = async (keys) => chrome.storage.local.get(keys);
export const examKey = (e) => `${e.courseId}:${e.title}:${String(e.date).slice(0, 10)}`;
const aRef = (courseId, id) => `a:${courseId}:${id}`;
const getPlan = async () => (await get("plan")).plan || null;
// The student's courses and term dates, so class times are kept out of study time.
const courseCtx = () => {
  const courses = visibleSnapshot()?.courses || [];
  return { courses, terms: Object.fromEntries(courses.map((c) => [c.id, { start: c.term_start ? ymd(new Date(c.term_start)) : null, end: c.term_end ? ymd(new Date(c.term_end)) : null }])) };
};

// ---------- what can go in a plan ----------
async function candidates() {
  const snap = visibleSnapshot();
  const { checklists = {}, itemStats = {} } = await get(["checklists", "itemStats"]);
  const exams = await send("ALL_EXAMS").catch(() => []);
  const now = Date.now();
  const out = [];
  for (const c of snap?.courses || []) {
    const lectures = await lecturesFor(c.id).catch(() => []);
    const rule = (state.settings.masteryLevel || {})[c.id] || "solid";
    out.push({
      id: c.id, name: c.code || c.name,
      exams: exams.filter((e) => e.courseId === c.id && Date.parse(e.date) < now + 42 * DAYMS),
      assignments: (c.assignments || []).filter((a) => a.due_at && !a.submitted && !a.graded && !a.excused && Date.parse(a.due_at) > now - DAYMS && Date.parse(a.due_at) < now + 28 * DAYMS)
        .sort((a, b) => a.due_at.localeCompare(b.due_at)),
      lectures: lectures.filter((l) => l.is_lecture && ["File", "Page", "Notebook"].includes(l.type)).map((l) => {
        const rec = checklists[l.key] && String(checklists[l.key].courseId) === String(c.id) ? checklists[l.key] : null;
        const items = rec ? allItems(rec.cl) : [];
        const left = rec ? items.filter((it) => !["learning", "mastered"].includes(itemLevel(itemStats[l.key]?.[it.id], rule))).length : null;
        return { ...l, hasChecklist: !!rec, anyChecklist: !!checklists[l.key], total: items.length, left };
      }),
      allLectures: lectures,
    });
  }
  return { courses: out, exams };
}

// ---------- the setup sheet ----------
export async function openPlanSheet() {
  const dlg = $("#sheet");
  const close = () => dlg.close();
  dlg.replaceChildren(h("div", { class: "sheet-in" }, h("div", { class: "sheet-head" }, h("div", { class: "grow" }, h("b", {}, "Study plan")), h("button", { class: "ghost", "aria-label": "Close", onclick: close }, icon("close", 18))),
    h("div", { class: "muted", style: "padding:12px" }, "Gathering your courses…")));
  if (!dlg.open) dlg.showModal();
  const { courses, exams } = await candidates();
  const prev = (await getPlan())?.selection;
  const { week: wk } = await get("week");
  const week = { ...emptyWeek(), ...(wk || {}) };
  const sel = {
    courses: new Set(prev?.courses || courses.map((c) => c.id)),
    exams: new Set(prev?.exams || courses.flatMap((c) => c.exams.map(examKey))),
    assignments: new Set(prev?.assignments || courses.flatMap((c) => c.assignments.filter((a) => Date.parse(a.due_at) < Date.now() + 21 * DAYMS).map((a) => aRef(c.id, a.id)))),
    lectures: new Set(prev?.lectures || courses.flatMap((c) => c.lectures.filter((l) => l.hasChecklist && l.left > 0).map((l) => l.key))),
  };
  const firstExam = courses.flatMap((c) => c.exams).map((e) => String(e.date).slice(0, 10)).sort()[0];
  const defTo = ymd(new Date(Math.min(Date.now() + 27 * DAYMS, Math.max(Date.now() + 13 * DAYMS, firstExam ? Date.parse(firstExam) : 0))));
  const toInput = h("input", { type: "date", value: prev?.to && prev.to > ymd(new Date()) ? prev.to : defTo, min: ymd(addDays(new Date(), 1)), max: ymd(addDays(new Date(), 42)), "aria-label": "Plan until" });
  const note = h("textarea", { rows: 2, placeholder: "Anything your AI should know? e.g. I'm weak at proofs; I want HW done a day early.", "aria-label": "A note for your AI" }, prev?.note || "");
  const check = (set, key, label, sub, extra = {}) => h("label", { class: "plan-pick" }, h("input", { type: "checkbox", checked: set.has(key), onchange: (e) => { e.target.checked ? set.add(key) : set.delete(key); }, ...extra }),
    h("span", { class: "grow" }, label, sub ? h("small", {}, sub) : null));
  const fmtDue = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const avail = () => studySlots(week, ymd(new Date()), toInput.value, courseCtx()).reduce((a, s) => a + s.b - s.a, 0);
  const availEl = h("div", { class: "hint" });
  const showAvail = () => { const m = avail(); availEl.replaceChildren(m ? `Study time on My week until then: about ${Math.round(m / 6) / 10} hours.` : h("span", {}, h("b", {}, "No study time marked yet. "), "StudyPilot plans into the times you mark on My week. ", h("button", { class: "linkish", onclick: () => import("./weekai.js").then((m) => m.openWeek()) }, "Open My week"))); };
  toInput.onchange = showAvail; showAvail();

  const courseBox = (c) => {
    const lecs = c.lectures;
    const withCl = lecs.filter((l) => l.hasChecklist);
    const without = lecs.filter((l) => !l.hasChecklist).slice().reverse();
    const addSel = h("select", { "aria-label": `Add a lecture from ${c.name}`, onchange: (e) => { if (e.target.value) { sel.lectures.add(e.target.value); draw(); } } },
      h("option", { value: "" }, "Add a lecture (its checklist is made first)…"), without.filter((l) => !sel.lectures.has(l.key)).map((l) => h("option", { value: l.key }, l.title)));
    const body = h("div", { class: "plan-course-body" },
      c.exams.length ? [h("div", { class: "field" }, "Exams"), c.exams.map((e) => check(sel.exams, examKey(e), e.title, ` · ${new Date(e.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`))] : null,
      c.assignments.length ? [h("div", { class: "field" }, "Assignments"), c.assignments.map((a) => check(sel.assignments, aRef(c.id, a.id), a.name, ` · due ${fmtDue(a.due_at)}${a.kind === "quiz" ? " · quiz (prep time only)" : ""}`))] : h("div", { class: "hint" }, "Nothing due in the next four weeks."),
      h("div", { class: "field" }, "Lectures to learn"),
      withCl.map((l) => check(sel.lectures, l.key, l.title, l.left ? ` · ${l.left} of ${l.total} items left` : " · learned")),
      without.filter((l) => sel.lectures.has(l.key) && !l.anyChecklist).map((l) => check(sel.lectures, l.key, l.title, " · checklist will be made first")),
      without.length ? addSel : null);
    return h("div", { class: "plan-course", style: `--c:${courseColor(c.id)}` },
      h("label", { class: "plan-course-head" }, h("input", { type: "checkbox", checked: sel.courses.has(c.id), onchange: (e) => { e.target.checked ? sel.courses.add(c.id) : sel.courses.delete(c.id); draw(); } }), h("span", { class: "dot" }), h("b", {}, c.name)),
      sel.courses.has(c.id) ? body : null);
  };
  const list = h("div", {});
  const draw = () => list.replaceChildren(...courses.map(courseBox));
  draw();
  const go_ = async (btn) => {
    btn.disabled = true;
    try {
      const selection = { courses: [...sel.courses], exams: [...sel.exams], assignments: [...sel.assignments], lectures: [...sel.lectures], note: note.value.trim(), to: toInput.value };
      if (!avail()) throw new Error("Mark some study time on My week first: the plan goes into those times.");
      await makePlan(selection, courses);
      close();
    } catch (e) { toast(e.message, { error: true, ms: 8000 }); } finally { btn.disabled = false; }
  };
  dlg.replaceChildren(h("div", { class: "sheet-in" },
    h("div", { class: "sheet-head" }, h("div", { class: "grow" }, h("b", {}, "Study plan"), h("div", { class: "meta" }, "Pick what you're studying for. Your AI sizes the work; StudyPilot fits it into your study time.")), h("button", { class: "ghost", "aria-label": "Close", onclick: close }, icon("close", 18))),
    h("div", { class: "sheet-sec" }, h("div", { class: "row" }, h("span", { class: "grow" }, h("b", {}, "Plan until")), toInput), availEl),
    h("div", { class: "sheet-sec" }, list),
    h("div", { class: "sheet-sec" }, h("div", { class: "field" }, "A note for your AI (optional)"), note),
    h("div", { class: "sheet-sec" }, h("button", { class: "btn block", onclick: (e) => go_(e.currentTarget) }, "Make my plan"),
      h("div", { class: "hint", style: "margin-top:6px" }, `This adds a few requests to your list for ${ai().url ? ai().name : "your AI"}: a checklist for any new lecture you picked, one look at the assignments not sized yet (their files go along), then the plan itself. You press Send for each.`))));
}

// Queues what the plan needs (checklists, assignment sizes, then the plan) and starts the list.
async function makePlan(selection, courses) {
  const Q = await import("./queue.js");
  const { planSizes = {} } = await get("planSizes");
  const snap = visibleSnapshot();
  await chrome.storage.local.set({ planSelection: selection });
  let n = 0;
  for (const c of courses.filter((x) => selection.courses.includes(x.id))) {
    for (const l of c.lectures.filter((x) => selection.lectures.includes(x.key) && !x.anyChecklist))
      if (await Q.addJob({ kind: "checklist", courseId: c.id, course: c.name, lecture: l }, { quiet: true })) n++;
  }
  // assignments not sized yet, or changed since (new due date): four per request
  const need = selection.assignments.filter((ref) => {
    const [, cid, id] = ref.split(":");
    const a = snap?.courses.find((x) => String(x.id) === cid)?.assignments.find((x) => String(x.id) === id);
    return a && (!planSizes[ref] || planSizes[ref].due !== a.due_at);
  });
  for (let i = 0; i < need.length; i += 4) if (await Q.addJob({ kind: "sizes", refs: need.slice(i, i + 4) }, { quiet: true })) n++;
  await Q.removeJob("priorities::");
  await Q.addJob({ kind: "priorities" }, { quiet: true });
  n++;
  toast(`${plural(n, "request")} for ${ai().url ? ai().name : "your AI"}. Press Send for each; your plan appears on Today.`, { ms: 8000 });
  await Q.startQueue();
}

// Plan requests go to the plan's own chat when it still exists (the AI keeps the earlier context there).
async function toPlanChat(text, opts) {
  const { planChat } = await get("planChat");
  if (planChat?.url && planChat.provider === ai().id) return handToAI(text, { ...opts, chat: { url: planChat.url, keepFiles: true, fallback: async () => ({ text, files: opts.files || [] }) } });
  return handToAI(text, opts);
}

// ---------- request 1: how big is each assignment ----------
export async function requestSizes(refs) {
  const snap = visibleSnapshot();
  const items = refs.map((ref) => {
    const [, cid, id] = ref.split(":");
    const c = snap?.courses.find((x) => String(x.id) === cid);
    const a = c?.assignments.find((x) => String(x.id) === id);
    return a ? { ref, courseId: c.id, id: a.id, name: a.name, course: c.code || c.name, due: new Date(a.due_at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), due_at: a.due_at, points: a.points, kind: a.kind, details: a.details } : null;
  }).filter(Boolean);
  if (!items.length) throw new Error("Those assignments aren't open anymore.");
  const mats = await send("ASSIGNMENT_MATERIALS", { items: items.filter((a) => a.kind !== "quiz").map((a) => ({ courseId: a.courseId, id: a.id })) }).catch(() => ({}));
  const files = [];
  // Homework notebooks on the course's JupyterHub: their questions and data descriptions (never your answers).
  const hw = {};
  for (const cid of new Set(items.map((a) => a.courseId)))
    Object.assign(hw, await send("JUPYTER_HOMEWORK", { courseId: cid, assignments: items.filter((a) => a.courseId === cid).map((a) => ({ id: a.id, name: a.name })) }).catch(() => ({})));
  for (const a of items) {
    a.files = (mats[`${a.courseId}:${a.id}`]?.files || []).map((f) => {
      const pdf = f.url && /pdf|image/.test(f.type || "") && (f.size || 0) < 15e6 && files.length < 5;
      if (pdf) files.push({ name: f.name, url: f.url });
      return { name: f.name, text: pdf ? "" : f.text, attached: pdf, note: f.note || f.skipped };
    });
    if (hw[a.id]) a.files.push({ name: `${hw[a.id].name} (JupyterHub: questions and data only)`, text: hw[a.id].text });
  }
  const lectures = [];
  for (const cid of new Set(items.map((a) => a.courseId))) for (const l of (await lecturesFor(cid).catch(() => [])).filter((x) => x.is_lecture)) lectures.push(l.title);
  await toPlanChat(sizesPrompt({ items, lectures: lectures.slice(0, 60) }), { expect: "sizes", title: `Sizing ${plural(items.length, "assignment")}`, files,
    meta: { refs, dues: Object.fromEntries(items.map((a) => [a.ref, a.due_at])) } });
}
export async function importSizes(text, meta) {
  const found = parseSizes(text);
  const { planSizes = {} } = await get("planSizes");
  for (const [ref, s] of Object.entries(found)) planSizes[ref] = { ...s, at: Date.now(), due: meta?.dues?.[ref] || null };
  await chrome.storage.local.set({ planSizes });
  toast(`Estimates saved for ${plural(Object.keys(found).length, "assignment")}.`);
}

// ---------- request 2: the plan ----------
async function paceSeconds() {
  const all = await allSessions().catch(() => []);
  const times = all.slice(-40).flatMap((s) => (s.perQuestion || []).map((x) => x.ms)).filter((ms) => ms > 3e3 && ms < 6e5);
  return times.length >= 8 ? times.reduce((a, b) => a + b, 0) / times.length / 1000 : 60;
}
export async function requestPriorities() {
  const { planSelection: selection, planSizes = {}, checklists = {}, itemStats = {}, ledger = {}, week: wk } = await get(["planSelection", "planSizes", "checklists", "itemStats", "ledger", "week"]);
  if (!selection) throw new Error("Pick what you're studying for first (Today › Study plan).");
  const week = { ...emptyWeek(), ...(wk || {}) };
  const today = ymd(new Date()), to = selection.to && selection.to > today ? selection.to : ymd(addDays(new Date(), 14));
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const slots = studySlots(week, today, to, { nowMin, ...courseCtx() });
  const byDay = {};
  for (const s of slots) byDay[s.date] = (byDay[s.date] || 0) + s.b - s.a;
  const days = Object.entries(byDay).map(([date, minutes]) => ({ date, minutes }));
  if (!days.length) throw new Error("No study time left before the plan ends. Mark some on My week.");
  const pace = await paceSeconds();
  const snap = visibleSnapshot();
  const exams = await send("ALL_EXAMS").catch(() => []);
  const refs = [], left0 = {};
  const courses = [];
  for (const c of snap?.courses || []) {
    if (!selection.courses.includes(c.id)) continue;
    const lectures = await lecturesFor(c.id).catch(() => []);
    const rule = (state.settings.masteryLevel || {})[c.id] || "solid";
    const rows = (ledger[c.id]?.state?.mode === "percent" ? ledger[c.id].state.rows : []).filter((r) => Number(r.w) > 0).map((r) => ({ name: r.name, w: Number(r.w) }));
    const cExams = exams.filter((e) => e.courseId === c.id && selection.exams.includes(examKey(e))).map((e) => ({
      title: e.title, date: String(e.date).slice(0, 10), covers: examLectures(e, exams.filter((x) => x.courseId === c.id), lectures).map((l) => l.title).slice(0, 12),
    }));
    const assignments = (c.assignments || []).filter((a) => selection.assignments.includes(aRef(c.id, a.id)) && !a.submitted).map((a) => {
      const ref = aRef(c.id, a.id); refs.push(ref);
      return { ref, name: a.name, due: new Date(a.due_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), points: a.points, size: planSizes[ref] || null };
    });
    const lecs = [];
    for (const key of selection.lectures) {
      const rec = checklists[key];
      if (!rec || String(rec.courseId) !== String(c.id)) continue;
      const items = allItems(rec.cl);
      const left = items.filter((it) => !["learning", "mastered"].includes(itemLevel(itemStats[key]?.[it.id], rule)));
      if (!left.length) continue;
      const ref = `lec:${key}`; refs.push(ref); left0[ref] = left.length;
      const partsLeft = rec.parts.filter((p) => p.items.some((id) => left.some((it) => it.id === id))).map((p) => p.n);
      lecs.push({ ref, title: rec.lecture.title, left: left.length, total: items.length, partsLeft: partsLeft.length ? `parts ${partsLeft.join(", ")} of ${rec.parts.length}` : "",
        minutes: Math.round((left.length * pace * 1.6) / 60) + 5, sections: rec.cl.sections.map((s) => s.title).slice(0, 12) });
    }
    // weak spots: items answered wrong most often
    const weak = [];
    for (const [key, stats] of Object.entries(itemStats)) {
      const rec = checklists[key];
      if (!rec || String(rec.courseId) !== String(c.id)) continue;
      const byId = new Map(allItems(rec.cl).map((it) => [it.id, it.text]));
      for (const [id, hist] of Object.entries(stats)) { const miss = hist.filter((x) => !x.ok).length; if (miss >= 2 && byId.has(id)) weak.push([miss, byId.get(id).slice(0, 90)]); }
    }
    courses.push({ id: c.id, name: c.code || c.name, weights: rows, exams: cExams, assignments, lectures: lecs, weak: weak.sort((a, b) => b[0] - a[0]).slice(0, 4).map((w) => w[1]) });
  }
  const text = prioritiesPrompt({ today, to, days, paceSec: pace, note: selection.note, courses });
  await toPlanChat(text, { expect: "priorities", title: "Study plan", meta: { refs, left0, from: today, to, selection } });
}
export async function importPriorities(text, meta) {
  const { tasks, advice } = parsePriorities(text, { refs: meta.refs || [] });
  const plan = { selection: meta.selection, tasks, advice, at: Date.now(), from: meta.from, to: meta.to, left0: meta.left0 || {} };
  await chrome.storage.local.set({ plan, planDone: {}, planDay: null });
  toast(`Your plan is ready: ${plural(tasks.length, "task")}, fitted into your study time. See Today.`, { ms: 8000 });
  go("today");
}

// ---------- Today ----------
async function computeDays() {
  const st = await get(["plan", "planDone", "planDay", "week", "checklists", "itemStats", "snapshot"]);
  if (!st.plan) return null;
  const week = { ...emptyWeek(), ...(st.week || {}) };
  const info = planInfo({ snapshot: st.snapshot, checklists: st.checklists, itemStats: st.itemStats, masteryLevel: state.settings.masteryLevel || {} });
  const today = ymd(new Date());
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const days = planDays(st.plan, week, { today, done: st.planDone || {}, info, day: st.planDay, nowMin, ...courseCtx() });
  if (!st.planDay || st.planDay.date !== today || st.planDay.at < st.plan.at || st.planDay.at < (week.at || 0))
    await chrome.storage.local.set({ planDay: { date: today, at: Date.now(), chunks: days.today } });
  return { plan: st.plan, days, done: st.planDone || {} };
}

export async function startTask(ref) {
  const [kind, a, b] = ref.split(":");
  if (kind === "a") {
    const c = state.snapshot?.courses.find((x) => String(x.id) === a);
    const as = c?.assignments.find((x) => String(x.id) === b);
    if (as?.url) return chrome.tabs.create({ url: as.url });
    return toast("This assignment isn't open anymore.");
  }
  if (kind === "lec") {
    const key = ref.slice(4), courseId = Number(key.split(":")[0]);
    const l = (await lecturesFor(courseId).catch(() => [])).find((x) => x.key === key);
    const { openSheet, lectureScope } = await import("./sheet.js");
    if (l) return openSheet(lectureScope(courseId, l));
    return toast("StudyPilot can't find this lecture right now.");
  }
  if (kind === "review") {
    // exam review: a course quiz on the lectures in the plan for this course
    const sel = (await getPlan())?.selection?.lectures || [];
    return (await import("./coursequiz.js")).openCourseQuiz(Number(a), { preselect: sel.filter((k) => k.startsWith(`${a}:`)).length ? sel.filter((k) => k.startsWith(`${a}:`)) : null });
  }
}

async function toggleDone(chunk) {
  const { planDay, planDone = {} } = await get(["planDay", "planDone"]);
  if (!planDay) return;
  const c = planDay.chunks.find((x) => x.id === chunk.id);
  if (!c) return;
  c.done = !c.done;
  planDone[c.ref] = Math.max(0, (planDone[c.ref] || 0) + (c.done ? c.minutes : -c.minutes));
  await chrome.storage.local.set({ planDay, planDone });
  // keep a record of study time (used for pace)
  rerender();
}

export async function planCard() {
  const r = await computeDays();
  if (!r) return h("div", { class: "card" }, h("h3", {}, "Study plan"),
    h("p", { class: "muted", style: "margin:0 0 8px" }, "Pick what you're studying for. Your AI sizes the work from the real files; StudyPilot fits it into the study time you mark on My week and moves anything you miss."),
    h("button", { class: "btn small", onclick: () => openPlanSheet() }, "Make a study plan"));
  const { plan, days } = r;
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const refsNow = (visibleSnapshot()?.courses || []).filter((c) => plan.selection?.courses?.includes(c.id))
    .flatMap((c) => (c.assignments || []).filter((a) => a.due_at && !a.submitted && Date.parse(a.due_at) > Date.now() && Date.parse(a.due_at) < Date.now() + 14 * DAYMS).map((a) => aRef(c.id, a.id)));
  const why = needsReplan(plan, { refsNow });
  const courseOf = (ref) => Number(ref.split(":")[1]);
  const row = (c) => {
    const past = toMin(c.end) <= nowMin && !c.done, now = toMin(c.start) <= nowMin && nowMin < toMin(c.end);
    return h("div", { class: `plan-row${c.done ? " done" : ""}${now ? " now" : ""}${past ? " missed" : ""}`, style: `--c:${c.ref.startsWith("review:") || c.ref.startsWith("a:") || c.ref.startsWith("lec:") ? courseColor(courseOf(c.ref)) : "var(--muted)"}` },
      h("input", { type: "checkbox", checked: !!c.done, "aria-label": `Done: ${c.title}`, title: "Mark done", onchange: () => toggleDone(c) }),
      h("span", { class: "sched-time" }, `${niceTime(c.start)}–${niceTime(c.end)}`),
      h("span", { class: "sched-bar" }),
      h("span", { class: "grow" }, h("b", {}, c.title), h("small", {}, ` · ${courseName(courseOf(c.ref))}`)),
      c.done ? null : h("button", { class: "btn tiny soft", onclick: () => startTask(c.ref).catch((e) => toast(e.message, { error: true })) }, "Start"));
  };
  const short = days.short.filter((s) => s.priority <= 2);
  const Q = await import("./queue.js");
  return h("div", { class: "card plan-card" },
    h("div", { class: "row" }, h("h3", { class: "grow", style: "margin:0" }, "Today's plan"),
      h("button", { class: "btn small soft", onclick: () => openPlanSheet() }, "Change")),
    plan.advice ? h("div", { class: "meta", style: "margin:4px 0 6px" }, plan.advice) : null,
    days.today.length ? h("div", { class: "sched" }, days.today.map(row)) : h("div", { class: "muted", style: "margin:6px 0" }, "Nothing planned today."),
    days.today.some((c) => toMin(c.end) <= nowMin && !c.done) ? h("div", { class: "hint" }, "Didn't get to something? Leave it unchecked: it moves to your next study time.") : null,
    days.later.length ? h("details", { class: "topic-more" }, h("summary", {}, `Coming up: ${plural(days.later.length, "sitting")} until ${new Date(`${plan.to}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })}`),
      days.later.slice(0, 12).map((c) => h("div", { class: "plan-later" }, h("span", { class: "sched-time" }, `${new Date(`${c.date}T12:00:00`).toLocaleDateString([], { weekday: "short" })} ${niceTime(c.start)}`), h("span", { class: "grow" }, c.title)))) : null,
    short.length ? h("div", { class: "note warn" }, `Doesn't fit in your study time: ${short.slice(0, 3).map((s) => `${s.title} (${Math.round(s.minutes / 6) / 10} h${s.latest ? ` by ${new Date(`${s.latest}T12:00:00`).toLocaleDateString([], { weekday: "short" })}` : ""})`).join(", ")}. Add study time on My week, or replan.`) : null,
    why ? h("div", { class: "note" }, `${why} `, h("button", { class: "linkish", onclick: () => replan() }, "Update my plan")) : null,
    h("div", { class: "actions" },
      h("button", { class: "btn small soft", onclick: () => import("./weekai.js").then((m) => m.openWeek()) }, "My week"),
      h("button", { class: "btn small soft", onclick: () => replan() }, "Replan")));
}

/** A fresh look from the AI (weekly, or when something new came up): new assignments get sized, then the plan. */
export async function replan({ quiet = false } = {}) {
  const Q = await import("./queue.js");
  const { planSelection, planSizes = {} } = await get(["planSelection", "planSizes"]);
  if (!planSelection) return openPlanSheet();
  const snap = visibleSnapshot();
  const fresh = [];
  for (const c of snap?.courses || []) {
    if (!planSelection.courses.includes(c.id)) continue;
    for (const a of c.assignments || []) {
      if (!a.due_at || a.submitted || Date.parse(a.due_at) < Date.now() || Date.parse(a.due_at) > Date.now() + 21 * DAYMS) continue;
      const ref = aRef(c.id, a.id);
      if (!planSelection.assignments.includes(ref)) planSelection.assignments.push(ref);
      if (!planSizes[ref] || planSizes[ref].due !== a.due_at) fresh.push(ref);
    }
  }
  const today = ymd(new Date());
  if (!planSelection.to || planSelection.to <= today) planSelection.to = ymd(addDays(new Date(), 14));
  await chrome.storage.local.set({ planSelection });
  for (let i = 0; i < fresh.length; i += 4) await Q.addJob({ kind: "sizes", refs: fresh.slice(i, i + 4) }, { quiet: true });
  await Q.addJob({ kind: "priorities" }, { quiet: true });
  if (!quiet) { toast(`Your plan update is in your list for ${ai().url ? ai().name : "your AI"}.`, { ms: 6000 }); if (!state.pending) Q.startQueue(); }
}

/** On panel start: if the plan is due for a fresh look, put it in the AI list (once). */
export async function checkPlan() {
  const { plan, planChecked = 0 } = await get(["plan", "planChecked"]);
  if (!plan || Date.now() - planChecked < 6 * 3600e3) return;
  await chrome.storage.local.set({ planChecked: Date.now() });
  const refsNow = (visibleSnapshot()?.courses || []).filter((c) => plan.selection?.courses?.includes(c.id))
    .flatMap((c) => (c.assignments || []).filter((a) => a.due_at && !a.submitted && Date.parse(a.due_at) > Date.now() && Date.parse(a.due_at) < Date.now() + 14 * DAYMS).map((a) => aRef(c.id, a.id)));
  const why = needsReplan(plan, { refsNow });
  if (why) { await replan({ quiet: true }); toast(`${why} A plan update is in your list for ${ai().url ? ai().name : "your AI"}.`, { ms: 7000 }); }
}
