// One action sheet for every lecture, module, course and notebook set: Practice · Flashcards · Study guide · Download.
import { h, $, send, toast, state, ai, act, plural, courseById, courseName, askFileHostAccess, lecturesFor, safeFile, rerender, views, confirmSize } from "./core.js";
import { handToAI, MAX_ATTACH_BYTES } from "./aiflow.js";
import { startSession, shuffled } from "./runner.js";
import { questionsPrompt, notebookQuestionsPrompt } from "../lib/ai.js";
import { lectureBundlePack } from "../lib/packs.js";
import { notebooksPack } from "../lib/jupyter.js";
import { allQuestions, buildSession, addQuestions, autoCards, mastery, isDue, isMistake, allQuizzes, quizzesFor, bestPct, deleteQuiz } from "../lib/quiz.js";
import { icon } from "../lib/icons.js";
import { coverage, sameTopic, levelOf, levelClass } from "../lib/topics.js";

export async function bank() {
  if (!state.bank) state.bank = await allQuestions().catch(() => []);
  return state.bank;
}

/**
 * scope: { kind: "lecture"|"module"|"course"|"notebooks"|"topic", courseId, title, lectures?: [...], topic?, notebooks?: [{path,last_modified}] }
 * Questions belong to a scope when they're attached to one of its lectures (or the topic / course).
 */
export function inScope(q, scope) {
  if (scope.courseId != null && q.courseId !== scope.courseId) return false;
  if (scope.kind === "topic") return sameTopic(q.topic, scope.topic);
  if (scope.kind === "topics") return (scope.topics || []).some((t) => sameTopic(q.topic, t));
  if (scope.kind === "course") return true;
  if (scope.lectures?.length) return scope.lectures.some((l) => l.key === q.lectureKey);
  return true;
}
export async function scopeQuestions(scope) { return (await bank()).filter((q) => inScope(q, scope)); }

export function scopeStats(list) {
  const real = list.filter((q) => q.type !== "card");
  return { total: real.length, cards: list.length - real.length, due: list.filter((q) => q.seen && isDue(q)).length, fresh: list.filter((q) => !q.seen).length, mastery: mastery(list), level: levelOf(real), mistakes: real.filter(isMistake).length };
}

// Every topic the AI listed for these lectures (saved when quizzes are imported).
export async function scopeTopics(scope) {
  const { lectureTopics = {} } = await chrome.storage.local.get("lectureTopics");
  const keys = scope.kind === "course" ? Object.keys(lectureTopics).filter((k) => k.startsWith(`${scope.courseId}:`)) : (scope.lectures || []).map((l) => l.key);
  const out = [];
  for (const k of keys) for (const t of lectureTopics[k]?.topics || []) if (!out.some((o) => sameTopic(o, t))) out.push(t);
  return out;
}
export async function scopeCoverage(scope, list) {
  return coverage(await scopeTopics(scope), list || await scopeQuestions(scope));
}

// Start practice on a scope (used by the sheet, the "questions ready" banner and Practice).
views.startScope = async (scope, mode = "practice", { count, timed = false } = {}) => {
  const list = await scopeQuestions(scope);
  const n = count || (mode === "exam" ? Math.min(25, list.length) : state.settings.quizCount || 10);
  const picked = buildSession(list, { mode, count: n });
  if (!picked.length) return toast(mode === "mistakes" ? "No mistakes to fix here. Nice." : mode === "review" ? "Nothing due here right now." : "No questions here yet. Get some from your AI first.", { ms: 5000 });
  startSession(picked, { mode, title: scope.title || courseName(scope.courseId), timed });
};

