// Lecture mastery: checklist → parts in lecture order → assessments. The AI writes everything once;
// StudyPilot checks coverage, runs practice offline and tracks mastery per item.
import { h, send, state, toast, plural, courseName, rerender, ai } from "./core.js";
import { handToAI, MAX_ATTACH_BYTES } from "./aiflow.js";
import { startSession } from "./runner.js";
import { icon } from "../lib/icons.js";
import { checklistPrompt, checklistFixPrompt, parseChecklist, mergeChecklist, checkCoverage, makeParts, allItems, itemLevel, lectureMastery, partPrompt, assessmentPrompt, LEVEL_LABEL, PART_MIN, recordItems, termsPrompt } from "../lib/checklist.js";
import { QUESTION_FORMAT, parseQuestions, normalize, toRecordsV2, partSession, poolAssessment, onePerItem, pickVersions } from "../lib/qtypes.js";
import { allQuestions, addQuestions, putQuestions } from "../lib/quiz.js";
import { safeFile } from "./core.js";
import { aiAction, addJob, getQueue, jobKey } from "./queue.js";

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// This course's meaning of "mastered" (Quick, Solid or Deep; set on the course's Lectures tab).
export const ruleFor = (courseId) => (state.settings.masteryLevel || {})[courseId] || "solid";
const getCL = async () => (await chrome.storage.local.get("checklists")).checklists || {};
const getStats = async () => (await chrome.storage.local.get("itemStats")).itemStats || {};
const saveCL = async (key, rec) => { const all = await getCL(); all[key] = { ...rec, at: Date.now() }; await chrome.storage.local.set({ checklists: all }); return all[key]; };
export const masteryCapable = (scope) => scope.kind === "lecture" && ["File", "Page", "Video", "Notebook"].includes(scope.lectures?.[0]?.type);

// ---------- the lecture itself: attach the file; text only when there is no file ----------
async function lectureMaterial(scope) {
  const l = scope.lectures[0];
  const [doc] = await send("LIBRARY_ENSURE", { courseId: scope.courseId, lectures: [l] });
  if (!doc || doc.error) throw new Error(`Couldn't read "${l.title}"${doc?.error ? `: ${doc.error}` : ""}.`);
  const files = [], attached = [];
  let unit = "slide", pageCount = 0, pages = [], text = "";
  if (doc.kind === "file") {
    const a = doc.analysis || {};
    unit = /pptx|pdf/.test(a.format || "") || /\.(pptx|pdf)$/i.test(doc.file?.name || "") ? "slide" : "page";
    pageCount = a.pageCount || 0;
    text = a.text || "";
    pages = text.split(/--- (?:Page|Slide|Sheet) (\d+) ---\n/).reduce((acc, part, i, arr) => { if (i % 2 === 1) acc.push({ n: Number(part), text: arr[i + 1] || "" }); return acc; }, []);
    if ((doc.file?.size || 0) <= MAX_ATTACH_BYTES) { const name = safeFile(doc.file.name); files.push({ url: doc.file.url, name, size: doc.file.size }); attached.push(name); }
  } else if (doc.kind === "notebook") {
    // A JupyterHub notebook: cells work like slides; its plots go along as pictures; the notebook text (code,
    // outputs and a description of the data it uses) is always included, since there's no original file to attach.
    unit = "cell";
    text = doc.text || "";
    pageCount = doc.cells || 0;
    pages = text.split(/--- Cell (\d+) ---\n/).reduce((acc, part, i, arr) => { if (i % 2 === 1) acc.push({ n: Number(part), text: arr[i + 1] || "" }); return acc; }, []);
    for (const f of doc.figures || []) files.push({ url: f.url, name: f.name, size: f.size });
    const material = text.slice(0, 90000);
    return { doc, files, attached: [], unit, pageCount, pages, material, lecture: { key: l.key, docKey: doc.key || l.doc_key || null, title: l.title, module: l.module, type: l.type, url: doc.url || l.url || null } };
  } else {
    text = doc.text || "";
    unit = doc.video ? "minute" : "section";
  }
  // The file is what the AI reads. Text goes along only when there's no file to attach
  // (a Canvas page, a recording's captions, or a file too big to attach).
  const backup = attached.length ? "" : text.trim() ? text.slice(0, 90000) : "_(This lecture has no readable text.)_";
  return { doc, files, attached, unit, pageCount, pages, material: backup, lecture: { key: l.key, docKey: doc.key || l.doc_key || null, title: l.title, module: l.module, type: l.type, url: doc.url || l.url || null } };
}

