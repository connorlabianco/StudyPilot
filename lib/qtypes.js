// Question formats that StudyPilot can check by itself (no AI needed once imported), and that test the idea,
// not the wording: multiple choice with reasons, true/false + why, select all, match, order the steps,
// numbers with tolerance (with fresh-number recipes), spot the mistake, step-by-step problems, and
// explain-in-your-own-words graded by key points. Pure functions (tested in Node).
import { repairLatexJson } from "./rich.js";
import { parseFormula, instantiate, fill, closeEnough, calc } from "./formula.js";
import { questionId } from "./quiz.js";

export const TYPES = ["mcq", "multi", "tf", "match", "order", "numeric", "error", "steps", "explain"];

export const QUESTION_FORMAT = `## Reply format
Reply with ONLY one code block tagged \`studypilot-quiz\`, written directly in your reply (not in an artifact, canvas or file). Inside it, put ONE question per line, each a complete JSON object. After the last question, end the block with the line {"end":true,"count":<how many questions you wrote>} (StudyPilot only accepts a reply that has this line, so it knows nothing was cut off). Every question has:
"type", "items" (the item ids it tests, like ["2.3"]), "slide" (the slide number), "group" (same value for versions of the same question, like "g7"), "level" ("recall", "understand" or "apply"), "question", "hint", "explanation" (why the answer is right, in a sentence or two).
"hint" is one short nudge toward the idea needed (for example "Think about what randomization protects against."). A hint must never make the answer obvious: don't name the deciding fact, count or rule, don't rule out options, and for "order" questions don't name what to sort by. Each step of a "steps" problem gets its own "hint" too.
For "order" questions, the question itself says what the order is (steps of a method in sequence, or ranking from least to most of something).
Types, with their extra fields:
\`\`\`studypilot-quiz
{"type":"mcq","items":["1.2"],"slide":4,"group":"g1","level":"understand","question":"…","options":["…","…","…","…"],"answer":2,"why":["why A is wrong","why B is wrong","why C is right","why D is wrong"],"explanation":"…"}
{"type":"multi","items":["1.3"],"slide":5,"group":"g2","level":"recall","question":"Which of these are required for …? (select all)","options":["…","…","…","…"],"answers":[0,2],"explanation":"…"}
{"type":"tf","items":["1.4"],"slide":5,"group":"g3","level":"understand","question":"<statement>","answer":false,"reasons":["<the real reason>","<a plausible wrong reason>","<another wrong reason>"],"reason":0,"explanation":"…"}
{"type":"match","items":["2.1","2.2"],"slide":7,"group":"g4","level":"understand","question":"Match each situation to the method that fits.","pairs":[["<left>","<right>"],["…","…"],["…","…"]],"explanation":"…"}
{"type":"order","items":["2.4"],"slide":8,"group":"g5","level":"recall","question":"Put the steps of … in order.","steps":["<first>","<second>","<third>","<fourth>"],"explanation":"…"}
{"type":"numeric","items":["3.1"],"slide":10,"group":"g6","level":"apply","question":"A sample of {n} has mean {xbar} and standard deviation {s}. Find the standard error.","recipe":{"vars":{"n":{"min":10,"max":60,"step":1},"xbar":{"min":20,"max":80,"step":0.5},"s":{"min":2,"max":12,"step":0.5}},"formula":"s/sqrt(n)","decimals":3},"tolerance":"1%","unit":"","explanation":"SE = s / √n."}
{"type":"numeric","items":["3.2"],"slide":11,"group":"g7","level":"apply","question":"<a problem with fixed numbers>","answer":4.27,"tolerance":0.01,"unit":"","explanation":"…"}
{"type":"error","items":["3.3"],"slide":12,"group":"g8","level":"apply","question":"This solution has one mistake. Which line?","lines":["<line 1>","<line 2>","<line 3>","<line 4>"],"wrong":2,"fix":"<what line 3 should say>","explanation":"…"}
{"type":"steps","items":["3.1","3.4"],"slide":13,"group":"g9","level":"apply","question":"<the problem, with {placeholders} if it uses a recipe>","example":"<a fully worked example of a similar problem, step by step>","recipe":{"vars":{"a":{"min":2,"max":9,"step":1}}},"steps":[{"question":"<what to do first?>","options":["…","…","…"],"answer":1,"hint":"…"},{"question":"<compute …>","formula":"a*2","tolerance":"1%","hint":"…"},{"question":"<final answer?>","answer":12.5,"tolerance":0.05}],"explanation":"…"}
{"type":"explain","items":["4.1"],"slide":15,"group":"g10","level":"understand","question":"In your own words, why …?","answer":"<a model answer>","points":["<key idea a good answer must include>","<another key idea>"],"explanation":"…"}
{"end":true,"count":10}
\`\`\`
Rules: "answer"/"answers"/"reason"/"wrong" are 0-based positions. Recipes: "vars" give a range (min, max, step) or a list of values; "formula" uses only + - * / ^, parentheses, the variable names and sqrt, abs, exp, ln, log, min, max, round, choose, fact, phi (normal CDF), pi, e. Put {name} in the question where each value goes. In "steps", a step is either multiple choice ("options" + "answer"), a fixed number ("answer"), or computed from the recipe ("formula").
Use "explain" for at most 1 question in 8. Never use "All/None of the above"; options get shuffled.
Math in LaTeX between dollar signs, with every backslash doubled inside JSON (\\\\frac). Code in a block fenced with ~~~.`;