// Named quizzes: the exact questions from one AI reply, in a new order each time.
views.takeQuiz = async (quiz) => {
  const byId = new Map((await bank()).map((q) => [q.id, q]));
  const list = shuffled(quiz.questionIds.map((id) => byId.get(id)).filter(Boolean));
  if (!list.length) return toast("This quiz's questions were removed.", { error: true });
  startSession(list, { title: `${quiz.scopeTitle || courseName(quiz.courseId)} · ${quiz.name}`, quizId: quiz.id });
};
export async function quizzesForScope(scope) {
  const all = await allQuizzes(scope.courseId).catch(() => []);
  const keys = scope.kind === "course" ? null : scope.kind === "topic" ? [] : (scope.lectures || []).map((l) => l.key);
  return quizzesFor(all, { courseId: scope.courseId, lectureKeys: keys });
}
export function quizRow(z, { onDelete, showScope = false } = {}) {
  const best = bestPct(z);
  const tries = z.attempts?.length || 0;
  return h("div", { class: "quiz-row" },
    h("button", { class: "quiz-main", onclick: () => { $("#sheet").open && $("#sheet").close(); views.takeQuiz(z); } },
      h("span", { class: "quiz-badge" + (best != null && best >= 0.85 ? " done" : "") }, best == null ? icon("play", 14) : `${Math.round(best * 100)}`),
      h("span", { class: "grow" }, h("b", {}, showScope ? `${z.scopeTitle} · ${z.name}` : z.name),
        h("small", {}, [plural(z.questionIds.length, "question"), tries ? `best ${Math.round(best * 100)}% · ${plural(tries, "try", "tries")}` : "not taken yet"].join(" · ")))),
    onDelete ? h("button", { class: "ghost small", "aria-label": `Delete ${z.name}`, title: "Delete quiz (questions stay in your bank)", onclick: onDelete }, icon("close", 14)) : null);
}

// ---------- lecture material ----------
// Reads lectures (library first) and decides what can go as text and which originals must be attached.
async function prepare(scope, { attach = false } = {}) {
  const picked = (scope.lectures || []).slice(0, 20);
  if (picked.some((l) => l.type === "File")) await askFileHostAccess();
  const docs = await send("LIBRARY_ENSURE", { courseId: scope.courseId, lectures: picked });
  const used = new Set();
  const unique = (name) => { let n = safeFile(name), i = 2; while (used.has(n.toLowerCase())) n = safeFile(name).replace(/(\.[^.]+)?$/, ` (${i++})$1`); used.add(n.toLowerCase()); return n; };
  const files = [];
  let visualPages = 0, mustAttach = false;
  const entries = docs.map((d) => {
    if (d.error) return { title: d.title, error: d.error };
    if (d.kind === "file") {
      const a = d.analysis || {};
      // Handwritten, scanned or picture-only slides (even with a header like "Course Page 14" on each page): send the file itself.
      const needsFile = !!(a.needsFile || a.scanned || a.error || a.unreadable);
      const hasText = !needsFile && (a.contentChars ?? (a.text || "").replace(/\s/g, "").length) > 200;
      visualPages += (a.visualPages || []).length;
      if (needsFile) mustAttach = true;
      if (needsFile || (attach && (d.file.size || 0) <= MAX_ATTACH_BYTES)) {
        const name = unique(d.file.name);
        files.push({ url: d.file.url, name, size: d.file.size });
        return { doc: d, attachName: name, inline: hasText && !attach ? false : hasText };
      }
      return { doc: d, inline: true };
    }
    visualPages += (d.images || []).length;
    const imageNames = attach ? (d.images || []).slice(0, 10).map((im) => { const n = unique(im.name); files.push({ url: im.url, name: n, size: im.size }); return n; }) : [];
    return { doc: d, imageNames, hiddenImages: attach ? 0 : (d.images || []).length };
  });
  await send("MARK_SEEN", { keys: picked.map((l) => l.key) }).catch(() => {});
  picked.forEach((l) => (l.is_new = false));
  return { docs, entries, files, visualPages, mustAttach };
}

const metaFor = (scope) => ({ courseId: scope.courseId, title: scope.title, lectures: (scope.lectures || []).map((l) => ({ key: l.key, title: l.title, module: l.module })) });

async function getQuestions(scope, { attach = false, focus = [] } = {}) {
  if (scope.kind === "notebooks") return getNotebookQuestions(scope);
  const course = courseById(scope.courseId);
  const p = await prepare(scope, { attach });
  const existing = (await scopeQuestions(scope)).filter((q) => q.type !== "card").map((q) => q.prompt);
  let text = questionsPrompt({ course: course?.code || course?.name, title: scope.title, entries: p.entries, count: state.settings.quizCount || 10, difficulty: state.settings.quizDifficulty || "mixed", focus });
  if (existing.length) text += `\n\n## Already in my question bank (don't repeat these; cover other parts or ask in a new way)\n${existing.slice(0, 60).map((x) => `- ${x.slice(0, 140)}`).join("\n")}`;
  await handToAI(text, { expect: "quiz", meta: metaFor(scope), title: scope.title, files: p.files });
  state.attachOffer = !attach && p.visualPages > 0 && !p.mustAttach ? { scope, visualPages: p.visualPages, what: "quiz", focus } : null;
}