// ---------- 1. the checklist ----------
export async function buildChecklist(scope, { fix = null } = {}) {
  const key = scope.lectures[0].key;
  const rec = fix ? (await getCL())[key] : null; // a full rebuild starts a new chat
  const course = courseName(scope.courseId);
  const fresh = async () => {
    const m = await lectureMaterial(scope);
    const text = fix
      ? checklistFixPrompt({ title: m.lecture.title, slides: fix.missing, terms: fix.weak || {}, unit: m.unit, attached: m.attached }) + (m.material ? `\n\n## Lecture material\n${m.material}` : "")
      : checklistPrompt({ course, title: m.lecture.title, material: m.material, attached: m.attached, pageCount: m.pageCount, unit: m.unit });
    return { text, files: m.files, m };
  };
  const meta = (m) => ({ courseId: scope.courseId, lecture: m.lecture, scopeLecture: scope.lectures[0], pageCount: m.pageCount, unit: m.unit, fix: !!fix });
  if (fix && sameChat(rec)) {
    const text = checklistFixPrompt({ title: rec.lecture.title, slides: fix.missing, terms: fix.weak || {}, unit: rec.unit, inChat: true });
    return handToAI(text, { expect: "checklist", title: `${rec.lecture.title}: checklist`, chat: { url: rec.chat.url, fallback: fresh },
      meta: { courseId: scope.courseId, lecture: rec.lecture, pageCount: rec.pageCount, unit: rec.unit, fix: true } });
  }
  const f = await fresh();
  await handToAI(f.text, { expect: "checklist", title: `${f.m.lecture.title}: checklist`, files: f.files, meta: meta(f.m) });
}

// The chat this lecture's checklist came from: later requests go there (the AI already has the file and the checklist).
const sameChat = (rec) => !!(rec?.chat?.url && rec.chat.provider === ai().id);
export async function rememberChat(key, chat) {
  if (!chat) return;
  const all = await getCL();
  if (!all[key] || all[key].chat?.url === chat.url) return;
  all[key] = { ...all[key], chat };
  await chrome.storage.local.set({ checklists: all });
}

export async function importChecklist(text, meta) {
  const parsed = parseChecklist(text);
  const all = await getCL();
  const prev = all[meta.lecture.key];
  // Key terms only (for a checklist made before terms were included).
  if (meta.termsOnly || (!parsed.sections.length && prev)) {
    if (!prev) throw new Error("Build the lecture checklist first.");
    const terms = [...(prev.cl.terms || [])];
    for (const t of parsed.terms) if (!terms.some((x) => x.term.toLowerCase() === t.term.toLowerCase())) terms.push(t);
    await saveCL(meta.lecture.key, { ...prev, cl: { ...prev.cl, terms }, chat: prev.chat || meta.chat || null });
    toast(`${plural(parsed.terms.length, "key term")} added. They're your flashcards for this lecture.`, { ms: 7000 });
    return all[meta.lecture.key];
  }
  if (!parsed.sections.length) throw new Error("The checklist reply had no items. Ask your AI to follow the format exactly.");
  const started = !!prev && Object.keys(prev.generated || {}).length > 0;
  const cl = meta.fix && prev ? mergeChecklist(prev.cl, parsed, { keepOrder: started }) : parsed;
  // Check it against StudyPilot's own reading of the lecture.
  const [doc] = await send("LIBRARY_ENSURE", { courseId: meta.courseId, lectures: [{ ...meta.lecture, key: meta.lecture.key }] }).catch(() => [null]);
  const text2 = doc?.analysis?.text || "";
  const pages = text2.split(/--- (?:Page|Slide|Sheet) (\d+) ---\n/).reduce((acc, part, i, arr) => { if (i % 2 === 1) acc.push({ n: Number(part), text: arr[i + 1] || "" }); return acc; }, []);
  const coverage = meta.unit === "slide" || meta.unit === "page" ? checkCoverage(cl, { pageCount: meta.pageCount || doc?.analysis?.pageCount || 0, pages }) : { ok: true, missing: [], weak: {}, contentPages: 0, covered: 0 };
  const chat = meta.chat || (meta.fix ? prev?.chat : null) || null;
  let rec = await saveCL(meta.lecture.key, { cl, parts: makeParts(cl), lecture: { ...(prev?.lecture || {}), ...meta.lecture }, courseId: meta.courseId, pageCount: meta.pageCount, unit: meta.unit, coverage, generated: {}, chat });
  // Filling in an existing checklist: questions already made keep their items; parts are re-planned around them.
  if (meta.fix && started) rec = await regroupParts(meta.lecture.key);
  const n = allItems(cl).length;
  if (!meta.fix && rec.parts[0] && !rec.generated?.[1])
    await addJob({ kind: "part", n: 1, courseId: meta.courseId, course: courseName(meta.courseId), lecture: meta.scopeLecture || meta.lecture }, { front: true, quiet: true });
  toast(coverage.ok
    ? `Checklist saved: ${plural(n, "item")} in ${plural(rec.parts.length, "part")}${coverage.contentPages ? `, all ${coverage.contentPages} content ${meta.unit}s covered` : ""}.`
    : `Checklist saved (${plural(n, "item")}). ${coverage.missing.length ? `${plural(coverage.missing.length, meta.unit)} ${coverage.missing.length === 1 ? "is" : "are"} missing` : `A few ${meta.unit}s may be thin`}; fill ${coverage.missing.length === 1 ? "it" : "them"} in from the lecture menu.`, { ms: 9000 });
  return rec;
}

