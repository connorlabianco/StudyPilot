// In-app practice: multiple choice, true/false, short answer (self-graded), flashcards. Keyboard friendly.
import { h, $, state, toast, plural, courseName, lecturesFor } from "./core.js";
import { schedule, putQuestions, saveSession, suggestShort, weakTopics, accuracy, recordAttempt } from "../lib/quiz.js";
import { icon } from "../lib/icons.js";
import { rich } from "../lib/rich.js";
import { setupV2, drawV2, gradeExplainLater, keyV2 } from "./qviews.js";
import { prepare, filled } from "../lib/qtypes.js";
import { recordItems, allItems } from "../lib/checklist.js";

// Lecture checklists (for "Stuck?" notes and per-item mastery), loaded when a session starts.
let CHECKLISTS = {};
const prep = (q) => (q.v === 2 ? { ...q, _setup: setupV2(q), _inst: prepare(q) } : shuffleOptions(q));

const LETTERS = "ABCDEF";
let S = null; // current session
let lastFocus = null;

export function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// Options are shuffled every time, so you learn the answer rather than its position.
// "All/none of the above" and "Both A and B" stay last, where they make sense.
const PINNED = /\b(all|none|both|neither) of the above\b|^(both|neither)\b.*\b(and|nor)\b|^[a-f] and [a-f]$/i;
function shuffleOptions(q) {
  if (q.type !== "mcq") return q;
  const idx = q.options.map((_, i) => i);
  const pinned = idx.filter((i) => PINNED.test(q.options[i]));
  return { ...q, _order: [...shuffled(idx.filter((i) => !pinned.includes(i))), ...pinned] };
}

/**
 * questions: bank records; mode: practice | review | exam | weak | cards | mastery | assessment
 * versions: other versions of these questions (mastery mode retries a missed question in different words)
 */
export async function startSession(questions, { mode = "practice", title = "Practice", timed = false, quizId = null, versions = [], onDone = null } = {}) {
  if (!questions.length) { toast("No questions to practice yet.", { error: true }); return; }
  lastFocus = document.activeElement;
  CHECKLISTS = (await chrome.storage.local.get("checklists")).checklists || {};
  S = {
    mode, title, quizId, versions, onDone, retried: new Set(), help: {}, ui: {},
    list: questions.map(prep), i: 0, results: [], picked: null, revealed: false, typed: "",
    exam: mode === "exam" || mode === "assessment", cards: mode === "cards", started: Date.now(), times: {}, shownAt: Date.now(),
    endsAt: timed ? Date.now() + Math.max(5, Math.round(questions.length * 1.5)) * 6e4 : null,
  };
  $("#runner").hidden = false;
  document.body.classList.add("running");
  TIMER_HIDDEN = !!(await chrome.storage.local.get("timerHidden")).timerHidden;
  draw();
  S.timer = setInterval(() => { if (S.endsAt && Date.now() >= S.endsAt) finish(); else drawClock(); }, 1000);
}

function close() {
  if (S?.timer) clearInterval(S.timer);
  S = null;
  $("#runner").hidden = true;
  document.body.classList.remove("running");
  state.bank = null;
  state.onRunnerClose?.();
  lastFocus?.focus?.();
}

const cur = () => S.list[S.i];
const correctIndex = (q) => q.answer;
const displayOptions = (q) => (q._order || q.options.map((_, i) => i)).map((orig) => ({ orig, text: q.options[orig] }));

let TIMER_HIDDEN = false;
const mmss = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
function drawClock() {
  const el = $("#runner .clock");
  if (!el || !S) return;
  if (S.endsAt) { el.textContent = mmss(S.endsAt - Date.now()); return; }
  el.textContent = TIMER_HIDDEN ? "Show time" : mmss(Date.now() - S.started);
}
// Time spent on each question (first look until answered), for the results and for planning.
function stamp(q) { if (q && S.times[q.id] == null) S.times[q.id] = Date.now() - S.shownAt; }

