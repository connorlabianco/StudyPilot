// Lecture checklist: everything testable in a lecture, slide by slide, made once by the student's AI.
// StudyPilot checks it against the lecture itself (every content slide, key terms), splits it into parts that
// follow the lecture, and tracks mastery per item. Pure functions (tested in Node).
import { repairLatexJson } from "./rich.js";

const KINDS = ["definition", "formula", "assumption", "procedure", "concept", "relationship", "example", "caveat", "notation", "result"];

// ---------- the request ----------
export const CHECKLIST_FORMAT = `Reply with ONLY one code block tagged \`studypilot-checklist\`, written directly in your reply (not in an artifact, canvas or file), in exactly this shape:
\`\`\`studypilot-checklist
{"sections":[
  {"title":"<section name, in lecture order>","items":[
    {"text":"<one testable thing, stated fully and correctly in one or two sentences>","kind":"definition","slides":[3]},
    {"text":"<e.g. the formula, written in LaTeX between dollar signs>","kind":"formula","slides":[4,5]}
  ]}
],
"parts":[{"title":"<short name for a study part>","sections":[1,2]}],
"terms":[{"term":"<a key term>","def":"<what it means, in the lecture's own words, one sentence>","slide":3}],
"skip":[{"slide":1,"why":"title slide"}]}
\`\`\`
"kind" is one of: ${KINDS.join(", ")}.
"slides" are the slide or page numbers (as numbered in the file) where the item is taught.
"parts" groups the sections (numbered 1, 2, 3… in the order you listed them) into study parts. A part is what a student can learn well in one short sitting, about 10 to 15 minutes: keep related sections together and let small neighboring sections share a part. Every section is in exactly one part, in order. A typical lecture has 4 to 8 parts.
"terms" lists the lecture's key terms (the vocabulary a student must know), each with a one-sentence definition as this lecture uses it.
Math in LaTeX between dollar signs; inside the JSON, double every backslash (\\\\frac).`;

/**
 * entries: lecture entries as built by the side panel (doc, attachName…). pageCount: slides in the file (if known).
 * time: true for a recording transcript (items use "time":"mm:ss" instead of slides).
 */
export function checklistPrompt({ course, title, material, attached = [], pageCount = 0, unit = "slide" }) {
  return `# Lecture checklist: ${title}${course ? ` (${course})` : ""}

I'm studying this lecture and want to be able to do any homework or exam problem on it from my own understanding. Go through the ${attached.length ? `attached file${attached.length > 1 ? "s" : ""} (${attached.map((n) => `"${n}"`).join(", ")})` : "material below"} ${unit} by ${unit}${pageCount ? ` (all ${pageCount} ${unit}s)` : ""} and list EVERYTHING testable, in lecture order:
- every definition, formula and piece of notation;
- every assumption, condition or requirement (when a method applies, and when it doesn't);
- every step of every method or procedure, as separate items;
- every concept, relationship or comparison ("X vs Y", "if A increases, B…");
- every worked example (what it shows), result, and caveat or common mistake the lecture mentions.
Make items small: one idea each. A 30-slide lecture usually has 60 to 120 items. Group them into sections that follow the lecture.
${unit === "cell" ? `This lecture is a Jupyter notebook. Its cells are marked "--- Cell N ---"; use those numbers in "slides". Code is part of what to learn: list the functions and methods it uses, their important arguments, what each step returns, and how to read the outputs. The data files it reads are described at the end; use them to understand the outputs.
` : ""}Every ${unit} with content must appear in some item's "slides". Put ${unit}s with nothing to learn (title, outline, references, blank) in "skip" with a short reason. Don't leave any ${unit} out silently.
Only list what this lecture actually teaches. Don't add outside material.

${CHECKLIST_FORMAT}${material ? `\n\n## Material\n${material}` : ""}`;
}

