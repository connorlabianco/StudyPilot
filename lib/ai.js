import { repairLatexJson } from "./rich.js";
import { topicsFromReply } from "./topics.js";
// "Your AI": StudyPilot works with any chat assistant by copy and paste.
// It copies a request, opens the student's AI, and reads the reply back (a fenced block StudyPilot can parse).
import { QUIZ_RULES, fileGuide } from "./packs.js";

export const PROVIDERS = {
  claude: { name: "Claude", url: "https://claude.ai/new" },
  chatgpt: { name: "ChatGPT", url: "https://chatgpt.com/" },
  gemini: { name: "Gemini", url: "https://gemini.google.com/app" },
  copilot: { name: "Copilot", url: "https://copilot.microsoft.com/" },
  other: { name: "My AI", url: "" },
  none: { name: "No AI", url: "" },
};

export function providerOf(settings) {
  const id = settings.aiProvider || "chatgpt";
  const p = PROVIDERS[id] || PROVIDERS.chatgpt;
  if (id === "other") return { id, name: settings.aiName || "My AI", url: settings.aiUrl || "" };
  return { id, ...p };
}

// ---------- Question requests ----------
// Every reply ends with a studypilot-quiz block so questions land in the in-app question bank.
const QUIZ_FORMAT = `Reply with ONLY one code block tagged \`studypilot-quiz\` containing JSON in exactly this shape (no other text):
\`\`\`studypilot-quiz
{"topics":[{"name":"<topic>","lecture":"<lecture title>"}, "...every main topic in the material, 4 to 15 of them"],
"questions":[
  {"type":"mcq","topic":"<one of the topic names>","lecture":"<lecture title it comes from>","question":"<question>","options":["<A>","<B>","<C>","<D>"],"answer":0,"explanation":"<why, from the material>"},
  {"type":"tf","topic":"<short topic>","lecture":"<lecture title>","question":"<statement>","answer":true,"explanation":"<why>"},
  {"type":"short","topic":"<short topic>","lecture":"<lecture title>","question":"<question>","answer":"<model answer, 1–3 sentences>","explanation":"<what a full answer covers>"}
]}
\`\`\`
"topics" lists EVERY main topic in the material, even ones with no question this time; each question's "topic" is one of those names, written the same way.
"answer" is the index of the correct option for "mcq", true/false for "tf", and the model answer text for "short".
Math: write it in LaTeX between dollar signs, like $\\frac{a}{b}$ inline or $$\\sum_{i=1}^n x_i$$ on its own line. Inside the JSON, double every backslash (\\\\frac, \\\\beta).
Code: put code in a block fenced with ~~~ (not backticks), like "~~~python\\nprint(x)\\n~~~", and short code like \`x[0]\` in single backticks.
Don't use "All of the above" or "None of the above"; options get shuffled.`;

const COVERAGE = QUIZ_RULES.split("\n").filter((l) => /^[1-4]\./.test(l.trim())).join("\n")
  .replace(/Show me just the topic list[^.]*\./, "").replace("silently make", "make");

/**
 * entries: [{ doc, attachName?, imageNames?, inline? , error? }] (same shape the lecture bundle uses)
 * Returns the request text for the student's AI.
 */