// Re-plans a lecture's parts (bigger parts, or after a fill-in) and moves the questions already made along:
// a question belongs to the part holding its first item. A part counts as made when all its items have questions.
export async function regroupParts(key) {
  const all = await getCL();
  const rec = all[key];
  if (!rec) return null;
  const parts = makeParts(rec.cl);
  const partOf = new Map(parts.flatMap((p) => p.items.map((id) => [id, p.n])));
  const bank = (await allQuestions(rec.courseId)).filter((q) => q.v === 2 && q.lectureKey === key && q.mode === "mastery");
  const moved = bank.filter((q) => q.items?.[0] && partOf.has(q.items[0]) && q.part !== partOf.get(q.items[0])).map((q) => ({ ...q, part: partOf.get(q.items[0]) }));
  if (moved.length) await putQuestions(moved);
  const covered = new Set(bank.flatMap((q) => q.items || []));
  const generated = {};
  for (const p of parts) {
    const missing = p.items.filter((id) => !covered.has(id));
    if (missing.length < p.items.length) generated[p.n] = { at: Date.now(), missing };
  }
  all[key] = { ...rec, parts, generated, at: Date.now() };
  await chrome.storage.local.set({ checklists: all });
  return all[key];
}

// Key terms for an older checklist: one short message in the lecture's chat (or a new chat with the file).
export async function getTerms(scope) {
  const key = scope.lectures[0].key;
  const rec = (await getCL())[key];
  if (!rec) throw new Error("Build the lecture checklist first.");
  const opts = { expect: "checklist", title: `${rec.lecture.title}: key terms`, meta: { courseId: scope.courseId, lecture: rec.lecture, unit: rec.unit, termsOnly: true } };
  const fresh = async () => { const m = await lectureMaterial(scope); return { text: termsPrompt({ title: rec.lecture.title, attached: m.attached, material: m.material }), files: m.files }; };
  if (sameChat(rec)) return handToAI(termsPrompt({ title: rec.lecture.title, inChat: true }), { ...opts, chat: { url: rec.chat.url, fallback: fresh } });
  const f = await fresh();
  await handToAI(f.text, { ...opts, files: f.files });
}

// Flashcards: the key terms from the checklists of the lectures in scope (written by the AI from the lecture itself).
export async function termCards(scope) {
  const all = await getCL();
  const out = [];
  for (const l of scope.lectures || []) {
    const rec = all[l.key];
    for (const t of rec?.cl?.terms || []) out.push({ id: `term:${l.key}:${t.term.toLowerCase().replace(/\s+/g, " ").slice(0, 80)}`, type: "card", src: "terms",
      term: t.term, answer: t.def, prompt: t.term, slide: t.slide, courseId: scope.courseId, lectureKey: l.key, lectureTitle: rec.lecture.title, topic: rec.lecture.title });
  }
  return { cards: out, withChecklist: (scope.lectures || []).filter((l) => all[l.key]).length, withTerms: (scope.lectures || []).filter((l) => all[l.key]?.cl?.terms?.length).length };
}