function header() {
  return h("div", { class: "rn-head" },
    h("button", { class: "ghost", "aria-label": "Close practice", title: "Close (Esc)", onclick: confirmClose }, icon("close", 20)),
    h("div", { class: "grow" }, h("b", {}, S.title), h("div", { class: "meta" },
      S.mode === "assessment" ? "Assessment: results at the end" : S.exam ? "Exam mode: answers at the end" : S.cards ? "Flashcards" : S.mode === "mastery" ? "Lecture mastery: missed ones come back" : S.mode === "testout" ? "Quick check: what you get right counts as learned" : S.mode === "review" ? "Spaced review" : S.quizId ? "Quiz" : "Practice")),
    S.endsAt ? h("span", { class: "pill clock", "aria-label": "Time left" })
      : S.i < S.list.length ? h("button", { class: "pill clock", title: TIMER_HIDDEN ? "Show the time" : "Time so far. Click to hide it (it's still shown at the end).", onclick: async () => { TIMER_HIDDEN = !TIMER_HIDDEN; await chrome.storage.local.set({ timerHidden: TIMER_HIDDEN }); drawClock(); } }) : null,
    h("span", { class: "pill" }, `${Math.min(S.i + 1, S.list.length)} / ${S.list.length}`));
}

function confirmClose() {
  if (S.results.length && S.i < S.list.length && !confirm("End this session? Answers so far are saved.")) return;
  if (S.results.length && S.i < S.list.length) return finish();
  close();
}

function draw() {
  const box = $("#runner");
  box.replaceChildren();
  if (S.i >= S.list.length) return summary(box);
  const q = cur();
  const bar = h("div", { class: "rn-bar" }, h("i", { style: `width:${(S.i / S.list.length) * 100}%` }));
  const body = h("div", { class: "rn-body", role: "group", "aria-label": `Question ${S.i + 1}` });
  if (S.shownFor !== S.i) { S.shownFor = S.i; S.shownAt = Date.now(); }
  const unitWord = CHECKLISTS[q.lectureKey]?.unit === "cell" ? "cell" : "slide";
  const label = q.v === 2 || q.src === "terms"
    ? [q.lectureTitle, q.slide ? `${unitWord} ${q.slide}` : q.time ? `at ${q.time}` : ""].filter(Boolean).join(" · ")
    : [q.topic, q.lectureTitle && q.lectureTitle !== q.topic ? q.lectureTitle : ""].filter(Boolean).join(" · ");
  body.append(h("div", { class: "rn-topic" }, lectureLink(q, label)));

  if (q.v === 2) {
    drawV2(body, q, { ui: S.ui, exam: S.exam, inst: q._inst, setup: q._setup, last: S.i + 1 >= S.list.length,
      grade: (g, extra) => record(g, extra), next, redraw: draw, markHelp: () => { S.help[q.id] = true; } });
  } else if (q.type === "card" || S.cards) drawCard(body, q);
  else {
    body.append(h("div", { class: "rn-q" }, rich(q.prompt)));
    if (q.type === "mcq") drawMcq(body, q);
    else if (q.type === "tf") drawTf(body, q);
    else drawShort(body, q);
  }
  box.append(header(), bar, body);
  drawClock();
  (box.querySelector("[data-autofocus]") || box.querySelector(".rn-opt, textarea, .btn"))?.focus();
}

function feedback(body, ok, q, extra = null) {
  body.append(h("div", { class: "rn-fb " + (ok === true ? "good" : ok === "partial" ? "part" : "bad"), role: "status" },
    h("b", {}, ok === true ? "Correct" : ok === "partial" ? "Partly right" : "Not quite"),
    extra, q.explanation ? h("div", {}, rich(q.explanation)) : null));
  body.append(h("button", { class: "btn block", "data-autofocus": true, onclick: next }, S.i + 1 < S.list.length ? "Next" : "See results", h("kbd", {}, "Enter")));
}

