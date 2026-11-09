// Practice: today's review, exam prep, progress and weak topics across every course.
import { h, state, views, send, act, plural, visibleSnapshot, courseName, courseColor, empty, seg, toggle, toast, rerender, openCourse, shortDate } from "../core.js";
import { importReply } from "../aiflow.js";
import { bank, scopeStats, quizRow } from "../sheet.js";
import { startSession } from "../runner.js";
import { buildSession, isDue, isMistake, weakTopics, accuracy, allSessions, mastery, allQuizzes } from "../../lib/quiz.js";

import { focusSummaryCard } from "../focus.js";

views.practice = async (root) => {
  root.replaceChildren();
  const snap = visibleSnapshot();
  const visible = new Set((snap?.courses || []).map((c) => c.id));
  const all = (await bank()).filter((q) => !snap || visible.has(q.courseId));
  root.append(h("h2", { class: "page-title" }, "Practice"));

  if (!all.length) {
    root.append(h("div", { class: "card" }, h("h3", {}, "Start your question bank"),
      h("ol", { class: "steps-list" },
        h("li", {}, "Open a course and pick a lecture."),
        h("li", {}, "Choose Make a quiz. Your AI writes it; copy the reply and come back."),
        h("li", {}, "Practice here. StudyPilot tracks what you know and brings questions back right before you'd forget them.")),
      h("button", { class: "btn block", onclick: () => openCourse(null) }, "Go to my courses")));
    root.append(pasteCard(snap));
    return;
  }

  // Review queue
  const due = all.filter((q) => q.seen && isDue(q));
  const upcoming = all.filter((q) => q.seen && !isDue(q)).sort((a, b) => a.due - b.due)[0];
  const fresh = all.filter((q) => !q.seen && q.type !== "card").length;
  const mistakes = all.filter(isMistake).length;
  const when = (t) => { const d = Math.round((t - Date.now()) / 864e5); return d <= 0 ? "later today" : d === 1 ? "tomorrow" : `in ${d} days`; };
  root.append(h("div", { class: "card hero" }, h("h3", {}, "Today's review"),
    h("div", { class: "row" }, h("div", { class: "big-num" }, due.length),
      h("div", { class: "grow" }, h("b", {}, due.length ? `${plural(due.length, "question")} due` : "Nothing due"),
        h("div", { class: "meta" }, due.length ? "Short daily reviews beat cramming." : upcoming ? `Next review ${when(upcoming.due)}.` : "Answer some questions to start your schedule."))),
    h("div", { class: "actions" },
      due.length ? h("button", { class: "btn", onclick: () => startSession(buildSession(due, { mode: "review", count: 20 }), { mode: "review", title: "Today's review" }) }, "Start review") : null,
      fresh ? h("button", { class: "btn " + (due.length ? "secondary" : ""), onclick: () => startSession(buildSession(all, { mode: "practice", count: state.settings.quizCount || 10 }), { title: "New questions" }) }, `Learn ${Math.min(fresh, state.settings.quizCount || 10)} new`) : null,
      mistakes ? h("button", { class: "btn secondary", title: "Questions you missed, until you get each right twice in a row", onclick: () => startSession(buildSession(all, { mode: "mistakes", count: 20 }), { mode: "practice", title: "My mistakes" }) }, `Fix ${plural(mistakes, "mistake")}`) : null)));

  // Named quizzes, newest first
  const quizzes = (await allQuizzes().catch(() => [])).filter((z) => !snap || visible.has(z.courseId)).sort((a, b) => b.createdAt - a.createdAt);
  if (quizzes.length) {
    state.quizShow ??= 5;
    root.append(h("div", { class: "card" }, h("h3", {}, "Your quizzes"),
      h("div", { class: "quiz-list" }, quizzes.slice(0, state.quizShow).map((z) => quizRow(z, { showScope: true }))),
      quizzes.length > state.quizShow ? h("button", { class: "btn small soft block", style: "margin-top:6px", onclick: () => { state.quizShow += 10; rerender(); } }, `Show more (${quizzes.length - state.quizShow})`) : null));
  }

  // Exam prep
  state.allExams = await send("ALL_EXAMS").catch(() => []);
  root.append(examCard(all, snap));

  // Weak topics
  const weak = weakTopics(all).slice(0, 6);
  if (weak.length) root.append(h("div", { class: "card" }, h("h3", {}, "Weak spots"),
    weak.map((t) => h("div", { class: "item" },
      h("span", { class: "dot", style: `background:${courseColor(t.courseId)}` }),
      h("div", { class: "main" }, h("div", { class: "name" }, t.topic), h("div", { class: "meta" }, `${courseName(t.courseId)} · ${Math.round(t.accuracy * 100)}% right`)),
      h("button", { class: "btn small soft", onclick: () => views.startScope({ kind: "topic", courseId: t.courseId, topic: t.topic, title: t.topic }, "practice") }, "Practice")))));

  // Progress per course
  const byCourse = new Map();
  all.forEach((q) => { if (!byCourse.has(q.courseId)) byCourse.set(q.courseId, []); byCourse.get(q.courseId).push(q); });
  root.append(h("div", { class: "card" }, h("h3", {}, "Progress"),
    [...byCourse].map(([id, list]) => {
      const st = scopeStats(list), acc = accuracy(list);
      return h("button", { class: "progress-row", onclick: () => openCourse(id, "lectures") },
        h("span", { class: "dot", style: `background:${courseColor(id)}` }),
        h("span", { class: "grow" }, h("b", {}, courseName(id)), h("small", {}, `${plural(st.total, "question")}${st.cards ? ` · ${plural(st.cards, "card")}` : ""}${acc != null ? ` · ${Math.round(acc * 100)}% right` : ""}`)),
        h("span", { class: "meter wide", title: "Mastered" }, h("i", { style: `width:${Math.round(mastery(list) * 100)}%` })),
        h("small", { class: "pct" }, `${Math.round(mastery(list) * 100)}%`));
    })));

  root.append(await focusSummaryCard());

  const sessions = (await allSessions().catch(() => [])).sort((a, b) => b.at - a.at).slice(0, 5);
  if (sessions.length) root.append(h("div", { class: "card" }, h("h3", {}, "Recent sessions"),
    sessions.map((s) => h("div", { class: "item" }, h("div", { class: "main" }, h("div", { class: "name" }, s.title),
      h("div", { class: "meta" }, `${shortDate(new Date(s.at).toISOString())} · ${{ exam: "Exam", review: "Review", cards: "Flashcards", weak: "Weak spots" }[s.mode] || "Practice"}`)),
      h("span", { class: "pill" }, `${Math.round((s.score / Math.max(1, s.total)) * 100)}%`)))));

  root.append(pasteCard(snap));
};