async function studyGuide(scope, mode = "review", { attach = false } = {}) {
  if (scope.kind === "notebooks") return notebookGuide(scope);
  const course = courseById(scope.courseId);
  const p = await prepare(scope, { attach });
  const text = lectureBundlePack({ course: course?.code || course?.name, module: scope.module || scope.lectures?.[0]?.module, title: scope.title, entries: p.entries, mode,
    count: state.settings.quizCount || 10, difficulty: state.settings.quizDifficulty || "mixed" });
  await handToAI(text, { title: scope.title, files: p.files });
  state.attachOffer = !attach && p.visualPages > 0 && !p.mustAttach ? { scope, visualPages: p.visualPages, what: mode } : null;
  rerender();
}

// Flashcards with no AI: definitions pulled from the lecture text, plus any questions already in the bank.
async function flashcards(scope) {
  let list = await scopeQuestions(scope);
  if (scope.lectures?.length) {
    const docs = await send("LIBRARY_ENSURE", { courseId: scope.courseId, lectures: scope.lectures.slice(0, 20) });
    const cards = docs.flatMap((d, i) => d.error ? [] : autoCards(d.kind === "page" ? d.text : d.analysis?.text, { courseId: scope.courseId, lecture: scope.lectures[i] }));
    const added = await addQuestions(cards);
    if (added) { state.bank = null; list = await scopeQuestions(scope); }
  }
  const session = buildSession(list, { mode: "cards", count: 30 });
  if (!session.length) return toast("No flashcards found in this material yet. Get practice questions from your AI; they work as flashcards too.", { ms: 7000 });
  startSession(session, { mode: "cards", title: scope.title });
}

async function downloadScope(scope) {
  const course = courseById(scope.courseId);
  const files = (scope.lectures || []).filter((l) => l.type === "File");
  const pages = (scope.lectures || []).filter((l) => l.type === "Page");
  if (!files.length && !pages.length) return toast("Nothing to download here.");
  if (files.length) await askFileHostAccess();
  const picked = [...files, ...pages].slice(0, 60);
  const docs = await send("LIBRARY_ENSURE", { courseId: scope.courseId, lectures: picked });
  const name = course?.code || course?.name || String(scope.courseId);
  const list = [];
  docs.forEach((d, i) => {
    if (d.error) return;
    const folder = `Lectures/${picked[i]?.module || scope.module || ""}`;
    if (d.kind === "file") list.push({ url: d.file.url, name: d.file.name, size: d.file.size, course: name, folder, key: `f:${d.file.id}`, version: d.version });
    (d.images || []).forEach((im) => list.push({ url: im.url, name: im.name, size: im.size, course: name, folder, key: `pi:${scope.courseId}:${im.id}`, version: String(im.size) }));
  });
  if (!list.length) return toast("These lectures are text pages with no files. Use Study guide or Practice instead.", { ms: 6000 });
  if (!confirmSize(list.reduce((n, f) => n + (f.size || 0), 0), "These lecture files")) return;
  const r = await send("ZIP_FILES", { files: list, onlyNew: false });
  toast(r.zips.length ? `Saved ${plural(r.done, "file")} as a zip in Downloads › StudyPilot` : "Nothing new to download", { ms: 7000 });
}