function drawMcq(body, q) {
  const opts = displayOptions(q);
  const list = h("div", { class: "rn-opts" });
  opts.forEach((o, n) => {
    let cls = "rn-opt";
    if (S.revealed) {
      if (o.orig === correctIndex(q)) cls += " right";
      else if (o.orig === S.picked) cls += " wrong";
    } else if (S.exam && o.orig === S.picked) cls += " chosen";
    list.append(h("button", { class: cls, disabled: S.revealed, onclick: () => answerMcq(o.orig) }, h("span", { class: "key" }, LETTERS[n]), h("span", {}, rich(o.text))));
  });
  body.append(list);
  if (S.revealed) {
    const ok = S.picked === correctIndex(q);
    feedback(body, ok, q, ok ? null : h("div", {}, "Answer: ", h("b", {}, rich(q.options[correctIndex(q)]))));
  } else body.append(h("div", { class: "hint" }, "Press A–", LETTERS[opts.length - 1], " or 1–", String(opts.length)));
}
function answerMcq(orig) {
  const q = cur();
  S.picked = orig;
  record(orig === correctIndex(q) ? "right" : "wrong", { given: q.options[orig] });
  if (S.exam) return next();
  S.revealed = true; draw();
}

function drawTf(body, q) {
  const row = h("div", { class: "rn-opts two" });
  [[true, "True", "T"], [false, "False", "F"]].forEach(([v, l, k]) => {
    let cls = "rn-opt";
    if (S.revealed) { if (v === q.answer) cls += " right"; else if (v === S.picked) cls += " wrong"; }
    row.append(h("button", { class: cls, disabled: S.revealed, onclick: () => answerTf(v) }, h("span", { class: "key" }, k), h("span", {}, l)));
  });
  body.append(row);
  if (S.revealed) feedback(body, S.picked === q.answer, q, S.picked === q.answer ? null : h("div", {}, `It's ${q.answer ? "true" : "false"}.`));
}
function answerTf(v) {
  const q = cur();
  S.picked = v;
  record(v === q.answer ? "right" : "wrong", { given: v ? "True" : "False" });
  if (S.exam) return next();
  S.revealed = true; draw();
}

function drawShort(body, q) {
  if (!S.revealed) {
    const ta = h("textarea", { rows: 4, placeholder: "Type your answer (or answer in your head)…", "aria-label": "Your answer", oninput: (e) => (S.typed = e.target.value) });
    ta.value = S.typed;
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); reveal(); } });
    body.append(ta, h("button", { class: "btn block", onclick: reveal }, S.exam ? "Next" : "Check", h("kbd", {}, "Ctrl+Enter")));
    return;
  }
  const sug = suggestShort(S.typed, q.answer);
  body.append(h("div", { class: "rn-model" }, h("div", { class: "meta" }, "Model answer"), h("div", {}, rich(q.answer)), q.explanation ? h("div", { class: "meta", style: "margin-top:6px" }, rich(q.explanation)) : null));
  if (S.typed.trim()) body.append(h("div", { class: "rn-yours" }, h("div", { class: "meta" }, "Yours"), S.typed));
  body.append(h("div", { class: "field" }, "How did you do?"), selfGrade(sug));
}
function reveal() {
  if (S.exam) { S.pendingShort = true; record(null, { given: S.typed }); return next(); }
  S.revealed = true; draw();
}
function selfGrade(suggest) {
  return h("div", { class: "rn-grade" },
    [["wrong", "Missed it", "1"], ["partial", "Partly", "2"], ["right", "Got it", "3"]].map(([g, l, k]) =>
      h("button", { class: "btn small " + (g === "right" ? "" : "secondary") + (suggest === g ? " suggest" : ""), "data-autofocus": (suggest ? suggest === g : g === "right") || null, onclick: () => { record(g); next(); } }, l, h("kbd", {}, k))));
}