function examCard(all, snap) {
  const courses = [...new Set(all.map((q) => q.courseId))];
  state.exam ??= { courseId: courses[0], modules: null, count: 20, timed: true };
  const E = state.exam;
  if (!courses.includes(E.courseId)) E.courseId = courses[0];
  const qs = all.filter((q) => q.courseId === E.courseId && q.type !== "card");
  const mods = [...new Set(qs.map((q) => q.module || q.lectureTitle || "Other"))];
  E.modules ??= new Set(mods);
  const picked = qs.filter((q) => E.modules.has(q.module || q.lectureTitle || "Other"));
  const next = (state.allExams || []).find((e) => e.courseId === E.courseId);
  const days = next ? Math.round((new Date(new Date(next.date).toDateString()) - new Date(new Date().toDateString())) / 864e5) : null;
  return h("div", { class: "card" }, h("h3", {}, "Exam prep"),
    h("p", { class: "muted", style: "margin-top:0" }, next ? `${next.title} is ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}. A mixed set across the units you choose, with answers at the end.` : "A mixed set across the units you choose, with answers at the end."),
    courses.length > 1 ? h("select", { "aria-label": "Course", onchange: (e) => { E.courseId = Number(e.target.value); E.modules = null; rerender(); } },
      courses.map((id) => h("option", { value: id, selected: id === E.courseId }, courseName(id)))) : null,
    mods.length > 1 ? h("details", { class: "adv" }, h("summary", {}, `Units: ${E.modules.size === mods.length ? "all" : `${E.modules.size} of ${mods.length}`}`),
      h("div", { class: "checks" }, mods.map((m) => h("label", {},
        h("input", { type: "checkbox", checked: E.modules.has(m), onchange: (e) => { e.target.checked ? E.modules.add(m) : E.modules.delete(m); rerender(); } }),
        h("span", { class: "grow" }, m), h("small", {}, String(qs.filter((q) => (q.module || q.lectureTitle || "Other") === m).length)))))) : null,
    h("div", { class: "field" }, "Questions"),
    seg([[10, "10"], [20, "20"], [30, "30"], [50, "50"]], E.count, (v) => { E.count = v; rerender(); }, "Number of questions"),
    toggle("Timed", "About 1.5 minutes per question", E.timed, (v) => { E.timed = v; }),
    h("button", { class: "btn block", disabled: picked.length < 3, onclick: () => startSession(buildSession(picked, { mode: "exam", count: E.count }), { mode: "exam", title: `${courseName(E.courseId)} exam prep`, timed: E.timed }) },
      picked.length < 3 ? "Need at least 3 questions" : `Start exam (${Math.min(E.count, picked.length)} questions)`));
}

// For questions you asked an AI yourself (on your phone, in another chat).
function pasteCard(snap) {
  const courses = snap?.courses || [];
  if (!courses.length) return null;
  state.pasteTarget ??= { courseId: courses[0].id, lectures: [], title: courses[0].code || courses[0].name };
  const ta = h("textarea", { rows: 3, placeholder: "Paste a reply that includes a studypilot-quiz block…", "aria-label": "AI reply with questions" });
  return h("details", { class: "card adv-card" }, h("summary", {}, "Add questions you got elsewhere"),
    h("p", { class: "muted" }, "Asked an AI on your phone or in another chat? Paste its reply here. Ask it to answer in StudyPilot's format by sending any practice request from a lecture first."),
    h("select", { "aria-label": "Course", onchange: (e) => { const c = courses.find((x) => x.id === Number(e.target.value)); state.pasteTarget = { courseId: c.id, lectures: [], title: c.code || c.name }; } },
      courses.map((c) => h("option", { value: c.id, selected: c.id === state.pasteTarget.courseId }, c.name))),
    h("div", { style: "height:6px" }), ta,
    act("Add to my bank", async () => { await importReply(ta.value); }, { cls: "btn small block", busyLabel: "Reading…", attrs: { style: "margin-top:6px" } }));
}