// ---------- notebooks ----------
async function readNotebooks(scope) {
  const res = await send("JUPYTER_READ", { files: scope.notebooks.slice(0, 60), onlyNew: false });
  const docs = res.docs.filter((d) => d.text);
  if (!docs.length) throw new Error("Couldn't read those notebooks. Save them in Jupyter and try again.");
  return docs;
}
async function getNotebookQuestions(scope) {
  const docs = await readNotebooks(scope);
  const text = notebookQuestionsPrompt({ title: scope.title, docs, count: state.settings.quizCount || 10, difficulty: state.settings.quizDifficulty || "mixed" });
  await handToAI(text, { expect: "quiz", meta: metaFor(scope), title: scope.title });
}
async function notebookGuide(scope) {
  const docs = await readNotebooks(scope);
  const images = docs.flatMap((d) => d.images || []);
  const text = notebooksPack(docs, { goal: "study", hub: state.settings.jupyterUrl ? new URL(state.settings.jupyterUrl).host : "", figures: images.length });
  const files = images.slice(0, 20).map((im) => {
    const bytes = im.base64 ? Uint8Array.from(atob(im.data), (c) => c.charCodeAt(0)) : new TextEncoder().encode(im.data);
    return { name: im.name, size: bytes.length, url: URL.createObjectURL(new Blob([bytes], { type: im.mime })) };
  });
  await handToAI(text, { title: scope.title, files });
}

// ---------- the sheet ----------
export async function openSheet(scope) {
  const dlg = $("#sheet");
  const list = await scopeQuestions(scope);
  const st = scopeStats(list);
  const quizzes = await quizzesForScope(scope);
  const p = ai();
  const aiName = p.url ? p.name : "your AI";
  const closeSheet = () => { dlg.close(); };
  const run = (fn) => async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); closeSheet(); } catch (err) { toast(err.message, { error: true, ms: 8000 }); } finally { b.disabled = false; } };
  const tile = (ico, title, sub, fn, { primary = false, disabled = false } = {}) =>
    h("button", { class: "sheet-tile" + (primary ? " primary" : ""), disabled, onclick: run(fn) },
      h("span", { class: "ico-wrap" }, icon(ico, 20)), h("span", { class: "grow" }, h("b", {}, title), h("small", {}, sub)), icon("chevron", 16));

  const isNb = scope.kind === "notebooks";
  const prog = st.total ? `${plural(st.total, "question")} · ${st.due} due · ${st.level}` : "No questions yet";
  const cov = isNb ? null : await scopeCoverage(scope, list);
  const weakT = (cov?.rows || []).filter((r) => r.n && r.level === "Learning").map((r) => r.name);
  const topicRow = (r) => h("button", { class: "topic-pick", disabled: !r.n, title: r.n ? `Practice ${r.name}` : "No questions yet",
    onclick: run(() => views.startScope({ kind: "topic", courseId: scope.courseId, topic: r.name, title: r.name }, "practice")) },
    h("span", { class: "grow" }, r.name, r.n ? h("small", {}, ` · ${plural(r.n, "question")}`) : null), h("span", { class: `lv ${levelClass(r.level)}` }, r.level));
  const topicsSec = cov?.rows.length ? h("div", { class: "sheet-sec" },
    h("div", { class: "sheet-label" }, "Topics", h("span", {}, cov.total ? `${cov.covered} of ${cov.total} covered` : plural(cov.rows.length, "topic"))),
    cov.total ? h("div", { class: "cov-bar", role: "img", "aria-label": `${cov.covered} of ${cov.total} topics have questions` }, h("i", { style: `width:${Math.round((cov.covered / cov.total) * 100)}%` })) : null,
    h("div", { class: "topic-list" }, cov.rows.slice(0, 6).map(topicRow)),
    cov.rows.length > 6 ? h("details", { class: "topic-more" }, h("summary", {}, `All ${cov.rows.length} topics`), h("div", { class: "topic-list" }, cov.rows.slice(6).map(topicRow))) : null,
    cov.missing.length ? tile("spark", `Quiz me on ${cov.missing.length === 1 ? "the missing topic" : `the ${cov.missing.length} missing topics`}`, cov.missing.slice(0, 3).join(", ") + (cov.missing.length > 3 ? "…" : ""), () => getQuestions(scope, { focus: cov.missing })) : null,
    weakT.length ? tile("target", "Practice weak topics", weakT.slice(0, 3).join(", ") + (weakT.length > 3 ? "…" : ""), () => views.startScope({ kind: "topics", courseId: scope.courseId, topics: weakT, title: `${scope.title}: weak topics` }, "weak")) : null) : null;

  dlg.replaceChildren(h("div", { class: "sheet-in" },
    h("div", { class: "sheet-head" },
      h("div", { class: "grow" }, h("b", {}, scope.title), h("div", { class: "meta" }, [courseName(scope.courseId), scope.kind === "module" ? plural(scope.lectures.length, "lecture") : null].filter(Boolean).join(" · "))),
      h("button", { class: "ghost", "aria-label": "Close", onclick: closeSheet }, icon("close", 18))),
    h("div", { class: "sheet-sec" }, h("div", { class: "sheet-label" }, "Quizzes", h("span", {}, prog)),
      quizzes.length ? h("div", { class: "quiz-list" }, quizzes.slice(0, 6).map((z) => quizRow(z, { showScope: scope.kind !== "lecture" && z.scopeTitle !== scope.title, onDelete: async () => {
        if (!confirm(`Delete ${z.name}? Its questions stay in your bank for review.`)) return;
        await deleteQuiz(z.id); openSheet(scope);
      } })), quizzes.length > 6 ? h("div", { class: "hint" }, `+${quizzes.length - 6} older quizzes in Practice`) : null) : null,
      tile("spark", quizzes.length ? "New quiz" : "Make a quiz", `${aiName} writes ${state.settings.quizCount || 10} questions; you take it here`, () => getQuestions(scope), { primary: !quizzes.length }),
      st.total > (quizzes[0]?.questionIds.length || 0) ? tile("play", "Mixed practice", st.due ? `${st.due} due for review first, from all ${st.total} questions` : `From all ${st.total} questions, weakest first`, () => views.startScope(scope, "practice")) : null,
      st.mistakes ? tile("review", `My mistakes (${st.mistakes})`, "Questions you missed, until you get each right twice in a row", () => views.startScope(scope, "mistakes", { count: 20 })) : null,
      st.total >= 5 ? tile("timer", "Exam mode", "A timed mix with answers at the end", () => views.startScope(scope, "exam", { timed: true })) : null),
    topicsSec,
    h("div", { class: "sheet-sec" }, h("div", { class: "sheet-label" }, "Study"),
      !isNb ? tile("cards", "Flashcards", st.cards ? `${plural(st.cards, "card")} plus your questions` : "Key terms from the material, no AI needed", () => flashcards(scope)) : null,
      tile("book", "Study guide", `A summary, key ideas and examples in ${aiName}`, () => studyGuide(scope, "review")),
      !isNb ? tile("quiz", "Quiz me in the chat", `${aiName} asks one question at a time (not tracked here)`, () => studyGuide(scope, "quiz")) : null),
    !isNb && scope.lectures?.some((l) => l.type === "File" || l.type === "Page") ? h("div", { class: "sheet-sec" }, h("div", { class: "sheet-label" }, "Files"),
      tile("download", "Download", "Slides and images as one zip in Downloads › StudyPilot", () => downloadScope(scope))) : null));
  if (!dlg.open) dlg.showModal();
}

