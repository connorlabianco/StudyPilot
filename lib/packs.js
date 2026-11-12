// Builds ready-to-paste Markdown "packs" for any AI assistant. Pure functions (no chrome.* APIs) so they're testable in Node.

const fmt = (iso, tz) => iso ? new Date(iso).toLocaleString("en-US", {
  timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
}) : "no due date";

const DAY = 864e5;

// Open work: unsubmitted, has a due date, not more than a week overdue, within `daysAhead`.
export function openWork(snapshot, { now = Date.now(), daysAhead = 60 } = {}) {
  return snapshot.courses
    .flatMap((c) => c.assignments
      .filter((a) => a.due_at && !a.submitted)
      .map((a) => {
        const overdue = Date.parse(a.due_at) < now;
        // Work turned in on an outside site (Gradescope, etc.) often shows no Canvas submission until it's graded,
        // so past-due tool work is "turned in there?" rather than overdue.
        // Same for "no submission / on paper" work: Canvas can't know whether it was handed in.
        const elsewhere = overdue && (a.kind === "tool" || a.kind === "offline");
        return { ...a, course: c.code || c.name, course_id: c.id, overdue: overdue && !elsewhere, elsewhere };
      }))
    .filter((a) => Date.parse(a.due_at) > now - 7 * DAY && Date.parse(a.due_at) < now + daysAhead * DAY)
    .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
}

const cell = (s) => String(s ?? "").replace(/\|/g, "/").replace(/\n/g, " ");

export function deadlinesTable(snapshot, { tz, now = Date.now(), daysAhead = 60 } = {}) {
  const rows = openWork(snapshot, { now, daysAhead });
  if (!rows.length) return "_No open assignments in this window._";
  return [
    "| Due | Course | Assignment | Points | Kind | Status |",
    "|---|---|---|---|---|---|",
    ...rows.map((a) => `| ${fmt(a.due_at, tz)} | ${cell(a.course)} | ${cell(a.name)} | ${a.points ?? ""} | ${cell(a.kind_label || (a.is_quiz ? "quiz/test" : "assignment"))} | ${a.overdue ? "**OVERDUE**" : a.elsewhere ? `past due (check ${a.kind_label?.replace(/^submitted on /, "") || "the outside site"})` : a.missing ? "missing" : "open"} |`),
  ].join("\n");
}

function gradesLine(snapshot) {
  return snapshot.courses.map((c) => {
    const anyGraded = (c.assignments || []).some((a) => a.graded);
    const g = c.current_score != null && (anyGraded || c.current_score > 0)
      ? `${c.current_score}%${c.current_grade ? ` (${c.current_grade})` : ""}` : "no graded work yet";
    return `- ${c.code || c.name}: ${g}`;
  }).join("\n");
}

// What each open item asks for, so the AI can judge effort without opening any links.
function detailsSection(snapshot, { tz, now, daysAhead, materials = {} }) {
  const rows = openWork(snapshot, { now, daysAhead });
  if (!rows.length) return "";
  const lang = (name) => (name.match(/\.(\w+)$/)?.[1] || "").toLowerCase().replace(/^(qmd|rmd)$/, "markdown").replace(/^(pdf|docx|pptx|txt)$/, "");
  return "## What each assignment involves\n_From the assignment pages in Canvas, including the text of the files they link to (problem sets, lab instructions, data). You can't open Canvas links, so everything useful is copied here; any PDFs are also attached._\n\n" + rows.map((a) => {
    const info = a.details?.trim() ? a.details.trim() : a.kind === "quiz" ? "_Quiz or test: StudyPilot doesn't open these, so plan review time based on the course material._"
      : a.kind === "tool" ? `_No instructions in Canvas; the work happens on ${a.kind_label.replace("submitted on ", "")}._` : "_No instructions written in Canvas._";
    const files = (materials[`${a.course_id}:${a.id}`]?.files || []).map((f) => f.text
      ? `#### File: ${f.name}\n\`\`\`${lang(f.name)}\n${f.text}\n\`\`\``
      : `#### File: ${f.name}\n_${f.skipped ? `Not readable (${f.skipped}).` : f.note ? `Not included as text (${f.note}).` : "Not included."}_`).join("\n\n");
    return `### ${a.name} (${a.course})\nDue ${fmt(a.due_at, tz)} · ${a.points ?? "?"} pts · ${a.kind_label || "assignment"}\n${info}${files ? `\n\n${files}` : ""}`;
  }).join("\n\n");
}