export function questionsPrompt({ course, title, entries, count = 10, difficulty = "mixed", types = "mixed", focus = [] }) {
  const attached = entries.flatMap((e) => [e.attachName, ...(e.imageNames || [])]).filter(Boolean);
  const typeLine = types === "mcq" ? "All multiple choice." : types === "short" ? "Mostly short answer, a few multiple choice." : "About 70% multiple choice, 15% true/false, 15% short answer.";
  const material = entries.map((e) => {
    const d = e.doc || {};
    if (e.error) return `### ${e.title || "Item"}\n_(couldn't be read)_`;
    if (d.kind === "page") return `### ${d.title} (Canvas page)\n${d.text || ""}`;
    const text = d.analysis?.text || "";
    if (e.attachName) {
      const a = d.analysis || {};
      const n = a.pageCount ? ` (${a.pageCount} ${String(a.unit || "page").toLowerCase()}s)` : "";
      if (a.needsFile || a.scanned) return `### ${d.title}: attached as "${e.attachName}"${n}\nThis lecture is handwritten, scanned or made of images, so there's no typed text to copy here. Open the attached file and read every page; it is the whole material.`;
      return `### ${d.title}: attached as "${e.attachName}"\n${fileGuide(d)}`;
    }
    return `### ${d.title}\n${fileGuide(d, { attached: false })}\n\n${text.slice(0, 120000)}`;
  }).join("\n\n");
  return `# Practice questions: ${title}${course ? ` (${course})` : ""}

Write ${count} ${difficulty}-difficulty practice questions from the material below, to study for this course. ${typeLine}
${focus.length ? `\nFocus on these topics, which I haven't practiced yet (use these exact names as each question's "topic"):\n${focus.map((t) => `- ${t}`).join("\n")}\n` : ""}
${COVERAGE}
${attached.length ? `\nThe attached files (${attached.map((n) => `"${n}"`).join(", ")}) are the main source. Use every page, including diagrams and handwritten pages, and describe any figure in words inside the question.\n` : ""}
${QUIZ_FORMAT}

## Material
${material}`;
}

// Graded work (Gradescope graded copies) → practice on the ideas behind the points that were lost.
export function mistakesPrompt({ course, items, count = 10 }) {
  const list = items.map((it) => `- "${it.attachName}": ${it.name}${it.score ? ` (score ${it.score})` : ""}`).join("\n");
  return `# Learn from my graded work${course ? ` (${course})` : ""}

Attached ${items.length === 1 ? "is a graded copy" : "are graded copies"} of my work, with the grader's marks, rubric items and comments:
${list}

1. Read every page. Find each place I lost points and what the grader said.
2. Briefly list what went wrong in each (the concept or step, not just "wrong answer").
3. Then write ${count} NEW practice questions that target exactly those weak spots. Don't reuse the original problems or their numbers; use fresh examples that need the same idea. Put the most practice on the biggest point losses. Each "explanation" should name the mistake it's practicing ("You lost points on Q3 for not checking the assumptions; ...").

Use the topic names from the course material for "topic" (like "Two-way ANOVA" or "Blocking"), so they line up with my lectures.

${QUIZ_FORMAT}`;
}

// Notebooks → questions
export function notebookQuestionsPrompt({ title, docs, count = 10, difficulty = "mixed" }) {
  return `# Practice questions: ${title}

Write ${count} ${difficulty}-difficulty practice questions from these course notebooks. Mix concept questions with "what does this code do / what would it output" questions, always including the code in the question.

${COVERAGE}

${QUIZ_FORMAT}

## Notebooks
${docs.map((d) => `### ${d.path}\n${d.text}`).join("\n\n---\n\n")}`;
}