// ---------- reading replies ----------
// Accepts one JSON object per line (cut-off replies keep their finished lines) or the older {"questions":[…]}.
export function parseQuestions(text) {
  const t = String(text || "");
  const at = t.indexOf("```studypilot-quiz");
  let body = at >= 0 ? t.slice(at + 18) : t;
  const end = body.search(/\n```\s*(\n|$)/);
  if (end >= 0) body = body.slice(0, end);
  const out = [];
  // Whole-object form first
  const trimmed = body.trim();
  if (/^\{\s*"questions"/.test(trimmed)) {
    for (const cand of [repairLatexJson(trimmed), trimmed]) {
      try { const o = JSON.parse(cand); (o.questions || []).forEach((q) => out.push(q)); return out; } catch { /* lines */ }
    }
  }
  // Line form: also handles objects spread over a few lines.
  let buf = "", depth = 0, inStr = false, esc = false;
  for (const ch of body) {
    if (depth === 0 && ch !== "{") continue;
    buf += ch;
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        for (const cand of [repairLatexJson(buf), buf]) { try { out.push(JSON.parse(cand)); break; } catch { /* skip broken */ } }
        buf = "";
      }
    }
  }
  return out;
}

const str = (v) => String(v ?? "").trim();
const idx = (v, n) => { const i = /^[A-Z]$/i.test(String(v)) ? String(v).toUpperCase().charCodeAt(0) - 65 : Number(v); return Number.isInteger(i) && i >= 0 && i < n ? i : -1; };
const list = (v, max = 8) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, max) : []);

function validRecipe(r) {
  if (!r || typeof r !== "object") return null;
  const vars = {};
  for (const [k, spec] of Object.entries(r.vars || {})) {
    if (!/^[A-Za-z_]\w*$/.test(k)) return null;
    if (Array.isArray(spec) && spec.length && spec.every((x) => Number.isFinite(Number(x)))) vars[k] = spec.map(Number);
    else if (spec && Number.isFinite(Number(spec.min)) && Number.isFinite(Number(spec.max)) && Number(spec.max) >= Number(spec.min)) vars[k] = { min: Number(spec.min), max: Number(spec.max), step: Number(spec.step) || undefined };
    else return null;
  }
  const out = { vars, decimals: Number.isInteger(r.decimals) ? r.decimals : null };
  if (r.formula != null) {
    try { parseFormula(String(r.formula)); out.formula = String(r.formula); } catch { return null; }
  }
  return out;
}

/** One AI question → { type, prompt, data, items, slide, group, level, explanation } or null if unusable. */
export function normalize(q) {
  const type = str(q.type).toLowerCase();
  const prompt = str(q.question || q.prompt);
  // Skip unfilled template lines ("…", "<statement>") in case an AI echoes the format back.
  const placeholder = (x) => /^(…|\.\.\.|<[^>]*>)$/.test(String(x ?? "").trim());
  if (!TYPES.includes(type) || !prompt || placeholder(prompt) || [].concat(q.options || []).some(placeholder)) return null;
  if ((JSON.stringify(q).match(/…|<[a-z][^<>]{0,40}>/gi) || []).length >= 2) return null; // still has template placeholders
  const base = { type, prompt, items: list(q.items, 6), slide: Number(String(q.slide ?? "").match(/\d+/)?.[0]) || null,
    group: str(q.group).slice(0, 30) || null, level: ["recall", "understand", "apply"].includes(q.level) ? q.level : "understand",
    explanation: str(q.explanation), hint: str(q.hint).slice(0, 400), time: q.time ? str(q.time) : null };
  const d = {};
  if (type === "mcq") {
    d.options = list(q.options, 6); d.answer = idx(q.answer, d.options.length); d.why = Array.isArray(q.why) ? q.why.map(str).slice(0, d.options.length) : [];
    if (d.options.length < 2 || d.answer < 0) return null;
  } else if (type === "multi") {
    d.options = list(q.options, 8); d.answers = [...new Set((q.answers || []).map((a) => idx(a, d.options.length)).filter((a) => a >= 0))];
    if (d.options.length < 3 || !d.answers.length) return null;
  } else if (type === "tf") {
    d.answer = typeof q.answer === "boolean" ? q.answer : /^(true|t|yes)$/i.test(str(q.answer));
    d.reasons = list(q.reasons, 5); d.reason = idx(q.reason, d.reasons.length);
    if (d.reasons.length && d.reason < 0) d.reasons = [];
  } else if (type === "match") {
    d.pairs = (q.pairs || []).filter((p) => Array.isArray(p) && str(p[0]) && str(p[1])).map((p) => [str(p[0]), str(p[1])]).slice(0, 7);
    if (d.pairs.length < 2 || new Set(d.pairs.map((p) => p[1])).size !== d.pairs.length) return null;
  } else if (type === "order") {
    d.steps = list(q.steps, 8);
    if (d.steps.length < 3) return null;
  } else if (type === "numeric") {
    d.tolerance = q.tolerance ?? null; d.unit = str(q.unit);
    d.recipe = validRecipe(q.recipe);
    if (d.recipe?.formula) { if (!instantiate(d.recipe)) return null; }
    else { d.recipe = null; d.answer = Number(q.answer); if (!Number.isFinite(d.answer)) return null; }
  } else if (type === "error") {
    d.lines = list(q.lines, 10); d.wrong = idx(q.wrong, d.lines.length); d.fix = str(q.fix);
    if (d.lines.length < 2 || d.wrong < 0) return null;
  } else if (type === "steps") {
    d.example = str(q.example); d.recipe = validRecipe(q.recipe);
    d.steps = (q.steps || []).map((s) => {
      const st = { question: str(s.question || s.prompt), hint: str(s.hint).slice(0, 300) };
      if (!st.question) return null;
      if (Array.isArray(s.options) && s.options.length >= 2) { st.options = list(s.options, 6); st.answer = idx(s.answer, st.options.length); if (st.answer < 0) return null; }
      else if (s.formula != null && d.recipe) { try { parseFormula(String(s.formula)); st.formula = String(s.formula); } catch { return null; } st.tolerance = s.tolerance ?? null; }
      else { st.answer = Number(s.answer); if (!Number.isFinite(st.answer)) return null; st.tolerance = s.tolerance ?? null; }
      return st;
    }).filter(Boolean).slice(0, 8);
    if (!d.steps.length) return null;
    if (d.recipe && !instantiate({ ...d.recipe, formula: d.recipe.formula || "0" })) return null;
  } else if (type === "explain") {
    d.answer = str(q.answer); d.points = list(q.points, 6);
    if (!d.answer || d.points.length < 1) return null;
  }
  return { ...base, data: d };
}

/** Bank records (v2), attached to one lecture (or course-wide), with versions grouped. */
export function toRecordsV2(qs, { courseId, lecture = null, part = null, mode = "mastery", batch = Date.now(), now = Date.now() }) {
  return qs.map((q, i) => ({
    id: questionId(courseId, `${lecture?.key || ""}|${q.type}|${q.prompt}|${JSON.stringify(q.data).slice(0, 200)}`),
    v: 2, courseId, lectureKey: lecture?.key || null, lectureTitle: lecture?.title || "", module: lecture?.module || "",
    topic: q.items.length ? `Item ${q.items.join(", ")}` : lecture?.title || "General",
    type: q.type, prompt: q.prompt, data: q.data, items: q.items, slide: q.slide, time: q.time,
    group: q.group ? `${lecture?.key || courseId}:${batch}:${q.group}` : null, level: q.level, explanation: q.explanation, hint: q.hint || "",
    part, mode, source: "ai", createdAt: now + i, box: 0, due: now, seen: 0, right: 0, wrong: 0, last: null, streak: 0,
  }));
}

// ---------- grading (all offline) ----------
const round = (x, dec) => (dec == null ? Number(x.toPrecision(4)) : Number(x.toFixed(dec)));

/** Fresh numbers for a question (numeric/steps with a recipe). Returns { vars, answer, stepAnswers } */
export function prepare(q, rand = Math.random) {
  const d = q.data || {};
  if (!d.recipe) return null;
  const inst = d.recipe.formula ? instantiate(d.recipe, rand) : (() => { const r = instantiate({ ...d.recipe, formula: "0" }, rand); return r && { vars: r.vars, answer: null }; })();
  if (!inst) return null;
  const stepAnswers = (d.steps || []).map((s) => (s.formula ? calc(s.formula, inst.vars) : null));
  return { vars: inst.vars, answer: inst.answer, stepAnswers };
}
export const filled = (text, inst) => (inst ? fill(text, inst.vars) : text);
export const shownNumber = (x, q) => round(Number(x), q.data?.recipe?.decimals ?? null);

export function gradeMulti(picked, answers) {
  const set = new Set(answers), p = new Set(picked);
  const hits = [...p].filter((x) => set.has(x)).length, extra = [...p].filter((x) => !set.has(x)).length;
  if (hits === set.size && !extra) return "right";
  if (hits / set.size >= 0.5 && extra <= 1) return "partial";
  return "wrong";
}
export function gradeMatch(chosen, pairs) {
  const ok = pairs.filter((p, i) => chosen[i] === p[1]).length;
  return ok === pairs.length ? "right" : ok / pairs.length >= 0.5 ? "partial" : "wrong";
}
export function gradeOrder(order, steps) {
  const inPlace = order.filter((s, i) => s === steps[i]).length;
  return inPlace === steps.length ? "right" : inPlace / steps.length >= 0.6 ? "partial" : "wrong";
}
export function gradeNumeric(given, answer, tolerance) { return closeEnough(given, answer, tolerance) ? "right" : "wrong"; }
export function gradePoints(ticked, total) { return ticked >= total ? "right" : ticked / total >= 0.5 ? "partial" : "wrong"; }
export function gradeSteps(results) { // results: [true/false]
  const ok = results.filter(Boolean).length;
  return ok === results.length ? "right" : ok / results.length >= 0.5 ? "partial" : "wrong";
}

// ---------- sessions ----------
const shuffle = (a, rand = Math.random) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// One question per version group: the least seen version, so wording keeps changing.
export function pickVersions(qs, rand = Math.random) {
  const groups = new Map();
  for (const q of qs) { const k = q.group || q.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(q); }
  return [...groups.values()].map((g) => shuffle(g, rand).sort((a, b) => (a.seen || 0) - (b.seen || 0))[0]);
}

// First pass through a part: which kind of question to open an item with (clear, quick to answer, auto-graded).
const FIRST = { mcq: 0, multi: 1, numeric: 2, match: 3, order: 3, tf: 4, error: 5, steps: 6, explain: 9 };
/** One question per checklist item: the one seen least, preferring clear first-look formats. */
export function onePerItem(qs, rand = Math.random) {
  const byItem = new Map();
  for (const q of qs) { const k = q.items?.[0] || q.group || q.id; if (!byItem.has(k)) byItem.set(k, []); byItem.get(k).push(q); }
  return [...byItem.values()].map((list) => shuffle(list, rand).sort((a, b) => (a.seen || 0) - (b.seen || 0) || (FIRST[a.type] ?? 5) - (FIRST[b.type] ?? 5))[0]);
}

/** A mastery part: one question per item of the part (more only for missed ones, added while you go),
 *  plus a few from earlier parts (due or weakest first). */
export function partSession(bank, { lectureKey, part, earlierParts = [], mix = 3, rand = Math.random }) {
  const mine = onePerItem(pickVersions(bank.filter((q) => q.v === 2 && q.lectureKey === lectureKey && q.part === part), rand), rand);
  const earlier = onePerItem(pickVersions(bank.filter((q) => q.v === 2 && q.lectureKey === lectureKey && earlierParts.includes(q.part)), rand), rand)
    .sort((a, b) => (a.due || 0) - (b.due || 0) || (a.box || 0) - (b.box || 0)).slice(0, mix);
  // Lecture order inside the part (items "2.1" before "2.3"), earlier-part review spread in.
  // Within an idea: quick checks first, then understanding, then applying, then explaining in your own words.
  const STAGE = { tf: 0, mcq: 1, multi: 1, match: 2, order: 2, numeric: 3, error: 3, steps: 4, explain: 5 };
  const key = (q) => (q.items?.[0] || "999").split(".").map((x) => x.padStart(3, "0")).join(".");
  const ordered = mine.sort((a, b) => key(a).localeCompare(key(b)) || (STAGE[a.type] ?? 3) - (STAGE[b.type] ?? 3));
  const out = [...ordered];
  earlier.forEach((q, i) => out.splice(Math.min(out.length, Math.round(((i + 1) * out.length) / (earlier.length + 1)) + i), 0, q));
  return out;
}

/** Assessment from the pool: a random sample of items, one fresh-as-possible question each, apply-heavy. */
export function poolAssessment(bank, { lectureKeys, count = 15, rand = Math.random, avoid = new Set() }) {
  const pool = bank.filter((q) => q.v === 2 && lectureKeys.includes(q.lectureKey) && q.type !== "explain");
  const byItem = new Map();
  for (const q of pool) for (const it of q.items?.length ? [q.items[0]] : [q.id]) { const k = `${q.lectureKey}|${it}`; if (!byItem.has(k)) byItem.set(k, []); byItem.get(k).push(q); }
  const picks = [];
  const used = new Set();
  const levelW = { apply: 3, understand: 2, recall: 1 };
  for (const k of shuffle([...byItem.keys()], rand)) {
    if (picks.length >= count) break;
    const cands = byItem.get(k).filter((q) => !used.has(q.group || q.id));
    if (!cands.length) continue;
    // Prefer versions you haven't seen in recent assessments, then higher-level questions.
    const best = shuffle(cands, rand).sort((a, b) => (avoid.has(a.id) - avoid.has(b.id)) || ((levelW[b.level] || 1) - (levelW[a.level] || 1)) || ((a.seen || 0) - (b.seen || 0)))[0];
    picks.push(best); used.add(best.group || best.id);
  }
  return shuffle(picks, rand);
}