function busySection(busy, tz) {
  if (!busy?.length) return "";
  const day = (iso) => new Date(iso).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
  const time = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const byDay = new Map();
  for (const b of busy.slice(0, 300)) {
    const k = day(b.start);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(`${time(b.start)}–${time(b.end)}`);
  }
  return "## My busy times (from my calendar)\n" + [...byDay].map(([d, list]) => `- ${d}: ${list.join(", ")}`).join("\n");
}

export const PLAN_FORMAT = `At the very end, after the table, add the same sessions in a code block tagged \`studypilot-plan\` so my StudyPilot extension can put them on my calendar:
\`\`\`studypilot-plan
{"sessions":[{"title":"<course> — <task>","course":"<course>","start":"<start, ISO 8601 with offset>","end":"<end, ISO 8601 with offset>","goal":"<what to finish>"}]}
\`\`\`
Use ISO 8601 times with my UTC offset.`;

export function planPack(snapshot, prefs, { tz, now = Date.now(), busy = [], exams = [], materials = {} } = {}) {
  return [
    `# Build my study plan\n_Exported from Canvas by StudyPilot · data as of ${fmt(snapshot.fetched_at, tz)} (${tz})_`,
    `## What I want
Build a realistic study schedule for the next ${prefs.daysAhead} days from my Canvas data below.
- Prioritize by due date, points, and my current grade in each class (weaker grades get a bit more time). Overdue items first.
- Split big assignments into several sessions over different days, finishing a few hours before each deadline.
- Add spaced review before quizzes and tests (for example 3 days and 1 day before). For the exams listed below, start review about a week ahead and increase it as the exam gets closer.
- Only schedule between ${prefs.studyStart} and ${prefs.studyEnd}, at most ${prefs.maxHoursPerDay} hours a day, sessions of about ${prefs.sessionMinutes} minutes.
- ${busy.length ? "Never overlap my busy times listed below (from my calendar: classes, work and other events)." : "If you can see my Google Calendar (through a connected calendar tool), check my events for these days first and plan around them. If you can't, ask me about fixed commitments (classes, work, practice) before finalizing."}
- Estimate how long each item will take a student from the actual material below (the problem sets, lab instructions and data are included): count the problems, note which need code, proofs or long write-ups, and plan accordingly. Ask me if something is unclear.
- If you're able to add events to my calendar, offer to add the sessions once I approve the plan.

Give me a short summary of the week and the biggest risks, then a day-by-day table (day, time, course, task, goal).
${PLAN_FORMAT}`,
    prefs.notes ? `## About me\n${prefs.notes}` : "",
    `## Right now\n${fmt(new Date(now).toISOString(), tz)} (${tz})`,
    `## Current grades\n${gradesLine(snapshot)}`,
    `## Deadlines\n${deadlinesTable(snapshot, { tz, now, daysAhead: prefs.daysAhead })}`,
    exams.length ? `## Upcoming exams\n${exams.map((e) => `- ${e.course}: ${e.title}, ${fmt(e.date, tz)}${e.source ? ` (from ${e.source})` : ""}`).join("\n")}` : "",
    detailsSection(snapshot, { tz, now, daysAhead: prefs.daysAhead, materials }),
    busySection(busy, tz),
  ].filter(Boolean).join("\n\n");
}