function drawCard(body, q) {
  const front = q.term ? q.term : q.prompt;
  const back = q.type === "mcq" ? q.options[q.answer] : q.type === "tf" ? (q.answer ? "True" : "False") : q.answer;
  body.append(h("button", { class: "rn-card" + (S.revealed ? " flipped" : ""), "aria-label": S.revealed ? "Answer shown" : "Show answer", onclick: () => { if (!S.revealed) { S.revealed = true; draw(); } } },
    h("div", { class: "rn-card-front" }, rich(front)),
    S.revealed ? h("div", { class: "rn-card-back" }, rich(back), q.explanation ? h("div", { class: "meta", style: "margin-top:8px" }, rich(q.explanation)) : null) : h("div", { class: "hint" }, "Space to flip")));
  if (S.revealed) body.append(h("div", { class: "field" }, "Did you know it?"), selfGrade(null));
}

function record(grade, extra = {}) {
  const q = cur();
  stamp(q);
  const res = { id: q.id, grade, topic: q.topic, prompt: q.prompt, ...extra };
  const at = S.results.findIndex((r) => r.id === q.id);
  if (at >= 0) S.results[at] = res; else S.results.push(res);
  if (grade) {
    const updated = schedule(q, grade);
    S.list[S.i] = { ...updated, _order: q._order, _setup: q._setup, _inst: q._inst };
    const { _order, _setup, _inst, ...save } = updated;
    putQuestions([save]).catch(() => {});
    if (q.v === 2) afterV2(q, grade);
  }
}

// Lecture mastery: per-item history, and a missed question comes back later in the session in different words.
async function afterV2(q, grade) {
  if (q.items?.length && q.lectureKey) {
    const { itemStats = {} } = await chrome.storage.local.get("itemStats");
    itemStats[q.lectureKey] = recordItems(itemStats[q.lectureKey], q.items, { qid: q.id, ok: grade === "right", help: !!S?.help[q.id], lv: q.level || null });
    await chrome.storage.local.set({ itemStats });
  }
  // Learning: one question per item. Missed, or answered after a hint or opening the lecture, gets one more
  // question on the same item in different words (another question on it if there is one, else another version).
  if (S?.mode === "mastery" && (grade !== "right" || S.help[q.id])) {
    const item = q.items?.[0] || q.group || q.id;
    if (S.retried.has(item)) return;
    S.retried.add(item);
    const inList = (v) => S.list.some((x) => x.id === v.id);
    const sameItem = S.versions.filter((v) => v.id !== q.id && !inList(v) && (v.items?.[0] || v.group || v.id) === item);
    const otherQ = sameItem.filter((v) => (v.group || v.id) !== (q.group || q.id));
    const pick = (l) => [...l].sort((a, b) => (a.seen || 0) - (b.seen || 0))[0];
    const again = pick(otherQ) || pick(sameItem) || q;
    // Not straight after: a couple of questions later, so it isn't answered from short-term memory.
    const at = Math.min(S.list.length, S.i + 3);
    S.list.splice(at, 0, prep({ ...again, _retry: true }));
  }
}

// The "Lecture 12 · slide 4" line on every question opens the lecture right there (in assessments too).
// Looking counts as help for that question, so mastery needs a later answer without looking. Never locks anything.
function lectureLink(q, label) {
  if (!label) return h("span", { class: "grow" });
  if (!q.lectureKey || (!q.slide && !q.time && !q.items?.length)) return h("span", { class: "grow" }, label);
  const tip = `Open ${q.lectureTitle || "the lecture"}${q.slide ? ` at ${CHECKLISTS[q.lectureKey]?.unit === "cell" ? "cell" : "slide"} ${q.slide}` : q.time ? ` at ${q.time}` : ""}, where this is explained. Looking is fine; this question just won't count toward mastery this time.`;
  return h("button", { class: "grow lec-link", title: tip, "aria-label": tip, onclick: () => { S.help[q.id] = true; openLecture(q); } }, icon("book", 13), " ", label);
}