// Missing slides → ask for just those.
export function checklistFixPrompt({ title, slides, terms = {}, unit = "slide", attached = [], inChat = false }) {
  return `# Lecture checklist: ${title}, missing ${unit}s

Some ${unit}s of ${inChat ? "the lecture file I sent earlier in this chat" : attached.length ? `the attached file${attached.length > 1 ? "s" : ""}` : "the lecture"} aren't in your checklist yet: ${unit}s ${slides.join(", ")}.
${Object.keys(terms).length ? `These terms from those ${unit}s aren't covered by any item:\n${Object.entries(terms).map(([s, t]) => `- ${unit} ${s}: ${t.join(", ")}`).join("\n")}\n` : ""}
List every testable item on those ${unit}s only (same rules: one idea per item, every definition, formula, assumption, step, concept, example and caveat). If a ${unit} truly has nothing to learn, put it in "skip".

${CHECKLIST_FORMAT}`;
}

// ---------- reading the reply ----------
function blockJson(text, tag) {
  const t = String(text);
  const at = t.indexOf("```" + tag);
  const cands = [];
  if (at >= 0) {
    const rest = t.slice(at + tag.length + 3);
    const end = rest.lastIndexOf("```");
    cands.push(end >= 0 ? rest.slice(0, end) : rest);
  }
  cands.push(t);
  for (const raw of cands) {
    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s < 0 || e < s) continue;
    const body = raw.slice(s, e + 1);
    for (const c of [repairLatexJson(body), body]) { try { return JSON.parse(c); } catch { /* next */ } }
  }
  return null;
}

const nums = (v) => [].concat(v ?? []).map((x) => (typeof x === "string" && /^\d+\s*[-–]\s*\d+$/.test(x) ? (() => { const [a, b] = x.split(/[-–]/).map(Number); return Array.from({ length: Math.min(30, b - a + 1) }, (_, i) => a + i); })() : Number(String(x).replace(/[^\d]/g, "")))).flat().filter((n) => Number.isFinite(n) && n > 0);

/** Returns { sections:[{ title, items:[{ id, text, kind, slides, time }] }], skip:[{ slide, why }] } with ids "1.1", "1.2", … */
export function parseChecklist(text) {
  const obj = blockJson(text, "studypilot-checklist");
  if (!obj || !Array.isArray(obj.sections)) throw new Error("StudyPilot couldn't find the checklist in that reply. Copy the AI's whole answer, including the block that starts with ```studypilot-checklist.");
  return normalizeChecklist(obj);
}
export function normalizeChecklist(obj, { startSection = 1 } = {}) {
  const sections = [];
  obj.sections.forEach((s) => {
    const items = (s.items || []).map((it) => ({
      text: String(it.text || it.item || "").trim().slice(0, 600),
      kind: KINDS.includes(String(it.kind).toLowerCase()) ? String(it.kind).toLowerCase() : "concept",
      slides: nums(it.slides ?? it.slide ?? it.pages),
      time: it.time ? String(it.time).trim() : null,
    })).filter((it) => it.text && !/^<[^>]*>$/.test(it.text));
    if (items.length) sections.push({ title: String(s.title || `Section ${sections.length + 1}`).trim().slice(0, 120), items });
  });
  sections.forEach((s, i) => s.items.forEach((it, j) => (it.id = `${i + startSection}.${j + 1}`)));
  const skip = (obj.skip || []).map((x) => ({ slide: nums(x.slide ?? x.slides)[0], why: String(x.why || x.reason || "").slice(0, 80) })).filter((x) => x.slide);
  if (!sections.length && !(obj.terms || []).length) throw new Error("The checklist reply had no items. Ask your AI to follow the format exactly.");
  // The AI's grouping of sections into study parts (section numbers as listed, 1-based). Checked in makeParts.
  const partPlan = Array.isArray(obj.parts) ? obj.parts.map((p) => ({ title: String(p.title || "").trim().slice(0, 80), sections: nums(p.sections) })).filter((p) => p.sections.length) : null;
  const terms = Array.isArray(obj.terms) ? obj.terms.map((t) => ({ term: String(t.term || "").trim().slice(0, 120), def: String(t.def || t.definition || "").trim().slice(0, 400), slide: nums(t.slide ?? t.slides)[0] || null }))
    .filter((t) => t.term && t.def && !/^<[^>]*>$/.test(t.term)) : [];
  return { sections, skip, partPlan: partPlan?.length ? partPlan : null, terms };
}

// Adds a "fill in" reply to an existing checklist (new section(s) at the end, numbered after the existing ones).
// keepOrder: when parts were already made, new sections go at the end so existing parts don't shift.
export function mergeChecklist(base, add, { keepOrder = false } = {}) {
  const start = Math.max(0, ...base.sections.flatMap((s) => s.items.map((it) => Number(it.id.split(".")[0])))) + 1;
  const extra = normalizeChecklist({ sections: add.sections.map((s) => ({ ...s, items: s.items })), skip: add.skip }, { startSection: start });
  const skip = [...base.skip];
  for (const x of extra.skip) if (!skip.some((y) => y.slide === x.slide)) skip.push(x);
  // Keep lecture order (sorted by first slide) so parts follow the lecture. Item ids never change.
  const first = (sec) => Math.min(...sec.items.flatMap((it) => it.slides), 9999);
  const sections = keepOrder ? [...base.sections, ...extra.sections] : [...base.sections, ...extra.sections].sort((a, b) => first(a) - first(b));
  const terms = [...(base.terms || [])];
  for (const t of extra.terms || []) if (!terms.some((x) => x.term.toLowerCase() === t.term.toLowerCase())) terms.push(t);
  return { ...base, sections, skip, terms };
}