// ---------- Full course export (from the picker) ----------
// Shared rules for every quiz request: full coverage + self-contained questions.
export const QUIZ_RULES = `How to run the quiz:
1. First, silently make an outline of every topic in the material. Show me just the topic list (one line each) so I know what will be covered.
2. Spread the questions across ALL topics, not just the first few. If there are more topics than questions, combine related ones and say which topics got no question.
3. Every question must be self-contained: include all the context, numbers, definitions or code needed to answer it. Never say "as shown on slide 5", "in the figure", or "from the reading". If a question depends on a diagram or table, describe it fully in words.
4. Test understanding, not page trivia: ask about concepts, why things work, how to apply them, and what code would do. Don't ask about slide numbers, layout, or exact wording.
5. Ask one question at a time and wait for my answer. Then say if I'm right, explain why using the material, and keep score.
6. At the end, show my score per topic and list the topics I should review.`;

const GOALS = {
  context: "This is my course material exported from Canvas. Keep it as context and answer my questions about it. Cite which section you're using.",
  study: "Help me study this material. Start by summarizing the main topics per course and what's coming up, then ask what I want to focus on. Explain clearly with examples and check my understanding as we go.",
  quiz: "Quiz me on this material. Mix multiple choice, short answer and \"explain why\" questions.\n\n" + QUIZ_RULES,
  plan: "Use this to build me a study plan: read the syllabus and deadlines, then schedule study sessions and exam prep. " + PLAN_FORMAT,
};

const TAG = { new: "New", changed: "Updated" };
const tag = (x) => (x?.status && x.isUpdate ? ` (${TAG[x.status]})` : "");

export function exportPack(contents, { goal = "study", tz, prefs = {}, snapshot = null, downloadedFiles = 0 } = {}) {
  const isUpdate = contents.some((c) => c.since);
  const since = contents.map((c) => c.since).filter(Boolean).sort()[0];
  const intro = isUpdate
    ? `This is an **update** to Canvas material I shared before (my last export was ${fmt(since, tz)}). It only contains items that are new or changed since then, marked (New) or (Updated). Treat updated items as replacing the earlier version. Items I shared before that aren't listed here haven't changed.\n\n`
    : "";
  const parts = [
    `# Course ${isUpdate ? "update" : "export"}\n_Exported from Canvas by StudyPilot · ${fmt(new Date().toISOString(), tz)} (${tz})_`,
    `## What I want\n${intro}${GOALS[goal] || GOALS.study}` + (downloadedFiles ? `\n\nI've also downloaded ${downloadedFiles} new or changed course files (slides, readings) that I may attach separately.` : ""),
    prefs.notes ? `## About me\n${prefs.notes}` : "",
    snapshot ? `## Current grades\n${gradesLine(snapshot)}` : "",
  ];

  for (const c of contents) {
    const mark = (x) => tag({ ...x, isUpdate: !!c.since });
    const sec = [`# ${c.name}${c.code && c.code !== c.name ? ` (${c.code})` : ""}`];
    if (c.since) sec.push(`_Changes since ${fmt(c.since, tz)}: ${c.changes.new} new, ${c.changes.changed} updated._`);
    if (c.syllabus) sec.push(`## Syllabus${c.since ? " (updated)" : ""}\n${c.syllabus}`);
    if (c.assignments?.length) {
      sec.push("## Assignments\n" + c.assignments.map((a) =>
        `### ${a.name}${mark(a)}\nDue ${fmt(a.due_at, tz)} · ${a.points ?? "?"} pts · ${a.submitted ? `submitted${a.score != null ? `, score ${a.score}` : ""}` : "not submitted"}\n${a.details || ""}` +
        (a.rubric.length ? `\nRubric:\n${a.rubric.map((r) => `- ${r}`).join("\n")}` : "")).join("\n\n"));
    }
    if (c.modules?.length) sec.push(`## Modules${c.since ? " (outline changed)" : ""}\n` + c.modules.map((m) => `- **${m.name}**: ${m.items.join("; ") || "empty"}`).join("\n"));
    if (c.pages?.length) sec.push("## Pages\n" + c.pages.map((p) => `### ${p.title}${mark(p)}\n${p.text}`).join("\n\n"));
    if (c.discussions?.length) sec.push("## Discussions\n" + c.discussions.map((d) => `### ${d.title}${mark(d)}${d.due_at ? ` (due ${fmt(d.due_at, tz)})` : ""}\n${d.prompt}`).join("\n\n"));
    if (c.announcements?.length) sec.push("## Announcements\n" + c.announcements.map((a) => `- **${a.title}**${mark(a)} (${fmt(a.posted_at, tz)}): ${a.message}`).join("\n"));
    if (sec.length === (c.since ? 2 : 1)) sec.push(c.since ? "_Nothing new or changed._" : "_Nothing found for the selected categories._");
    parts.push(sec.join("\n\n"));
  }
  return parts.filter(Boolean).join("\n\n");
}

