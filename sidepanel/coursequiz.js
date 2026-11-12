// Course quiz: pick the lectures (and how much each counts), get a mixed quiz from the questions lecture mastery
// already made. No AI needed; good for midterms when the exact coverage isn't announced.
import { h, state, toast, plural, courseName, courseColor, go, lecturesFor, rerender, $ } from "./core.js";
import { allQuestions, buildSession } from "../lib/quiz.js";
import { pickVersions, onePerItem } from "../lib/qtypes.js";
import { itemLevel, lectureMastery } from "../lib/checklist.js";
import { startSession } from "./runner.js";

const PRIOS = [["0", "Skip"], ["1", "Low"], ["2", "Normal"], ["3", "High"]];

/** Opens the Practice tab on this course's quiz, with these lectures picked (e.g. what an exam covers). */
export function openCourseQuiz(courseId, { preselect = null } = {}) {
  state.cq = { courseId, pre: preselect ? new Set(preselect) : null, prio: {}, count: 20, exam: true, timed: false };
  go("practice");
  setTimeout(() => $(".card.course-quiz")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
}

/**
 * Picks `count` questions across groups in proportion to priority (High 3, Normal 2, Low 1), never more than a
 * group has. Within a lecture: one question per checklist item, items you've missed first.
 */
export function pickCourseQuiz(groups, { count = 20, stats = {}, rand = Math.random } = {}) {
  const live = groups.filter((g) => g.prio > 0 && g.questions.length);
  const total = live.reduce((a, g) => a + g.prio, 0);
  if (!total) return [];
  const quota = new Map(live.map((g) => [g, Math.floor((count * g.prio) / total)]));
  // hand out what's left by priority, then fill from groups that still have questions
  let left = count - [...quota.values()].reduce((a, b) => a + b, 0);
  for (const g of [...live].sort((a, b) => b.prio - a.prio)) { if (left <= 0) break; quota.set(g, quota.get(g) + 1); left--; }
  const order = (g) => {
    const v2 = g.questions.filter((q) => q.v === 2 && q.type !== "explain");
    const old = g.questions.filter((q) => q.v !== 2);
    const st = stats[g.key] || {};
    const rank = (q) => { const lv = itemLevel(st[q.items?.[0]]); return lv === "review" ? 0 : lv === "new" ? 1 : lv === "learning" ? 2 : 3; };
    const fromV2 = onePerItem(pickVersions(v2, rand), rand).sort((a, b) => rank(a) - rank(b) || rand() - 0.5);
    return [...fromV2, ...buildSession(old, { mode: "weak", count: old.length })];
  };
  const pools = new Map(live.map((g) => [g, order(g)]));
  const out = [];
  for (const g of live) out.push(...pools.get(g).splice(0, Math.min(quota.get(g), pools.get(g).length)));
  // short somewhere: top up from the others, highest priority first
  for (const g of [...live].sort((a, b) => b.prio - a.prio)) while (out.length < count && pools.get(g).length) out.push(pools.get(g).shift());
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

export async function courseQuizCard(all, snap) {
  const courses = [...new Set(all.filter((q) => q.type !== "card").map((q) => q.courseId))];
  if (!courses.length) return null;
  state.cq ??= { courseId: courses[0], pre: null, prio: {}, count: 20, exam: true, timed: false };
  const Q = state.cq;
  if (!courses.includes(Q.courseId)) Q.courseId = courses[0];
  const { checklists = {}, itemStats = {} } = await chrome.storage.local.get(["checklists", "itemStats"]);
  const qs = all.filter((q) => q.courseId === Q.courseId && q.type !== "card");
  const lectures = await lecturesFor(Q.courseId).catch(() => []);
  const titleOf = (key) => checklists[key]?.lecture?.title || lectures.find((l) => l.key === key)?.title || null;
  const byKey = new Map();
  for (const q of qs) { const k = q.lectureKey || "other"; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(q); }
  const rule = (state.settings.masteryLevel || {})[Q.courseId] || "solid";
  const groups = [...byKey].map(([key, list]) => ({
    key, title: key === "other" ? "Other questions" : titleOf(key) || list[0].lectureTitle || "A lecture", questions: list,
    order: lectures.findIndex((l) => l.key === key),
    mastered: checklists[key] ? lectureMastery(checklists[key].cl, itemStats[key] || {}, rule) : null,
  })).sort((a, b) => (a.key === "other") - (b.key === "other") || (a.order < 0) - (b.order < 0) || b.order - a.order);
  for (const g of groups) g.prio = Number(Q.prio[g.key] ?? (Q.pre ? (Q.pre.has(g.key) ? 2 : 0) : 2));
  const chosen = groups.filter((g) => g.prio > 0);
  const n = chosen.reduce((a, g) => a + g.questions.length, 0);
  const row = (g) => h("div", { class: "cq-row" },
    h("span", { class: "grow" }, h("b", {}, g.title), h("small", {}, `${plural(g.questions.length, "question")}${g.mastered ? ` · ${g.mastered.mastered}/${g.mastered.total} mastered` : ""}`)),
    h("select", { "aria-label": `How much ${g.title} counts`, onchange: (e) => { Q.prio[g.key] = Number(e.target.value); rerender(); } },
      PRIOS.map(([v, l]) => h("option", { value: v, selected: String(g.prio) === v }, l))));
  const start = async () => {
    const list = pickCourseQuiz(groups, { count: Q.count, stats: itemStats });
    if (!list.length) return toast("Pick at least one lecture with questions.", { error: true });
    await startSession(list, { mode: Q.exam ? "assessment" : "practice", title: `${courseName(Q.courseId)}: course quiz`, timed: Q.timed });
  };
  return h("div", { class: "card course-quiz" }, h("h3", {}, "Course quiz"),
    h("p", { class: "muted", style: "margin-top:0" }, "Pick the lectures and how much each counts. Questions come from your lecture mastery, missed ones first. No AI needed."),
    courses.length > 1 ? h("div", { class: "seg wrap", role: "group", "aria-label": "Course" }, courses.map((id) =>
      h("button", { class: id === Q.courseId ? "on" : "", "aria-pressed": String(id === Q.courseId), style: `--c:${courseColor(id)}`, onclick: () => { Q.courseId = id; Q.prio = {}; Q.pre = null; rerender(); } }, courseName(id)))) : null,
    h("div", { class: "cq-list" }, groups.map(row)),
    h("div", { class: "row", style: "margin-top:8px;gap:10px;flex-wrap:wrap" },
      h("label", {}, "Questions ", h("select", { onchange: (e) => { Q.count = Number(e.target.value); } }, [10, 15, 20, 30, 40].map((c) => h("option", { value: c, selected: c === Q.count }, String(c))))),
      h("label", {}, h("input", { type: "checkbox", checked: Q.exam, onchange: (e) => { Q.exam = e.target.checked; } }), " Answers at the end"),
      h("label", {}, h("input", { type: "checkbox", checked: Q.timed, onchange: (e) => { Q.timed = e.target.checked; } }), " Timed")),
    h("div", { class: "actions" }, h("button", { class: "btn", disabled: !n, onclick: start }, n ? `Start (${Math.min(Q.count, n)} questions)` : "Pick a lecture")));
}