export const allItems = (cl) => (cl?.sections || []).flatMap((s) => s.items.map((it) => ({ ...it, section: s.title })));

// ---------- checking it against the lecture ----------
const STOP = new Set(("the and for with from that this into over under then than when what which where while your their there these those have been being were will would should could about above below between after before also only each more most other some such very using used use " +
  "example examples slide page lecture chapter section part note notes figure table continued cont review recall today topic topics overview introduction intro summary " +
  "common mistake mistakes basics basic key idea ideas question questions problem problems week class course part").split(" "));
const words = (s) => (String(s).toLowerCase().replace(/\$[^$]*\$/g, " ").match(/[a-z][a-z-]{3,}/g) || []).filter((w) => !STOP.has(w));
// "randomize", "randomization" and "randomized" all become "random".
const stem = (w) => w.replace(/(izations?|isations?|ations?|izing|ising|ized|ised|izes|ises|ize|ise|ions?|ments?|ness|ities|ity|ies|ing|ed|es|s|ly|al)$/, "").slice(0, 7);

/**
 * pages: [{ n, text, chars }] from StudyPilot's own reading of the file (may be empty for handwritten slides).
 * Returns { contentPages, covered, missing:[n], weak:{ n: [terms] }, ok }
 */
export function checkCoverage(cl, { pageCount = 0, pages = [] } = {}) {
  const items = allItems(cl);
  const mentioned = new Set(items.flatMap((it) => it.slides));
  const skipped = new Set(cl.skip.map((x) => x.slide));
  const total = pageCount || Math.max(0, ...pages.map((p) => p.n), ...mentioned);
  // A page with real text counts as content; with no text at all (handwriting, images) we can't tell, so it counts too.
  const contentPages = [];
  for (let n = 1; n <= total; n++) {
    const p = pages.find((x) => x.n === n);
    const chars = p ? (p.text || "").replace(/\s/g, "").length : null;
    if (p && chars > 0 && chars < 25 && !mentioned.has(n)) continue; // just a page number / header
    contentPages.push(n);
  }
  const missing = contentPages.filter((n) => !mentioned.has(n) && !skipped.has(n));
  // Key terms: the page's title line and repeated words. Covered if any item on that page (or next to it) uses them.
  const weak = {};
  for (const p of pages) {
    if (!p.text || skipped.has(p.n) || missing.includes(p.n)) continue;
    const lines = p.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
    const title = lines[0] || "";
    const counts = {};
    words(p.text).forEach((w) => { const k = stem(w); counts[k] = (counts[k] || 0) + 1; });
    const keyTerms = [...new Set([...words(title).map(stem), ...Object.entries(counts).filter(([, c]) => c >= 3).map(([k]) => k)])].slice(0, 8);
    if (!keyTerms.length) continue;
    const near = items.filter((it) => it.slides.some((s) => Math.abs(s - p.n) <= 1)).map((it) => it.text).join(" ");
    const have = new Set(words(near).map(stem));
    const lost = keyTerms.filter((k) => !have.has(k));
    // Only flag a slide when several of its key terms appear in no item at all (wording differences are fine).
    if (lost.length >= 2 && lost.length / keyTerms.length >= 0.6) weak[p.n] = lost.slice(0, 5);
  }
  return { total, contentPages: contentPages.length, covered: contentPages.length - missing.length, missing, weak, ok: !missing.length && !Object.keys(weak).length };
}