// The library key of a lecture ("course:F:file"), from its checklist, the question, or the course's lecture list.
async function docKeyFor(q) {
  const cl = CHECKLISTS[q.lectureKey];
  if (cl?.lecture?.docKey) return cl.lecture.docKey;
  if (q.docKey) return q.docKey;
  if (/:(F|P|V|J):/.test(q.lectureKey)) return q.lectureKey;
  try { const l = (await lecturesFor(q.courseId)).find((x) => x.key === q.lectureKey); if (l?.doc_key) return l.doc_key; } catch { /* offline */ }
  return null;
}
export async function openLecture(q, page = null) {
  const cl = CHECKLISTS[q.lectureKey];
  const items = cl ? allItems(cl.cl).filter((it) => q.items?.includes(it.id)) : [];
  const slide = page || q.slide || items.flatMap((it) => it.slides || [])[0] || 1;
  const key = await docKeyFor(q);
  if (!key) return toast("StudyPilot can't find this lecture right now. Open it from the Lectures tab.", { error: true });
  const note = items.map((it) => it.text).join(" · ").slice(0, 400);
  // If this lecture is already open in a StudyPilot tab, jump that tab to the slide instead of opening another.
  const tabId = await new Promise((resolve) => {
    const ch = new BroadcastChannel("studypilot-viewer");
    const t = setTimeout(() => { ch.close(); resolve(null); }, 350);
    ch.onmessage = (e) => { if (e.data?.type === "here" && e.data.key === key) { clearTimeout(t); ch.close(); resolve(e.data.tabId); } };
    ch.postMessage({ type: "goto", key, page: slide, time: q.time || "", note });
  });
  if (tabId != null) {
    const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
    if (tab) { chrome.windows?.update(tab.windowId, { focused: true }).catch(() => {}); return; }
  }
  const params = new URLSearchParams({ key, page: slide });
  if (q.time) params.set("time", q.time);
  if (note) params.set("note", note);
  chrome.tabs.create({ url: chrome.runtime.getURL(`viewer/slide.html?${params}`), active: true });
}

function next() {
  S.i++; S.picked = null; S.revealed = false; S.typed = ""; S.pendingShort = false; S.ui = {};
  draw();
}

// Exam mode grades short answers at the end.
function gradeLater(box) {
  const open = S.results.filter((r) => r.grade == null);
  if (!open.length) return false;
  const r = open[0];
  const q = S.list.find((x) => x.id === r.id);
  if (q.v === 2) {
    const body = h("div", { class: "rn-body" }, h("div", { class: "rn-topic" }, `Check your written answers (${S.results.length - open.length + 1} of ${S.results.length})`));
    gradeExplainLater(body, q, r, (g) => {
      r.grade = g;
      const updated = schedule(q, g); const { _order, _setup, _inst, ...save } = updated; putQuestions([save]).catch(() => {});
      afterV2(q, g); draw();
    }, q._inst);
    box.append(header(), body);
    return true;
  }
  box.append(header(), h("div", { class: "rn-body" },
    h("div", { class: "rn-topic" }, `Check your written answers (${S.results.length - open.length + 1} of ${S.results.length})`),
    h("div", { class: "rn-q" }, rich(q.prompt)),
    h("div", { class: "rn-model" }, h("div", { class: "meta" }, "Model answer"), rich(q.answer)),
    r.given?.trim() ? h("div", { class: "rn-yours" }, h("div", { class: "meta" }, "Yours"), r.given) : h("div", { class: "meta" }, "(No answer typed)"),
    h("div", { class: "field" }, "How did you do?"),
    h("div", { class: "rn-grade" }, [["wrong", "Missed it"], ["partial", "Partly"], ["right", "Got it"]].map(([g, l]) =>
      h("button", { class: "btn small " + (g === "right" ? "" : "secondary"), onclick: () => {
        r.grade = g;
        const updated = schedule(q, g); const { _order, ...save } = updated; putQuestions([save]).catch(() => {});
        draw();
      } }, l)))));
  return true;
}