// Study guide and "Ask about this lecture": in the lecture's own chat when there is one (it already has the file
// and the checklist), otherwise a new chat with the file.
export async function lectureChatAsk(scope, what) {
  const key = scope.lectures[0].key;
  const rec = (await getCL())[key];
  const title = rec?.lecture.title || scope.lectures[0].title;
  const body = (src) => what === "guide"
    ? `# Study guide: ${title}\n\nUsing ${src}, write me a study guide: a short summary, every key idea with a simple example, the formulas and methods written exactly the way the lecture does them (same notation and steps), terms to know, and common mistakes. Point to slide numbers so I can look things up. Write it directly in your reply.`
    : `I'm studying ${title}. I'll ask you questions about ${src}. Answer using the lecture's own notation and steps, keep it short, and tell me which slide to look at. Don't give me answers to graded homework or exams; help me understand the ideas instead.\n\nMy question: `;
  const fresh = async () => {
    const m = await lectureMaterial(scope);
    const src = m.attached.length ? "the attached lecture" : "the lecture below";
    const mat = m.material ? `\n\n## Lecture material\n${m.material}\n\n` : "";
    // for questions, the student's own question goes last, where the cursor is
    const text = what === "ask" ? body(src).replace("\n\nMy question: ", `${mat || "\n\n"}My question: `) : body(src) + mat;
    return { text, files: m.files };
  };
  if (sameChat(rec)) return handToAI(body("the lecture file I sent earlier in this chat"), { title, chat: { url: rec.chat.url, fallback: fresh } });
  const f = await fresh();
  await handToAI(f.text, { title, files: f.files });
}

// "I already know this": 5 questions from a part, applying ones first. All right with no help: every item in the
// part counts as answered right today, so it only comes back for a later-day check.
async function testOut(scope, n) {
  const key = scope.lectures[0].key;
  const rec = (await getCL())[key];
  const part = rec.parts.find((p) => p.n === n);
  const bank = (await allQuestions(scope.courseId)).filter((q) => q.v === 2 && q.lectureKey === key && q.part === n && q.type !== "explain");
  const lvl = { apply: 0, understand: 1, recall: 2 };
  // About half the part's items (5 to 8 questions, one per item); only the items asked about count as learned.
  const want = Math.min(8, Math.max(5, Math.ceil(part.items.length / 2)));
  const list = onePerItem(pickVersions(bank)).sort((a, b) => (lvl[a.level] ?? 1) - (lvl[b.level] ?? 1) || Math.random() - 0.5).slice(0, want);
  if (list.length < 3) return toast("This part needs its questions first: press Make.", { error: true });
  await startSession(list, { mode: "testout", title: `${rec.lecture.title} · Part ${n}: already know it?`, versions: [], onDone: async ({ results, help }) => {
    const right = results.filter((r) => r.grade === "right" && !(help || {})[r.id]).length;
    if (right < list.length) return toast(`${right} of ${list.length} right on your own; those count. Start the part to learn the rest.`, { ms: 7000 });
    // The answers themselves were recorded as you went; nothing extra is credited for items that weren't asked.
    const asked = new Set(list.flatMap((q) => q.items || []));
    const rest = part.items.filter((id) => !asked.has(id)).length;
    toast(rest ? `Nice: ${plural(asked.size, "item")} count as ${ruleFor(scope.courseId) === "quick" ? "mastered" : "learned"}. The other ${rest} come up when you start the part.`
      : ruleFor(scope.courseId) === "quick" ? `Part ${n} counts as mastered.` : `Part ${n} counts as learned. Its items come back on another day to be mastered.`, { ms: 8000 });
  } });
}