// True when an update export found nothing at all to send.
export function exportIsEmpty(contents) {
  return contents.every((c) => !c.syllabus && !c.assignments?.length && !c.modules?.length && !c.pages?.length && !c.discussions?.length && !c.announcements?.length);
}

export function quizPack({ title, text, count = 10, difficulty = "mixed" }) {
  return `# Practice quiz: ${title}\n_Material exported by StudyPilot_\n\n## What I want\nMake ${count} ${difficulty}-difficulty questions and quiz me on this material. Mix multiple choice, short answer and "explain why" questions. Base every question only on this material.\n\n${QUIZ_RULES}\n\n## Material\n${text.trim()}`;
}

export function studyPagePack({ title, url, text, kind }) {
  return `# Help me understand: ${title}
_${kind} exported from Canvas by StudyPilot · ${url}_

## What I want
Give me a short overview of this ${kind}${kind === "assignment" ? ", what I'm being asked to do, and how long it might take" : ""}. Explain the key concepts simply with an example each, then ask what I want to go deeper on.${kind === "assignment" ? " Help me plan it, give hints if I'm stuck, and check my reasoning, but let me do the work myself." : ""}

## Content
${text.trim()}`;
}

// One lecture (or a whole module) → quiz or study request.
// `files` are lecture files (slides/PDFs) downloaded for the student to attach in their AI chat.
export function lecturePack({ course, module, title, text = "", files = [], mode = "quiz", count = 10, difficulty = "mixed" }) {
  const where = [course, module].filter(Boolean).join(" · ");
  const attach = files.length
    ? `\n\nI'm attaching the lecture file${files.length > 1 ? "s" : ""}: ${files.map((f) => `"${f}"`).join(", ")}. Use ${files.length > 1 ? "them" : "it"} as the main source${text ? " together with the text below" : ""}.`
    : "";
  const ask = mode === "quiz"
    ? `This is the lecture I just had. Make ${count} ${difficulty}-difficulty questions on it: mostly multiple choice, plus a few short-answer and one "explain why" question. Only use this lecture's content.\n\n${QUIZ_RULES}`
    : `Help me review this lecture. Give me a short summary, the 3–6 key ideas with a simple example each, any terms I should memorize, and how it connects to earlier material. Then ask what I'd like to go deeper on.`;
  return `# ${mode === "quiz" ? "Quiz me on" : "Review"}: ${title}
_${where ? where + " · " : ""}exported from Canvas by StudyPilot_

## What I want
${ask}${attach}
${text.trim() ? `\n## Lecture content\n${text.trim()}` : ""}`;
}

// ---------- v4: lecture bundles (request + original files) ----------