// ---------- parts (sequential mastery) ----------
// Follows the lecture: sections stay together when they fit; big sections split; tiny ones join the next.
// Parts: the AI's own grouping when it gave one (it knows what belongs together), then evened out so no part is
// tiny or huge. Without a grouping, sections are combined in lecture order.
export const PART_MIN = 6, PART_MAX = 16;
export function makeParts(cl, { min = PART_MIN, max = PART_MAX } = {}) {
  const secs = cl.sections;
  let parts = [];
  const plan = cl.partPlan;
  const planOk = plan && plan.flatMap((p) => p.sections).join() === secs.map((_, i) => i + 1).join();
  if (planOk) parts = plan.map((p) => ({ title: p.title || p.sections.map((n) => secs[n - 1].title).join(" · "), items: p.sections.flatMap((n) => secs[n - 1].items.map((x) => x.id)), secTitles: p.sections.map((n) => secs[n - 1].title) }));
  else {
    let cur = null;
    for (const sec of secs) {
      if (cur && cur.items.length + sec.items.length > max) { parts.push(cur); cur = null; }
      if (!cur) cur = { title: sec.title, items: [], secTitles: [] };
      else cur.title = `${cur.title} · ${sec.title}`;
      cur.items.push(...sec.items.map((x) => x.id)); cur.secTitles.push(sec.title);
      if (cur.items.length >= Math.round((min + max) / 2)) { parts.push(cur); cur = null; }
    }
    if (cur) parts.push(cur);
  }
  // Split huge parts into even chunks.
  parts = parts.flatMap((p) => {
    if (p.items.length <= max) return [p];
    const n = Math.ceil(p.items.length / max), per = Math.ceil(p.items.length / n);
    return Array.from({ length: n }, (_, i) => ({ title: `${p.title} (${i + 1} of ${n})`, items: p.items.slice(i * per, (i + 1) * per) }));
  });
  // Merge tiny parts into a neighbor (the next one, or the previous one at the end) when that stays within bounds.
  for (let i = 0; i < parts.length && parts.length > 1;) {
    const p = parts[i];
    if (p.items.length >= min) { i++; continue; }
    const j = i + 1 < parts.length ? i + 1 : i - 1;
    if (parts[j].items.length + p.items.length > max + Math.ceil(min / 2)) { i++; continue; }
    const [a, b] = j > i ? [p, parts[j]] : [parts[j], p];
    parts.splice(Math.min(i, j), 2, { title: `${a.title} · ${b.title}`, items: [...a.items, ...b.items] });
    i = Math.max(0, Math.min(i, j));
  }
  const byId = new Map(allItems(cl).map((it) => [it.id, it]));
  return parts.map((p, i) => {
    const slides = p.items.flatMap((id) => byId.get(id)?.slides || []);
    return { n: i + 1, title: p.title.length > 70 ? p.title.slice(0, 68) + "…" : p.title, items: p.items,
      slides: slides.length ? [Math.min(...slides), Math.max(...slides)] : null };
  });
}

// ---------- mastery per item ----------
// stats[itemId] = [{ at, qid, ok, help }] (latest last). Mastered = right without help on two different days,
// on two different questions (versions count), and not wrong since.
const dayOf = (t) => new Date(t).toDateString();
// What "mastered" means is set per course:
//   quick: right once without help · solid (default): right without help on 2 different days, 2 different questions
//   deep: right without help on 3 different days, 3 different questions, at least one of them an "apply" question
export const MASTERY_RULES = {
  quick: { days: 1, qs: 1, apply: false },
  solid: { days: 2, qs: 2, apply: false },
  deep: { days: 3, qs: 3, apply: true },
};
export function itemLevel(hist = [], rule = "solid") {
  if (!hist.length) return "new";
  const last = hist[hist.length - 1];
  if (!last.ok) return "review";
  const r = MASTERY_RULES[rule] || MASTERY_RULES.solid;
  const clean = hist.filter((h) => h.ok && !h.help);
  const days = new Set(clean.map((h) => dayOf(h.at)));
  const qs = new Set(clean.map((h) => h.qid));
  const applied = !r.apply || clean.some((h) => h.lv === "apply");
  return clean.length && days.size >= r.days && qs.size >= r.qs && applied ? "mastered" : "learning";
}
export const LEVEL_LABEL = { new: "Not started", learning: "Learning", review: "Needs review", mastered: "Mastered" };

export function lectureMastery(cl, stats = {}, rule = "solid") {
  const items = allItems(cl);
  const levels = items.map((it) => itemLevel(stats[it.id], rule));
  const count = (l) => levels.filter((x) => x === l).length;
  return { total: items.length, mastered: count("mastered"), learning: count("learning"), review: count("review"), fresh: count("new") };
}

export function recordItems(stats = {}, itemIds = [], { qid, ok, help = false, at = Date.now(), lv = null }) {
  const out = { ...stats };
  for (const id of itemIds) out[id] = [...(out[id] || []), { at, qid, ok: !!ok, help: !!help, ...(lv ? { lv } : {}) }].slice(-12);
  return out;
}

// ---------- question requests ----------
const fmtItems = (list) => list.map((it) => `- [${it.id}] ${it.text}${it.slides?.length ? ` (slide ${it.slides.join(", ")})` : it.time ? ` (at ${it.time})` : ""}`).join("\n");

