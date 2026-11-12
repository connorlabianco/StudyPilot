// Practice engine: question bank, spaced review (Leitner boxes), session builder, auto flashcards.
// Pure functions at the top (testable in Node); IndexedDB storage at the bottom.

export const BOX_DAYS = [0, 1, 3, 7, 16, 35];
const DAY = 864e5;
const MIN = 6e4;

function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Same question asked twice (even reworded slightly) is stored once.
export const questionId = (courseId, prompt) => `q${courseId}-${hashStr(norm(prompt).slice(0, 220))}`;

/** Turn parsed questions into bank records attached to lectures. lectures: [{key,title,module}] */
export function toRecords(questions, { courseId, lectures = [], source = "ai", now = Date.now() }) {
  const byTitle = new Map(lectures.map((l) => [norm(l.title), l]));
  const pick = (title) => {
    const t = norm(title);
    if (!t) return lectures[0];
    if (byTitle.has(t)) return byTitle.get(t);
    return lectures.find((l) => norm(l.title).includes(t) || t.includes(norm(l.title))) || lectures[0];
  };
  return questions.map((q) => {
    const l = pick(q.lecture) || {};
    return {
      id: questionId(courseId, q.prompt), courseId, lectureKey: l.key || null, lectureTitle: l.title || q.lecture || "",
      module: l.module || "", topic: q.topic || l.title || "General", type: q.type, prompt: q.prompt,
      options: q.options || null, answer: q.answer, explanation: q.explanation || "", source,
      createdAt: now, box: 0, due: now, seen: 0, right: 0, wrong: 0, last: null, streak: 0,
    };
  });
}

// ---------- Leitner scheduling ----------
// grade: "right" | "partial" | "wrong"
export function schedule(q, grade, now = Date.now()) {
  const r = { ...q, seen: (q.seen || 0) + 1, last: now };
  if (grade === "right") {
    r.right = (q.right || 0) + 1; r.streak = (q.streak || 0) + 1;
    r.box = Math.min(BOX_DAYS.length - 1, (q.box || 0) + 1);
    r.due = now + BOX_DAYS[r.box] * DAY;
  } else if (grade === "partial") {
    r.right = (q.right || 0) + 0.5; r.wrong = (q.wrong || 0) + 0.5; r.streak = 0;
    r.box = Math.max(1, q.box || 0);
    r.due = now + DAY;
  } else {
    r.wrong = (q.wrong || 0) + 1; r.streak = 0;
    r.box = 0;
    r.due = now + 10 * MIN;
  }
  return r;
}

export const isDue = (q, now = Date.now()) => (q.due ?? 0) <= now;
// A question you've gotten wrong (or partly wrong) that you haven't since answered right twice in a row.
export const isMistake = (q) => q.type !== "card" && !!q.seen && (q.wrong || 0) > 0 && (q.streak || 0) < 2;
export const isNew = (q) => !q.seen;
export const accuracy = (list) => {
  const r = list.reduce((a, q) => a + (q.right || 0), 0), w = list.reduce((a, q) => a + (q.wrong || 0), 0);
  return r + w ? r / (r + w) : null;
};
// 0–1: how far through the boxes the questions are (0 = never answered right, 1 = all in the last box).
export const mastery = (list) => list.length ? list.reduce((a, q) => a + (q.box || 0), 0) / (list.length * (BOX_DAYS.length - 1)) : 0;

function shuffle(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Spread picks across topics so one topic doesn't fill the session.
function spread(list, n) {
  const byTopic = new Map();
  for (const q of list) { const k = q.topic || ""; if (!byTopic.has(k)) byTopic.set(k, []); byTopic.get(k).push(q); }
  const queues = [...byTopic.values()];
  const out = [];
  while (out.length < n && queues.some((x) => x.length)) for (const qu of queues) if (qu.length && out.length < n) out.push(qu.shift());
  return out;
}

/**
 * mode: "practice" (due first, then new, then the rest), "review" (only due), "exam" (random mix, no feedback until the end),
 *       "weak" (lowest accuracy first), "cards" (flashcards; same order as practice)
 */
export function buildSession(all, { mode = "practice", count = 10, now = Date.now(), rand = Math.random } = {}) {
  const pool = all.filter((q) => q.type !== "retired");
  if (mode === "review") return spread(shuffle(pool.filter((q) => isDue(q, now) && q.seen), rand).sort((a, b) => a.box - b.box), count);
  if (mode === "exam") return spread(shuffle(pool, rand), count).filter((q) => q.type !== "card");
  if (mode === "mistakes") return shuffle(pool.filter(isMistake), rand).slice(0, count);
  if (mode === "weak") {
    const score = (q) => (q.seen ? (q.right || 0) / q.seen : 0.6) + q.box * 0.05;
    return shuffle(pool.filter((q) => q.seen).sort((a, b) => score(a) - score(b)).slice(0, count), rand);
  }
  const due = shuffle(pool.filter((q) => q.seen && isDue(q, now)), rand).sort((a, b) => a.box - b.box);
  const fresh = shuffle(pool.filter(isNew), rand);
  const later = shuffle(pool.filter((q) => q.seen && !isDue(q, now)), rand).sort((a, b) => a.due - b.due);
  const ordered = [...due, ...spread(fresh, fresh.length), ...later];
  // Flashcards only use questions with a simple answer (the new step-by-step formats don't flip well).
  const list = mode === "cards" ? ordered.filter((q) => q.v !== 2 || ["mcq", "tf"].includes(q.type)) : ordered.filter((q) => q.type !== "card");
  return list.slice(0, count);
}

// Weak topics across a list: at least two answers, under 70% right.
export function weakTopics(list, { min = 2, below = 0.7 } = {}) {
  const map = new Map();
  for (const q of list) {
    if (!q.seen) continue;
    const k = `${q.courseId}|${q.topic}`;
    if (!map.has(k)) map.set(k, { courseId: q.courseId, topic: q.topic, lectureTitle: q.lectureTitle, items: [] });
    map.get(k).items.push(q);
  }
  return [...map.values()].map((t) => ({ ...t, seen: t.items.reduce((a, q) => a + q.seen, 0), accuracy: accuracy(t.items) }))
    .filter((t) => t.seen >= min && t.accuracy != null && t.accuracy < below)
    .sort((a, b) => a.accuracy - b.accuracy);
}

// Short-answer checking: a light keyword overlap to suggest a grade; the student always decides.
export function suggestShort(given, model) {
  const words = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 3));
  const g = words(given), m = [...words(model)];
  if (!m.length || !g.size) return null;
  const hit = m.filter((w) => g.has(w)).length / m.length;
  return hit >= 0.6 ? "right" : hit >= 0.3 ? "partial" : "wrong";
}