export const makeQuiz = (scope, opts) => getQuestions(scope, opts);
export const makeStudyGuide = (scope, mode = "review") => studyGuide(scope, mode);

// Offered after sending text only when the material has figures the AI couldn't see.
export function attachOfferCard() {
  const o = state.attachOffer;
  if (!o) return null;
  return h("div", { class: "card", style: "border-color:var(--accent)" },
    h("h3", {}, "Want the AI to see the slides too?"),
    h("p", { class: "muted", style: "margin:0" }, `“${o.scope.title}” has ${plural(o.visualPages, "page")} with diagrams, photos or handwriting. The AI got the text but can't see those.`),
    h("div", { class: "actions" },
      act("Send with slides", async () => { state.attachOffer = null; o.what === "quiz" ? await getQuestions(o.scope, { attach: true, focus: o.focus || [] }) : await studyGuide(o.scope, o.what, { attach: true }); }, { cls: "btn small", ico: "clip", busyLabel: "Preparing…" }),
      h("button", { class: "btn small soft", onclick: () => { state.attachOffer = null; rerender(); } }, "Text is fine")));
}

// Lecture scope helpers
export const lectureScope = (courseId, l) => ({ kind: "lecture", courseId, title: l.title, module: l.module, lectures: [l] });
export const moduleScope = (courseId, module, items) => ({ kind: "module", courseId, title: module, module, lectures: items });
export async function courseScope(courseId) {
  const all = await lecturesFor(courseId).catch(() => []);
  return { kind: "course", courseId, title: courseName(courseId), lectures: all.filter((l) => l.is_lecture) };
}