export function partPrompt({ course, title, cl, part, partsTotal, earlier = [], attached = [], material = "", format, inChat = false, whole = false, notebook = false }) {
  const byId = new Map(allItems(cl).map((it) => [it.id, it]));
  const items = part.items.map((id) => byId.get(id)).filter(Boolean);
  const procedures = items.filter((it) => it.kind === "procedure" || it.kind === "formula").length;
  return `# ${title}: Part ${part.n} of ${partsTotal}${course ? ` (${course})` : ""}

I'm learning this lecture in order. Write practice questions for Part ${part.n}, "${part.title}", from ${inChat ? "the lecture file I sent earlier in this chat (the one your checklist came from)" : attached.length ? `the attached lecture (${attached.map((n) => `"${n}"`).join(", ")})` : "the lecture material below"}.

## Items in this part (every one must be tested)
${fmtItems(items)}
${earlier.length ? `\n## Earlier items to mix in (2 or 3 questions total, applying them in new situations)\n${fmtItems(earlier)}\n` : ""}
## What I need
- At least 2 questions for EVERY item above, in different formats, plus a few that combine items.
- Mix of levels: about 25% recall, 35% understanding (why, compare, what if), 40% applying it to a new situation or problem.
- Make each question test the idea, not the slide's wording: new examples, new numbers, new contexts. Wrong options should be mistakes a student could really make, with a reason each one is wrong.
${notebook ? "- This lecture is a Jupyter notebook (\"slide\" means cell number). For code, ask questions StudyPilot can grade without running anything: what a line returns or prints, which function or argument does a job, putting the lines of a pipeline in order, spotting the bug, and calculations behind the code. Use the notebook's own libraries and style. When a question needs data, put a small made-up table (4 to 8 rows) in the question, shaped like the lecture's data (same kinds of columns), and ask about that table.\n" : ""}${procedures ? "- For each method, procedure or formula: one \"steps\" problem (with a worked example first), and calculation questions as \"numeric\" with a \"recipe\" so I get fresh numbers each time.\n- Do every method exactly the way this lecture does it: the same notation and symbols, the same formulas, and the same steps in the same order as the slides. No textbook shortcuts or alternative methods the lecture doesn't use. The worked example should look like the lecture's own example, with different numbers and a different situation.\n" : ""}- Write 2 differently worded versions of each question (same "group", different wording or numbers), so I can't just memorize answers.
- Tag every question with the item ids it tests and the slide it comes from.

${format}${whole ? `\n\n## The whole lecture checklist (for context; only Part ${part.n} is needed now)\n${cl.sections.map((sec) => `### ${sec.title}\n${fmtItems(sec.items)}`).join("\n")}` : ""}${material ? `\n\n## Lecture material\n${material}` : ""}`;
}

export function assessmentPrompt({ course, title, items, count = 15, attached = [], material = "", format, inChat = false }) {
  return `# Assessment: ${title}${course ? ` (${course})` : ""}

Write a ${count}-question exam-style assessment on ${inChat ? "the lecture file I sent earlier in this chat" : attached.length ? `the attached lecture${attached.length > 1 ? "s" : ""}` : "the material below"}, like a real exam would ask: mostly applying ideas to new problems and situations, some "which method fits?" and "why" questions, a few recall. Word everything freshly; don't copy the slides' phrasing. Use these items (they're a random sample, not everything):
${fmtItems(items)}

One version per question (no "group" needed). Tag each question with the item ids it tests and the slide.

${format}${material ? `\n\n## Lecture material\n${material}` : ""}`;
}

// Key terms for a checklist made before terms were part of it (sent to the lecture's own chat when there is one).
export function termsPrompt({ title, inChat = false, attached = [], material = "" }) {
  return `# Key terms: ${title}

List the key terms of ${inChat ? "the lecture file I sent earlier in this chat" : attached.length ? "the attached lecture" : "the lecture below"}: the vocabulary a student must know, each with a one-sentence definition as this lecture uses it, and the slide where it's introduced. Only terms this lecture actually uses.

Reply with ONLY one code block tagged \`studypilot-checklist\`, written directly in your reply (not in an artifact, canvas or file), in exactly this shape:
\`\`\`studypilot-checklist
{"sections":[],"terms":[{"term":"<a key term>","def":"<what it means here, one sentence>","slide":3}]}
\`\`\`
Math in LaTeX between dollar signs; inside the JSON, double every backslash (\\\\frac).${material ? `\n\n## Lecture material\n${material}` : ""}`;
}