function finish() {
  if (S.timer) clearInterval(S.timer);
  S.i = S.list.length;
  draw();
}

function summary(box) {
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  if (gradeLater(box)) return;
  const graded = S.results.filter((r) => r.grade);
  const score = graded.reduce((a, r) => a + (r.grade === "right" ? 1 : r.grade === "partial" ? 0.5 : 0), 0);
  const pct = graded.length ? Math.round((score / graded.length) * 100) : 0;
  const byTopic = new Map();
  graded.forEach((r) => { const t = r.topic || "General"; if (!byTopic.has(t)) byTopic.set(t, []); byTopic.get(t).push(r); });
  const topicRows = [...byTopic].map(([t, list]) => {
    const p = list.reduce((a, r) => a + (r.grade === "right" ? 1 : r.grade === "partial" ? 0.5 : 0), 0) / list.length;
    return { t, p, n: list.length };
  }).sort((a, b) => a.p - b.p);
  if (!S.saved && graded.length) {
    S.saved = true;
    const courseIds = [...new Set(S.list.map((q) => q.courseId))];
    saveSession({ at: Date.now(), courseId: courseIds[0], courseIds, mode: S.quizId ? "quiz" : S.mode, title: S.title, total: graded.length, score, topics: topicRows, ms: Date.now() - S.started, perQuestion: S.list.filter((q) => S.times[q.id] != null).map((q) => ({ id: q.id, ms: S.times[q.id], type: q.type })) }).catch(() => {});
    if (S.quizId && graded.length === S.list.length) recordAttempt(S.quizId, { score, total: graded.length }).catch(() => {});
  }
  const missed = S.list.filter((q) => S.results.find((r) => r.id === q.id && r.grade && r.grade !== "right"));
  const missedV2 = missed.filter((q) => q.v === 2 && q.lectureKey && !q._retry);
  const reviewList = missedV2.length && (S.exam || S.mode === "mastery") ? h("div", { class: "card", style: "margin-top:12px" }, h("h3", {}, "Go back over these"),
    missedV2.slice(0, 8).map((q) => {
      const slide = q.slide;
      return h("div", { class: "topic-row" }, h("span", { class: "grow" }, rich(filled(q.prompt, q._inst).slice(0, 110) + (q.prompt.length > 110 ? "…" : ""))),
        slide ? h("button", { class: "btn tiny soft", title: `Open ${q.lectureTitle} at slide ${slide}`, onclick: () => openLecture(q, slide) }, `Slide ${slide}`) : null);
    })) : null;
  if (!S.doneCalled) { S.doneCalled = true; S.onDone?.({ score: 0, results: S.results, help: S.help }); }
  const weak = weakTopics(S.list).slice(0, 3);
  // Time: total, average per question, and the ones that took much longer than usual (often the shaky ones).
  const total = (S.endedAt ||= Date.now()) - S.started;
  const timed = S.list.filter((q) => S.times[q.id] != null);
  const avg = timed.length ? timed.reduce((a, q) => a + S.times[q.id], 0) / timed.length : 0;
  const slow = timed.length >= 4 ? timed.filter((q) => S.times[q.id] > Math.max(2 * avg, avg + 30e3)).sort((a, b) => S.times[b.id] - S.times[a.id]).slice(0, 3) : [];
  const timeCard = timed.length ? h("div", { class: "card", style: "margin-top:12px" }, h("h3", {}, "Time"),
    h("div", { class: "row" }, h("span", { class: "grow" }, "Total"), h("b", {}, mmss(total))),
    h("div", { class: "row" }, h("span", { class: "grow" }, "Average per question"), h("b", {}, mmss(avg))),
    slow.length ? h("div", { class: "meta", style: "margin-top:6px" }, "Took longest:") : null,
    slow.map((q) => h("div", { class: "topic-row" }, h("span", { class: "grow" }, rich((q.v === 2 ? filled(q.prompt, q._inst) : q.prompt || q.term || "").slice(0, 90))), h("small", {}, mmss(S.times[q.id]))))) : null;
  box.append(header(), h("div", { class: "rn-body" },
    h("div", { class: "rn-score" }, h("span", { class: "ring", style: `--p:${pct}` }, h("b", {}, `${pct}%`)),
      h("div", {}, h("b", {}, S.cards ? `${plural(graded.length, "card")} reviewed` : `${score % 1 ? score.toFixed(1) : score} of ${graded.length} right`),
        h("div", { class: "meta" }, pct >= 85 ? "Strong. These will come back later to stay fresh." : pct >= 60 ? "Good progress. Missed ones come back sooner." : "Missed questions come back in a few minutes and again tomorrow."))),
    topicRows.length > 1 ? h("div", { class: "card", style: "margin-top:12px" }, h("h3", {}, "By topic"),
      topicRows.map((r) => h("div", { class: "topic-row" }, h("span", { class: "grow" }, r.t), h("span", { class: "meter" }, h("i", { style: `width:${Math.round(r.p * 100)}%` })), h("small", {}, `${Math.round(r.p * 100)}%`)))) : null,
    reviewList,
    timeCard,
    weak.length && !S.list.some((q) => q.v === 2) ? h("div", { class: "note" }, "Review next: ", weak.map((w) => w.topic).join(", ")) : null,
    h("div", { class: "actions" },
      missed.length ? h("button", { class: "btn secondary", onclick: () => startSession(missed.map(({ _order, _setup, _inst, _retry, ...q }) => q), { mode: S.cards ? "cards" : "practice", title: `${S.title}: missed` }) }, "Redo missed") : null,
      S.quizId ? h("button", { class: "btn secondary", onclick: () => { const { quizId, title, list } = S; startSession(shuffled(list.map(({ _order, ...q }) => q)), { title, quizId }); } }, "Retake") : null,
      h("button", { class: "btn", "data-autofocus": true, onclick: close }, "Done"))));
  box.querySelector("[data-autofocus]")?.focus();
}