// [2,3,4,7] → "2–4, 7"
export function ranges(nums) {
  const out = [];
  const s = [...nums].sort((a, b) => a - b);
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}–${s[j]}`);
    i = j;
  }
  return out.join(", ");
}

// A short map of a file for the AI: page count, which pages are visual, and a one-line outline.
export function fileGuide(doc, { maxLines = 80, attached = true } = {}) {
  const a = doc.analysis || {};
  if (a.error) return `I couldn't pre-read this file (${a.error}), so rely on the attached file for everything.`;
  if (a.unreadable) return "StudyPilot can't read this file type; use the attached file.";
  const unit = a.unit || "Page", u = unit.toLowerCase();
  const lines = [`${a.pageCount} ${u}${a.pageCount === 1 ? "" : "s"}.`];
  const figures = (a.visualPages || []).filter((n) => !(a.noTextPages || []).includes(n));
  const which = (list) => (list.length === 1 ? `${unit} ${list[0]} has` : `${unit}s ${ranges(list)} have`);
  if (a.noTextPages?.length) lines.push(attached
    ? `${which(a.noTextPages)} **no typed text** (handwriting, a scan or a picture). Read ${a.noTextPages.length === 1 ? "it" : "them"} from the attached file; ${a.noTextPages.length === 1 ? "it's" : "they're"} part of the material.`
    : `${which(a.noTextPages)} **no typed text** (handwriting, a scan or a picture), so ${a.noTextPages.length === 1 ? "it isn't" : "they aren't"} in the text below.`);
  if (figures.length) lines.push(`${which(figures)} diagrams, charts or images that carry content.`);
  if (a.scanned) lines.push("Most of this file is handwritten or scanned, so read it visually from the attachment.");
  const outline = (a.pages || []).filter((p) => p.kind !== "blank").slice(0, maxLines)
    .map((p) => `- ${unit} ${p.n}: ${p.title || (p.kind === "notext" ? (attached ? "(no typed text: read visually)" : "(no typed text)") : "(figure)")}${p.kind === "figure" || p.kind === "text+figure" ? " [figure]" : ""}`);
  if (outline.length > 1 && (a.pages || []).some((p) => p.title)) lines.push("Outline:\n" + outline.join("\n"));
  return lines.join("\n");
}

const ATTACH_RULES = `The attached files are the main source. Read every page, including diagrams, photos and handwritten pages; those are topics too. When a question is about a figure, describe the figure fully in words so the question stands on its own.`;

/**
 * entries: [{ doc, attachName?, imageNames?, tooBig?, error? }]
 * - file docs with attachName: original attached; we send a guide (plus text for slide decks as a fallback)
 * - file docs that couldn't be attached (tooBig): full extracted text instead
 * - page docs: full text, plus names of attached page images
 */