// ---------- 2. parts ----------
export async function generatePart(scope, n, { only = null } = {}) {
  const key = scope.lectures[0].key;
  const rec = (await getCL())[key];
  if (!rec) throw new Error("Build the lecture checklist first.");
  const part = rec.parts.find((p) => p.n === n);
  const stats = (await getStats())[key] || {};
  const earlierIds = rec.parts.filter((p) => p.n < n).flatMap((p) => p.items);
  const byId = new Map(allItems(rec.cl).map((it) => [it.id, it]));
  // Mix in earlier items that aren't mastered yet (or a few random ones).
  const earlier = earlierIds.map((id) => byId.get(id)).filter(Boolean)
    .sort((a, b) => (itemLevel(stats[a.id], ruleFor(scope.courseId)) === "mastered") - (itemLevel(stats[b.id], ruleFor(scope.courseId)) === "mastered") || Math.random() - 0.5).slice(0, 5);
  const usePart = only ? { ...part, items: only } : part;
  const base = { course: courseName(scope.courseId), title: rec.lecture.title, cl: rec.cl, part: usePart, partsTotal: rec.parts.length, earlier, format: QUESTION_FORMAT, notebook: rec.unit === "cell" };
  // A new chat gets the file again plus the whole checklist; the checklist's own chat already has both.
  const fresh = async () => { const m = await lectureMaterial(scope); return { text: partPrompt({ ...base, attached: m.attached, material: m.material, whole: true }), files: m.files }; };
  const opts = { expect: "quiz", title: `${rec.lecture.title}: Part ${n}`, meta: { v2: true, courseId: scope.courseId, lecture: rec.lecture, part: n, mode: "mastery", lectures: [rec.lecture] } };
  if (sameChat(rec)) return handToAI(partPrompt({ ...base, inChat: true }), { ...opts, chat: { url: rec.chat.url, fallback: fresh } });
  const f = await fresh();
  await handToAI(f.text, { ...opts, files: f.files });
}

export async function importV2(text, meta) {
  const raw = parseQuestions(text);
  const qs = raw.map(normalize).filter(Boolean);
  if (!qs.length) throw new Error(raw.length ? "None of the questions in that reply were complete. Ask your AI to follow the format exactly." : "StudyPilot couldn't find questions in that reply. Copy the AI's whole answer, including the block that starts with ```studypilot-quiz.");
  const batch = Date.now();
  const all = await getCL();
  // Multi-lecture assessments tag items like "B2.3" (lecture B, item 2.3).
  const lectureOf = (q) => {
    if (!meta.letters) return meta.lecture;
    const L = q.items[0]?.match(/^([A-Z])/)?.[1];
    return (L && meta.letters[L]) || meta.lectures?.[0] || null;
  };
  const records = [];
  for (const q of qs) {
    const lec = lectureOf(q);
    const items = meta.letters ? q.items.map((x) => x.replace(/^[A-Z]/, "")) : q.items;
    const [r] = toRecordsV2([{ ...q, items }], { courseId: meta.courseId, lecture: lec, part: meta.part ?? null, mode: meta.mode, batch });
    // Name the topic after the checklist section ("Blocking"), so weak spots read naturally.
    const cl = lec && all[lec.key]?.cl;
    const sec = cl?.sections.find((s) => s.items.some((it) => it.id === items[0]));
    if (sec) r.topic = sec.title;
    records.push(r);
  }
  const added = await addQuestions(records);
  let note = "";
  if (meta.mode === "mastery" && meta.lecture) {
    const rec = all[meta.lecture.key];
    const part = rec?.parts.find((p) => p.n === meta.part);
    if (part) {
      const tested = new Set(records.flatMap((r) => r.items));
      const missing = part.items.filter((id) => !tested.has(id));
      rec.generated = { ...(rec.generated || {}), [meta.part]: { at: Date.now(), missing } };
      await saveCL(meta.lecture.key, rec);
      if (missing.length) note = ` ${plural(missing.length, "item")} still need questions (the reply may have been cut off); finish them from the lecture menu.`;
    }
  }
  state.bank = null;
  toast(`${plural(records.length, "question")} added${added < records.length ? ` (${records.length - added} already in your bank)` : ""}.${note}`, { ms: 9000 });
  return records;
}

