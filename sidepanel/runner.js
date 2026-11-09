// In-app practice: multiple choice, true/false, short answer (self-graded), flashcards. Keyboard friendly.
import { h, $, state, toast, plural, courseName } from "./core.js";
import { schedule, putQuestions, saveSession, suggestShort, weakTopics, accuracy, recordAttempt } from "../lib/quiz.js";
import { icon } from "../lib/icons.js";
import { rich } from "../lib/rich.js";

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

/** questions: bank records; mode: practice | review | exam | weak | cards */
export function startSession(questions, { mode = "practice", title = "Practice", timed = false, quizId = null } = {}) {
  if (!questions.length) { toast("No questions to practice yet.", { error: true }); return; }
  lastFocus = document.activeElement;
  S = {
    mode, title, quizId, list: questions.map(shuffleOptions), i: 0, results: [], picked: null, revealed: false, typed: "",
    exam: mode === "exam", cards: mode === "cards", started: Date.now(),
    endsAt: timed ? Date.now() + Math.max(5, Math.round(questions.length * 1.5)) * 6e4 : null,
  };
  $("#runner").hidden = false;
  document.body.classList.add("running");
  draw();
  if (S.endsAt) S.timer = setInterval(() => { if (Date.now() >= S.endsAt) finish(); else drawClock(); }, 1000);
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

function drawClock() {
  const el = $("#runner .clock");
  if (!el || !S.endsAt) return;
  const left = Math.max(0, S.endsAt - Date.now());
  el.textContent = `${Math.floor(left / 6e4)}:${String(Math.floor(left / 1e3) % 60).padStart(2, "0")}`;
}

function header() {
  return h("div", { class: "rn-head" },
    h("button", { class: "ghost", "aria-label": "Close practice", title: "Close (Esc)", onclick: confirmClose }, icon("close", 20)),
    h("div", { class: "grow" }, h("b", {}, S.title), h("div", { class: "meta" },
      S.exam ? "Exam mode: answers at the end" : S.cards ? "Flashcards" : S.mode === "review" ? "Spaced review" : S.quizId ? "Quiz" : "Practice")),
    S.endsAt ? h("span", { class: "pill clock", "aria-label": "Time left" }) : null,
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
  body.append(h("div", { class: "rn-topic" }, [q.topic, q.lectureTitle && q.lectureTitle !== q.topic ? q.lectureTitle : ""].filter(Boolean).join(" · ")));

  if (q.type === "card" || S.cards) drawCard(body, q);
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
  const res = { id: q.id, grade, topic: q.topic, prompt: q.prompt, ...extra };
  const at = S.results.findIndex((r) => r.id === q.id);
  if (at >= 0) S.results[at] = res; else S.results.push(res);
  if (grade) {
    const updated = schedule(q, grade);
    S.list[S.i] = { ...updated, _order: q._order };
    const { _order, ...save } = updated;
    putQuestions([save]).catch(() => {});
  }
}

function next() {
  S.i++; S.picked = null; S.revealed = false; S.typed = ""; S.pendingShort = false;
  draw();
}

// Exam mode grades short answers at the end.
function gradeLater(box) {
  const open = S.results.filter((r) => r.grade == null);
  if (!open.length) return false;
  const r = open[0];
  const q = S.list.find((x) => x.id === r.id);
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
    saveSession({ at: Date.now(), courseId: courseIds[0], courseIds, mode: S.quizId ? "quiz" : S.mode, title: S.title, total: graded.length, score, topics: topicRows, ms: Date.now() - S.started }).catch(() => {});
    if (S.quizId && graded.length === S.list.length) recordAttempt(S.quizId, { score, total: graded.length }).catch(() => {});
  }
  const missed = S.list.filter((q) => S.results.find((r) => r.id === q.id && r.grade && r.grade !== "right"));
  const weak = weakTopics(S.list).slice(0, 3);
  box.append(header(), h("div", { class: "rn-body" },
    h("div", { class: "rn-score" }, h("span", { class: "ring", style: `--p:${pct}` }, h("b", {}, `${pct}%`)),
      h("div", {}, h("b", {}, S.cards ? `${plural(graded.length, "card")} reviewed` : `${score % 1 ? score.toFixed(1) : score} of ${graded.length} right`),
        h("div", { class: "meta" }, pct >= 85 ? "Strong. These will come back later to stay fresh." : pct >= 60 ? "Good progress. Missed ones come back sooner." : "Missed questions come back in a few minutes and again tomorrow."))),
    topicRows.length > 1 ? h("div", { class: "card", style: "margin-top:12px" }, h("h3", {}, "By topic"),
      topicRows.map((r) => h("div", { class: "topic-row" }, h("span", { class: "grow" }, r.t), h("span", { class: "meter" }, h("i", { style: `width:${Math.round(r.p * 100)}%` })), h("small", {}, `${Math.round(r.p * 100)}%`)))) : null,
    weak.length ? h("div", { class: "note" }, "Review next: ", weak.map((w) => w.topic).join(", ")) : null,
    h("div", { class: "actions" },
      missed.length ? h("button", { class: "btn secondary", onclick: () => startSession(missed.map(({ _order, ...q }) => q), { mode: S.cards ? "cards" : "practice", title: `${S.title}: missed` }) }, "Redo missed") : null,
      S.quizId ? h("button", { class: "btn secondary", onclick: () => { const { quizId, title, list } = S; startSession(shuffled(list.map(({ _order, ...q }) => q)), { title, quizId }); } }, "Retake") : null,
      h("button", { class: "btn", "data-autofocus": true, onclick: close }, "Done"))));
  box.querySelector("[data-autofocus]")?.focus();
}

// Keyboard: A–F / 1–6 pick, T/F, Space flips a card, Enter goes on, 1/2/3 grade, Esc closes.
document.addEventListener("keydown", (e) => {
  if (!S || $("#runner").hidden) return;
  if (e.key === "Escape") { e.preventDefault(); return confirmClose(); }
  if (e.target.tagName === "TEXTAREA") return;
  if (S.i >= S.list.length) return;
  const q = cur();
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