// Keyboard: A–F / 1–6 pick, T/F, Space flips a card, Enter goes on, 1/2/3 grade, Esc closes.
document.addEventListener("keydown", (e) => {
  if (!S || $("#runner").hidden) return;
  if (e.key === "Escape") { e.preventDefault(); return confirmClose(); }
  if (e.target.tagName === "TEXTAREA" && !(e.key === "Enter" && (e.ctrlKey || e.metaKey))) return;
  if (S.i >= S.list.length) return;
  const q = cur();
  if (q.v === 2) return keyV2(e, q, S.ui);
  const k = e.key.toLowerCase();
  if (S.revealed || (q.type === "short" && S.revealed)) {
    if (k === "enter" && !e.target.closest?.(".rn-grade") && $("#runner .rn-fb")) { e.preventDefault(); return next(); }
    if ($("#runner .rn-grade") && ["1", "2", "3"].includes(k)) { e.preventDefault(); record(["wrong", "partial", "right"][Number(k) - 1]); return next(); }
    return;
  }
  if (q.type === "card" || S.cards) { if (k === " " || k === "enter") { e.preventDefault(); S.revealed = true; draw(); } return; }
  if (q.type === "mcq") {
    const opts = displayOptions(q);
    let n = LETTERS.toLowerCase().indexOf(k);
    if (n < 0 && /^[1-6]$/.test(k)) n = Number(k) - 1;
    if (n >= 0 && n < opts.length) { e.preventDefault(); answerMcq(opts[n].orig); }
  } else if (q.type === "tf") {
    if (k === "t" || k === "1") answerTf(true);
    if (k === "f" || k === "2") answerTf(false);
  }
});

export const sessionTitle = (scope) => scope.title || (scope.courseId ? courseName(scope.courseId) : "Practice");
export { accuracy };