export async function startPart(scope, n) {
  const key = scope.lectures[0].key;
  const rec = (await getCL())[key];
  const bank = await allQuestions(scope.courseId);
  const earlierParts = rec.parts.filter((p) => p.n < n).map((p) => p.n);
  const list = partSession(bank, { lectureKey: key, part: n, earlierParts });
  if (!list.length) return toast("This part has no questions yet.", { error: true });
  await startSession(list, { mode: "mastery", title: `${rec.lecture.title} · Part ${n}`, versions: bank.filter((q) => q.v === 2 && q.lectureKey === key),
    onDone: () => queueNextPart(scope, n).catch(() => {}) });
}
// When every item of a part has been answered right at least once, the next part's questions join the AI list.
async function queueNextPart(scope, n) {
  const key = scope.lectures[0].key;
  const rec = (await getCL())[key];
  const part = rec?.parts.find((p) => p.n === n), nextPart = rec?.parts.find((p) => p.n === n + 1);
  if (!part || !nextPart || rec.generated?.[n + 1]) return;
  const stats = (await getStats())[key] || {};
  const rule = ruleFor(scope.courseId);
  if (!part.items.every((id) => ["learning", "mastered"].includes(itemLevel(stats[id], rule)))) return;
  if (await addJob({ kind: "part", n: n + 1, courseId: scope.courseId, course: courseName(scope.courseId), lecture: scope.lectures[0] }, { quiet: true }))
    toast(`Part ${n} learned. Part ${n + 1} is in your list for ${ai().name} (Today › For your AI).`, { ms: 7000 });
}

// ---------- 3. assessments ----------
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export async function poolAssessmentStart(scope, { count = 15, timed = false } = {}) {
  const keys = scope.lectures.map((l) => l.key);
  const bank = await allQuestions(scope.courseId);
  const { recentAssess = [] } = await chrome.storage.local.get("recentAssess");
  const list = poolAssessment(bank, { lectureKeys: keys, count, avoid: new Set(recentAssess) });
  if (list.length < 5) return toast("Not enough questions yet. Work through a few lecture parts first, or ask your AI for a fresh assessment.", { error: true, ms: 8000 });
  await chrome.storage.local.set({ recentAssess: [...list.map((q) => q.id), ...recentAssess].slice(0, 200) });
  await startSession(list, { mode: "assessment", title: `${scope.title}: assessment`, timed });
}

export async function freshAssessment(scope, { count = 15 } = {}) {
  const all = await getCL();
  const recs = scope.lectures.map((l) => all[l.key]).filter(Boolean);
  if (!recs.length) throw new Error("Build a checklist for at least one of these lectures first.");
  const multi = recs.length > 1;
  const letters = {};
  const items = [];
  recs.forEach((r, i) => {
    const L = LETTERS[i];
    letters[L] = r.lecture;
    for (const it of allItems(r.cl)) items.push({ ...it, id: multi ? `${L}${it.id}` : it.id, text: multi ? `(${r.lecture.title}) ${it.text}` : it.text });
  });
  const sample = items.sort(() => Math.random() - 0.5).slice(0, Math.min(items.length, Math.round(count * 1.4)));
  const base = { course: courseName(scope.courseId), title: scope.title, items: sample, count, format: QUESTION_FORMAT };
  const fresh = async () => {
    if (recs.length > 1) return { text: assessmentPrompt(base), files: [] };
    const m = await lectureMaterial({ ...scope, lectures: [scope.lectures.find((l) => l.key === recs[0].lecture.key)] });
    return { text: assessmentPrompt({ ...base, attached: m.attached, material: m.material }), files: m.files };
  };
  const opts = { expect: "quiz", title: `${scope.title}: fresh assessment`,
    meta: { v2: true, courseId: scope.courseId, mode: "assessment", lecture: recs[0].lecture, lectures: recs.map((r) => r.lecture), letters: multi ? letters : null, startAfter: true, scopeTitle: scope.title } };
  if (!multi && sameChat(recs[0])) return handToAI(assessmentPrompt({ ...base, inChat: true }), { ...opts, chat: { url: recs[0].chat.url, fallback: fresh } });
  const f = await fresh();
  await handToAI(f.text, { ...opts, files: f.files });
}