// ---------- Reading the reply back ----------
export function findReplyBlock(text) {
  const t = String(text || "");
  if (/```\s*studypilot-weights/.test(t) || /"weights"\s*:\s*\[/.test(t)) return "weights";
  if (/```\s*studypilot-quiz/.test(t) || /"questions"\s*:\s*\[/.test(t)) return "quiz";
  if (/```\s*studypilot-plan/.test(t) || /"sessions"\s*:\s*\[/.test(t)) return "plan";
  return null;
}

function jsonIn(text, tag) {
  const t = String(text);
  const blocks = [...t.matchAll(/```([\w-]*)\s*([\s\S]*?)```/g)];
  const ordered = [...blocks.filter((b) => b[1] === tag), ...blocks.filter((b) => b[1] !== tag)].map((b) => b[2]);
  // Code inside the questions can contain ``` too, which ends the block early; also try "from the tag to the last ```".
  const at = t.indexOf("```" + tag);
  if (at >= 0) ordered.unshift(t.slice(at + tag.length + 3, t.lastIndexOf("```") > at ? t.lastIndexOf("```") : undefined));
  ordered.push(t);
  for (const raw of ordered) {
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start < 0 || end < start) continue;
    const body = raw.slice(start, end + 1);
    // LaTeX with single backslashes (\frac) would be silently mangled by JSON (\f is a form feed), so repair first.
    for (const cand of [repairLatexJson(body), body]) {
      try { return JSON.parse(cand); } catch { /* try next */ }
    }
  }
  return null;
}

// Validates and normalizes questions from an AI reply. Throws a friendly error if nothing usable is found.
export function parseQuizReply(text) {
  const obj = jsonIn(text, "studypilot-quiz");
  const list = Array.isArray(obj?.questions) ? obj.questions : Array.isArray(obj) ? obj : null;
  if (!list) throw new Error("StudyPilot couldn't find questions in that reply. Copy the AI's whole answer, including the block that starts with ```studypilot-quiz.");
  const out = [];
  for (const q of list) {
    const type = String(q.type || "").toLowerCase();
    const question = String(q.question || q.prompt || "").trim();
    if (!question) continue;
    const base = { prompt: question, topic: String(q.topic || "").trim().slice(0, 60), lecture: String(q.lecture || "").trim(), explanation: String(q.explanation || "").trim() };
    if (type === "mcq" || (Array.isArray(q.options) && q.options.length >= 2)) {
      const options = (q.options || []).map((o) => String(o).trim()).filter(Boolean).slice(0, 6);
      let answer = typeof q.answer === "number" ? q.answer : options.findIndex((o) => o.toLowerCase() === String(q.answer).toLowerCase());
      if (/^[A-F]$/i.test(String(q.answer))) answer = String(q.answer).toUpperCase().charCodeAt(0) - 65;
      if (options.length < 2 || answer < 0 || answer >= options.length) continue;
      out.push({ ...base, type: "mcq", options, answer });
    } else if (type === "tf" || typeof q.answer === "boolean") {
      const answer = typeof q.answer === "boolean" ? q.answer : /^(true|t|yes)$/i.test(String(q.answer));
      out.push({ ...base, type: "tf", answer });
    } else if (q.answer != null && String(q.answer).trim()) {
      out.push({ ...base, type: "short", answer: String(q.answer).trim() });
    }
  }
  if (!out.length) throw new Error("The reply had a questions block, but none of the questions were complete. Ask your AI to follow the format exactly.");
  out.topics = topicsFromReply(obj);
  return out;
}

// ---------- Grade weights from a syllabus ----------
export function weightsPrompt({ course, texts = [], attached = [] }) {
  return `# Grading breakdown: ${course}

Find how the final grade is weighted in this course's syllabus${attached.length ? ` (attached: ${attached.map((n) => `"${n}"`).join(", ")})` : ""}.
List each graded category and its percentage of the final grade, exactly as the syllabus says. If there are several options (for example "the final can replace the midterm"), use the default scheme and mention the others in "note". Ignore late penalties, letter-grade cutoffs and extra credit.

Reply with ONLY one code block tagged \`studypilot-weights\` in exactly this shape:
\`\`\`studypilot-weights
{"weights":[{"name":"Homework","weight":30},{"name":"Midterm","weight":30},{"name":"Final project","weight":40}],"note":""}
\`\`\`
${texts.map((t) => `\n## ${t.name}\n${t.text}`).join("\n")}`;
}

export function parseWeightsReply(text) {
  const obj = jsonIn(text, "studypilot-weights");
  const list = (obj?.weights || []).map((w) => ({ name: String(w.name || "").trim().slice(0, 60), weight: Number(String(w.weight).replace("%", "")) }))
    .filter((w) => w.name && w.weight > 0 && w.weight <= 100);
  if (!list.length) throw new Error("Couldn't find weights in that reply. Copy the AI's whole answer, including the studypilot-weights block.");
  return { weights: list, note: String(obj?.note || "") };
}