// ---------- Flashcards without any AI ----------
// Picks "Term is/are/means …" and "Term: definition" sentences from lecture text.
export function autoCards(text, { courseId, lecture, max = 25, now = Date.now() }) {
  const out = [], seen = new Set();
  const lines = String(text || "").replace(/\r/g, "").split(/\n+|(?<=[.!?])\s+(?=[A-Z])/);
  const add = (term, def) => {
    term = term.replace(/^[-•*\d.)\s]+/, "").replace(/[*_`]/g, "").trim();
    def = def.replace(/[*_`]/g, "").trim().replace(/\s+/g, " ");
    def = def.charAt(0).toUpperCase() + def.slice(1);
    if (term.length < 2 || term.length > 60 || term.split(" ").length > 6) return;
    if (def.length < 15 || def.length > 300) return;
    if (/^(this|that|it|these|those|there|here|we|you|i|they|he|she|which|what|when|where|the following|example|note|figure|slide|page)\b/i.test(term)) return;
    const k = norm(term);
    if (seen.has(k)) return;
    seen.add(k);
    const prompt = `What is ${term}?`;
    out.push({
      id: questionId(courseId, `card:${term}:${lecture?.key || ""}`), courseId, lectureKey: lecture?.key || null, lectureTitle: lecture?.title || "",
      module: lecture?.module || "", topic: lecture?.title || "Key terms", type: "card", prompt, term, answer: def, explanation: "",
      source: "auto", createdAt: now, box: 0, due: now, seen: 0, right: 0, wrong: 0, last: null, streak: 0,
    });
  };
  for (const raw of lines) {
    const s = raw.trim();
    if (s.length < 20 || s.length > 360) continue;
    let m = s.match(/^([A-Z][\w\s\-()/']{1,60}?)\s*(?::|–|—| - )\s+(.{15,})$/);
    if (m && !/\d{1,2}:\d{2}/.test(s)) { add(m[1], m[2]); continue; }
    m = s.match(/^((?:An?|The)\s+)?([A-Za-z][\w\-()/' ]{1,50}?)\s+(is|are|means|refers to|is defined as|is called)\s+((?:a|an|the|when|how|any|one|used|defined)\b.{12,})$/);
    if (m) add(m[2], `${m[3] === "is" || m[3] === "are" ? "" : m[3] + " "}${m[4]}`.replace(/\.$/, "") + ".");
    if (out.length >= max) break;
  }
  return out;
}

// ---------- Backup ----------
export function exportBank(questions, quizzes = []) {
  return JSON.stringify({ app: "StudyPilot", kind: "question-bank", version: 2, exportedAt: new Date().toISOString(), questions, quizzes }, null, 1);
}
export function importQuizzes(text) {
  try { const o = JSON.parse(text); return Array.isArray(o?.quizzes) ? o.quizzes.filter((z) => z && z.id && Array.isArray(z.questionIds)) : []; } catch { return []; }
}
export async function putQuizzes(list) { await tx("quizzes", "readwrite", (st) => { list.forEach((z) => st.put(z)); }); }
export async function putSessions(list) { await tx("sessions", "readwrite", (st) => { list.forEach((x) => st.put(x)); }); }
export function importBank(text) {
  const obj = JSON.parse(text);
  const list = Array.isArray(obj) ? obj : obj?.questions;
  if (!Array.isArray(list)) throw new Error("That file isn't a StudyPilot question bank.");
  return list.filter((q) => q && q.id && q.prompt && q.courseId != null);
}

// ---------- Storage (IndexedDB) ----------
const DB = "studypilot-practice";
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (e.oldVersion < 1) {
        d.createObjectStore("questions", { keyPath: "id" }).createIndex("course", "courseId");
        d.createObjectStore("sessions", { keyPath: "id", autoIncrement: true }).createIndex("course", "courseId");
      }
      // v2: named quizzes (each AI reply becomes "Quiz 1", "Quiz 2", … you can retake)
      if (e.oldVersion < 2) d.createObjectStore("quizzes", { keyPath: "id" }).createIndex("course", "courseId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
const tx = async (store, mode, fn) => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
};

export async function allQuestions(courseId = null) {
  return tx("questions", "readonly", (s) => (courseId == null ? s.getAll() : s.index("course").getAll(courseId)));
}

// Adds new questions; existing ones (same id) keep their progress. Returns how many were new.
// Deletions are remembered (briefly) so syncing another computer doesn't bring them back.
async function tombstone(kind, ids) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  const { syncTombstones = { q: {}, z: {} } } = await chrome.storage.local.get("syncTombstones");
  const now = Date.now();
  ids.forEach((id) => { syncTombstones[kind][id] = now; });
  await chrome.storage.local.set({ syncTombstones });
}

export async function addQuestions(records) {
  const existing = new Set((await allQuestions()).map((q) => q.id));
  const now = Date.now();
  const fresh = records.filter((r) => !existing.has(r.id)).map((r) => ({ ...r, updatedAt: now }));
  await tx("questions", "readwrite", (s) => { fresh.forEach((r) => s.put(r)); });
  return fresh.length;
}
// touch: mark as changed now (for sync); sync itself writes without touching.
export async function putQuestions(records, { touch = true } = {}) {
  const now = Date.now();
  await tx("questions", "readwrite", (s) => { records.forEach((r) => s.put(touch ? { ...r, updatedAt: now } : r)); });
}
export async function deleteQuestions(ids) { await tx("questions", "readwrite", (s) => { ids.forEach((id) => s.delete(id)); }); await tombstone("q", ids); }
export async function saveSession(rec) { return tx("sessions", "readwrite", (s) => s.add(rec)); }
export async function allSessions() { return tx("sessions", "readonly", (s) => s.getAll()); }
// ---------- Named quizzes ----------
// A quiz is a fixed set of question ids from one AI reply. The questions still live in the shared bank,
// so taking a quiz also moves them along the review schedule.
export const quizScopeKey = (courseId, lectureKeys = [], title = "") => `${courseId}|${[...lectureKeys].sort().join(",") || title}`;

export async function addQuiz({ courseId, lectureKeys = [], scopeTitle = "", questionIds, now = Date.now() }) {
  const scopeKey = quizScopeKey(courseId, lectureKeys, scopeTitle);
  const same = (await allQuizzes(courseId)).filter((z) => z.scopeKey === scopeKey);
  const n = same.reduce((m, z) => Math.max(m, z.n || 0), 0) + 1;
  const quiz = { id: `z${now}-${Math.random().toString(36).slice(2, 7)}`, courseId, scopeKey, lectureKeys, scopeTitle, n,
    name: `Quiz ${n}`, questionIds: [...new Set(questionIds)], createdAt: now, updatedAt: now, attempts: [] };
  await tx("quizzes", "readwrite", (st) => { st.put(quiz); });
  return quiz;
}
export async function allQuizzes(courseId = null) {
  return tx("quizzes", "readonly", (st) => (courseId == null ? st.getAll() : st.index("course").getAll(courseId)));
}
export async function recordAttempt(quizId, { score, total, at = Date.now() }) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("quizzes", "readwrite"), st = t.objectStore("quizzes");
    const g = st.get(quizId);
    g.onsuccess = () => { const z = g.result; if (z) { z.attempts = [...(z.attempts || []), { at, score, total }].slice(-30); z.updatedAt = Date.now(); st.put(z); } };
    t.oncomplete = () => resolve(); t.onerror = () => reject(t.error);
  });
}
export async function deleteQuiz(id) { await tx("quizzes", "readwrite", (st) => { st.delete(id); }); await tombstone("z", [id]); }
export const bestPct = (z) => z.attempts?.length ? Math.max(...z.attempts.map((a) => (a.total ? a.score / a.total : 0))) : null;
// Quizzes for a set of lectures (any overlap), or the whole course.
export const quizzesFor = (quizzes, { courseId, lectureKeys = null }) => quizzes
  .filter((z) => z.courseId === courseId && (!lectureKeys || z.lectureKeys.some((k) => lectureKeys.includes(k))))
  .sort((a, b) => b.createdAt - a.createdAt);

export async function clearPractice() {
  await tombstone("q", (await allQuestions()).map((q) => q.id));
  await tombstone("z", (await allQuizzes()).map((z) => z.id));
  await tx("quizzes", "readwrite", (s) => s.clear());
  await tx("questions", "readwrite", (s) => s.clear());
  await tx("sessions", "readwrite", (s) => s.clear());
}