// ---------- the lecture menu section ----------
export async function masterySection(scope, { tile, run }) {
  const key = scope.lectures[0].key;
  const rec = (await getCL())[key];
  if (!rec) {
    return h("div", { class: "sheet-sec" }, h("div", { class: "sheet-label" }, "Lecture mastery"),
      h("p", { class: "hint", style: "margin:0 0 8px" }, "Your AI reads the whole lecture once and lists everything to learn, slide by slide. Then you learn it in parts, in order, and test yourself with assessments. Everything after that runs here, with no AI needed."),
      tile("spark", "Build the lecture checklist", "One time per lecture: the file goes to your AI, the checklist comes back here", () => aiAction({ kind: "checklist", courseId: scope.courseId, course: courseName(scope.courseId), lecture: scope.lectures[0] }), { primary: true }));
  }
  if (!rec.lecture.docKey && scope.lectures[0].doc_key) { rec.lecture.docKey = scope.lectures[0].doc_key; await saveCL(key, rec); }
  const stats = (await getStats())[key] || {};
  const rule = ruleFor(scope.courseId);
  const m = lectureMastery(rec.cl, stats, rule);
  const fewer = makeParts(rec.cl).length;
  const canRegroup = fewer < rec.parts.length && (rec.parts.length > 8 || rec.parts.some((p) => p.items.length < PART_MIN));
  const bank = (await allQuestions(scope.courseId)).filter((q) => q.v === 2 && q.lectureKey === key);
  const cov = rec.coverage || { ok: true, missing: [], weak: {} };
  const weakSlides = Object.keys(cov.weak || {}).map(Number);
  const queued = new Set((await getQueue()).map(jobKey));
  const nextToMake = rec.parts.find((p) => !rec.generated?.[p.n]);
  const partRow = (p) => {
    const its = p.items;
    const lv = its.map((id) => itemLevel(stats[id], rule));
    const mastered = lv.filter((x) => x === "mastered").length;
    const gen = rec.generated?.[p.n];
    const has = bank.some((q) => q.part === p.n);
    const learned = lv.every((x) => x === "learning" || x === "mastered") && mastered < its.length;
    const status = !gen && !has ? (queued.has(`part:${key}:${p.n}`) ? "In your AI list" : p === nextToMake ? "Make next" : "Not made yet") : mastered === its.length ? "Mastered"
      : learned ? `Learned · answer again ${rule === "deep" ? "on other days (including a problem to apply it)" : "on another day"} to master${mastered ? ` (${mastered}/${its.length} done)` : ""}`
      : lv.some((x) => x !== "new") ? `${mastered}/${its.length} mastered${lv.includes("review") ? ` · ${lv.filter((x) => x === "review").length} to review` : ""}` : "Ready";
    const range = p.slides ? ` · slides ${p.slides[0]}${p.slides[1] !== p.slides[0] ? `–${p.slides[1]}` : ""}` : "";
    return h("div", { class: "part-row" },
      h("span", { class: `part-n ${mastered === its.length ? "done" : ""}` }, mastered === its.length ? icon("check", 14) : String(p.n)),
      h("span", { class: "grow" }, h("b", {}, p.title), h("small", {}, `${plural(its.length, "item")}${range} · ${status}`),
        gen?.missing?.length ? h("button", { class: "linkish", onclick: run(() => aiAction({ kind: "part", n: p.n, only: gen.missing, courseId: scope.courseId, course: courseName(scope.courseId), lecture: scope.lectures[0] })) }, `Finish ${plural(gen.missing.length, "missing item")}`) : null),
      has && lv.every((x) => x === "new") ? h("button", { class: "btn small soft", title: "A quick check on about half of this part. Every item you get right without help counts as learned; the rest come up when you start the part.", onclick: run(() => testOut(scope, p.n)) }, "I know this") : null,
      has ? h("button", { class: "btn small", onclick: run(() => startPart(scope, p.n)) }, mastered === its.length ? "Review" : lv.some((x) => x !== "new") ? "Continue" : "Start")
        : p === nextToMake || queued.has(`part:${key}:${p.n}`) ? h("button", { class: "btn small soft", title: "Your AI writes this part's questions (they come back here)", onclick: run(() => aiAction({ kind: "part", n: p.n, courseId: scope.courseId, course: courseName(scope.courseId), lecture: scope.lectures[0] })) }, "Make")
        : h("button", { class: "btn small soft", disabled: true, title: "Make the earlier parts first; each one builds on the last" }, "Later"));
  };
  const itemsList = h("details", { class: "topic-more" }, h("summary", {}, `Checklist: ${plural(m.total, "item")}`),
    ...rec.cl.sections.map((s) => h("div", { class: "cl-sec" }, h("b", {}, s.title),
      h("ul", { class: "cl-items" }, s.items.map((it) => {
        const lv = itemLevel(stats[it.id], rule);
        return h("li", { class: `lv-${lv}` }, h("span", { class: "cl-dot", title: LEVEL_LABEL[lv] }), h("span", { class: "grow" }, it.text),
          it.slides.length ? h("small", {}, `slide ${it.slides.join(", ")}`) : null);
      })))));
  return h("div", { class: "sheet-sec" },
    h("div", { class: "sheet-label" }, "Lecture mastery", h("span", {}, `${m.mastered} of ${m.total} items mastered`)),
    h("div", { class: "cov-bar", role: "img", "aria-label": `${m.mastered} of ${m.total} items mastered` }, h("i", { style: `width:${m.total ? Math.round((m.mastered / m.total) * 100) : 0}%` })),
    !cov.ok ? h("div", { class: "note warn" },
      cov.missing.length ? `${cov.missing.length === 1 ? `${cap(rec.unit)} ${cov.missing[0]} isn't` : `${plural(cov.missing.length, rec.unit)} aren't`} in the checklist yet${cov.missing.length > 1 ? `: ${cov.missing.slice(0, 12).join(", ")}${cov.missing.length > 12 ? "…" : ""}` : ""}. ` : "",
      weakSlides.length ? `${plural(weakSlides.length, rec.unit)} may be thin (${weakSlides.slice(0, 8).join(", ")}). ` : "",
      h("button", { class: "linkish", onclick: run(() => aiAction({ kind: "checklist", courseId: scope.courseId, course: courseName(scope.courseId), lecture: scope.lectures[0], fix: { missing: [...cov.missing, ...weakSlides].sort((a, b) => a - b), weak: cov.weak } })) }, "Fill them in"))
      : cov.contentPages ? h("div", { class: "hint" }, `All ${cov.contentPages} content ${rec.unit}s are in the checklist.`) : null,
    canRegroup ? h("div", { class: "note" }, `${plural(rec.parts.length, "part")} is a lot for one lecture. `,
      h("button", { class: "linkish", onclick: run(async () => { await regroupParts(key); toast(`Now ${plural(fewer, "part")}. Your questions and progress stay.`); }) }, `Combine into ${fewer} bigger parts`)) : null,
    h("div", { class: "part-list" }, rec.parts.map(partRow)),
    itemsList,
    h("div", { class: "sheet-label", style: "margin-top:10px" }, "Assessments", h("span", {}, "exam-style, random, freshly worded")),
    tile("timer", "Take an assessment", bank.length >= 5 ? "15 questions from your bank, new versions first; results at the end" : "Unlocks after your first part", () => poolAssessmentStart(scope, { count: 15, timed: false }), { disabled: bank.length < 5 }),
    tile("spark", "Fresh assessment from my AI", "Brand-new questions on a random sample of the lecture", () => freshAssessment(scope, { count: 15 })),
    h("div", { class: "row", style: "margin-top:6px;gap:14px" },
      h("button", { class: "linkish", onclick: run(() => { if (confirm("Rebuild the checklist from scratch in a new chat? Your questions and progress stay, but parts are re-planned.")) return aiAction({ kind: "checklist", courseId: scope.courseId, course: courseName(scope.courseId), lecture: scope.lectures[0] }); }) }, "Rebuild checklist"),
      sameChat(rec) ? h("a", { class: "linkish", href: rec.chat.url, target: "_blank", rel: "noopener", title: `New parts and assessments for this lecture go to this ${ai().name} chat, which already has the file and the checklist.` }, `Open this lecture's ${ai().name} chat`) : null));
}

// Module / course: assessments across lectures that have checklists.
export async function multiSection(scope, { tile }) {
  const all = await getCL();
  const withCL = scope.lectures.filter((l) => all[l.key]);
  if (!withCL.length) return null;
  const stats = await getStats();
  const rows = withCL.map((l) => { const mm = lectureMastery(all[l.key].cl, stats[l.key] || {}, ruleFor(scope.courseId)); return h("div", { class: "topic-row" }, h("span", { class: "grow" }, l.title), h("span", { class: "meter" }, h("i", { style: `width:${mm.total ? Math.round((mm.mastered / mm.total) * 100) : 0}%` })), h("small", {}, `${mm.mastered}/${mm.total}`)); });
  const sub = { ...scope, lectures: withCL };
  return h("div", { class: "sheet-sec" }, h("div", { class: "sheet-label" }, "Lecture mastery", h("span", {}, plural(withCL.length, "lecture"))),
    ...rows,
    tile("timer", "Assessment across these lectures", "20 mixed questions from your banks; results at the end", () => poolAssessmentStart(sub, { count: 20 })),
    tile("spark", "Fresh assessment from my AI", "Brand-new mixed questions across these lectures", () => freshAssessment(sub, { count: 20 })));
}