export function lectureBundlePack({ course, module, title, entries, mode = "quiz", count = 10, difficulty = "mixed" }) {
  const where = [course, module].filter(Boolean).join(" · ");
  const attached = entries.flatMap((e) => [e.attachName, ...(e.imageNames || [])]).filter(Boolean);
  const ask = mode === "quiz"
    ? `This is ${entries.length > 1 ? "material from class" : "the lecture I just had"}. Make ${count} ${difficulty}-difficulty questions on it: mostly multiple choice, plus a few short-answer and one "explain why" question. Only use this material.\n\n${QUIZ_RULES}`
    : `Help me review this ${entries.length > 1 ? "material" : "lecture"}. Give me a short summary, the key ideas with a simple example each (including what the diagrams and handwritten parts show), terms to memorize, and how it connects to earlier material. Then ask what I'd like to go deeper on.`;

  const sections = entries.map((e) => {
    const d = e.doc || {};
    if (e.error) return `### ${e.title || d.title || "Item"}\n_StudyPilot couldn't read this one: ${e.error}._`;
    if (d.kind === "page") {
      return `### ${d.title} (Canvas page)` + (e.imageNames?.length ? `\nImages from this page are attached: ${e.imageNames.map((n) => `"${n}"`).join(", ")}.` : "")
        + (e.hiddenImages ? `\n_This page also has ${e.hiddenImages} image${e.hiddenImages === 1 ? "" : "s"} you can't see; don't ask about ${e.hiddenImages === 1 ? "it" : "them"}._` : "") + `\n\n${d.text || ""}`;
    }
    const text = d.analysis?.text || "";
    if (e.inline && !e.attachName) {
      const vis = d.analysis?.visualPages?.length || 0;
      return `### ${d.title} (text of the ${String(d.analysis?.unit || "page").toLowerCase()}s)\n${fileGuide(d, { attached: false })}` +
        (vis ? `\n_You only have the text: diagrams, photos and handwriting on the pages marked above aren't visible to you. Quiz on what the text supports, and don't invent what a figure shows._` : "") +
        `\n\n${text.slice(0, 200000)}`;
    }
    if (e.attachName) {
      let s = `### ${d.title}: attached as "${e.attachName}"\n${fileGuide(d)}`;
      if (d.format === "pptx" && text) s += `\n\nText from the slides, in case the attachment can't be opened:\n${text.slice(0, 60000)}`;
      return s;
    }
    return `### ${d.title} (file too large to attach; text below)\n${fileGuide(d)}\n_Diagrams and handwritten pages in this file aren't visible in this text._\n\n${text}`;
  });

  return `# ${mode === "quiz" ? "Quiz me on" : "Review"}: ${title}
_${where ? where + " · " : ""}prepared by StudyPilot_

## What I want
${ask}
${attached.length ? `\n${ATTACH_RULES}\n\nAttached: ${attached.map((n) => `"${n}"`).join(", ")}. If any of these didn't come through, tell me before starting.` : ""}

## Material
${sections.join("\n\n")}`;
}

// ---------- v4: Project pack (one Markdown file per module, originals alongside) ----------
export function projectModuleMd({ course, module, entries }) {
  const parts = [`# ${module}\n_${course} · Canvas module · prepared by StudyPilot_`];
  for (const e of entries) {
    const d = e.doc || {};
    if (e.error) { parts.push(`## ${e.title}\n_Couldn't be read: ${e.error}_`); continue; }
    if (d.kind === "page") {
      parts.push(`## ${d.title} (Canvas page)` + (e.imageNames?.length ? `\nImages from this page (in this folder): ${e.imageNames.map((n) => `"${n}"`).join(", ")}` : "") + `\n\n${d.text || ""}`);
    } else {
      const text = d.analysis?.text || "";
      parts.push(`## ${d.title}\nOriginal file in this folder: "${e.attachName || d.file?.name}"\n${fileGuide(d)}` +
        (text ? `\n\n### Text of the file\n${text}` : "") +
        (d.visual ? "\n\n_Some pages are diagrams or handwriting; the original file shows them._" : ""));
    }
  }
  return parts.join("\n\n");
}

export const PROJECT_HOWTO = (courses) => `# How to use these files with an AI assistant

Most AI assistants let you keep files with a set of chats: Claude and ChatGPT call these Projects, and Gemini calls them Gems. Some use other names.

1. Create one (for example "Fall semester").
2. Add these files: \`00 Course overview.md\`, the module \`.md\` files, and the original PDFs and slides from the module folders. Originals matter for diagrams and handwritten pages.
3. Paste the instructions below into its instructions or custom-instructions box.
4. Ask things like "what's due this week?" or "explain lecture 19's diagrams" from any device.

For quizzes you want to track, use StudyPilot's Practice tab instead: your scores and review schedule are kept there.

When StudyPilot makes this pack again, only changed files are included. Replace those.

Courses in this pack: ${courses.join(", ")}

## Instructions
${PROJECT_INSTRUCTIONS}
`;

export const PROJECT_INSTRUCTIONS = `You're my study coach for this semester. My Canvas exports and course files are in this project.
- "What should I do today/this week?" → give a concrete plan from my deadlines and study hours.
- "Quiz me on <topic>" → one question at a time from the course material, keep score.
- Help me understand assignments with explanations, hints and similar worked examples, but let me do graded work myself.
- When you make a schedule, end with a \`studypilot-plan\` JSON block so I can import it to my calendar.
- If the export looks more than a few days old, remind me to refresh it.`;
