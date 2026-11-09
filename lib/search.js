// Search across everything StudyPilot has read: lecture slides and pages (by page/slide), video transcripts
// (by time), assignments, announcements, syllabi, exam dates and your own questions. Runs locally; nothing is sent anywhere.
// Pure functions, tested in Node.

const STOP = new Set("a an and are as at be by for from how i in is it of on or that the this to was what when where which who why with do does did can".split(" "));
export const terms = (q) => {
  const phrases = [...String(q).matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase().trim()).filter(Boolean);
  const words = String(q).replace(/"[^"]*"/g, " ").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'+#.-]*/gu) || [];
  const w = words.map((x) => x.replace(/[.'-]+$/, "")).filter((x) => x.length > 1 && !STOP.has(x));
  return { words: [...new Set(w.length ? w : words)], phrases };
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// "regression" also finds "regressions"; short words match whole words only.
const wordRe = (w) => new RegExp(w.length <= 3 ? `\\b${esc(w)}\\b` : `\\b${esc(w)}\\w{0,3}`, "gi");

// ---------- chunks ----------
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function splitLong(text, max = 700) {
  const paras = text.split(/\n{2,}/);
  const out = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > max && cur) { out.push(cur); cur = p; } else cur = cur ? cur + "\n\n" + p : p;
    while (cur.length > max * 1.6) { const cut = cur.lastIndexOf(" ", max) > 100 ? cur.lastIndexOf(" ", max) : max; out.push(cur.slice(0, cut)); cur = cur.slice(cut).trim(); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** A library doc → chunks with a location ("Slide 14", "12:34 in the video"). */
export function docChunks(doc, { course = "" } = {}) {
  const base = { kind: doc.video ? "Video" : doc.kind === "file" ? "Slides" : "Page", courseId: doc.course_id, course, title: doc.title, url: doc.url || null, key: doc.key, module: doc.module || "" };
  const text = doc.kind === "file" ? doc.analysis?.text || "" : doc.text || "";
  if (!text.trim()) return [];
  const out = [];
  const marks = [...text.matchAll(/--- (Page|Slide|Sheet) (\d+) ---\n/g)];
  if (marks.length) {
    marks.forEach((m, i) => {
      const body = text.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined).trim();
      splitLong(body).forEach((t) => out.push({ ...base, where: `${m[1]} ${m[2]}`, page: Number(m[2]), text: t }));
    });
    return out;
  }
  // Transcripts: paragraphs start with [mm:ss] (or [h:mm:ss])
  const [main, transcript] = doc.video ? ["", text] : text.split("\n\n[Video transcript]\n");
  if (main.trim()) splitLong(main).forEach((t) => out.push({ ...base, where: "", text: t }));
  if (transcript) {
    for (const p of transcript.split(/\n{2,}/)) {
      const m = p.match(/^\[(?:(\d+):)?(\d+):(\d{2})\]\s*/);
      const sec = m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : null;
      const t = m ? p.slice(m[0].length) : p;
      if (!t.trim() || /^\[Next video\]$/.test(t.trim()) || /^Transcript of the recorded lecture/.test(t)) continue;
      const url = sec != null && base.url && /panopto/i.test(base.url) ? `${base.url}${base.url.includes("?") ? "&" : "?"}start=${sec}` : base.url;
      out.push({ ...base, kind: "Video", where: sec != null ? `${fmtTime(sec)} in the video` : "video transcript", sec, url, text: t });
    }
  }
  return out;
}

/** Everything else: assignments, announcements, syllabus text, exams, questions. */
export function otherChunks({ snapshot, syllabus = {}, exams = [], questions = [], courseName = (id) => String(id) }) {
  const out = [];
  for (const c of snapshot?.courses || []) {
    const course = c.code || c.name;
    for (const a of c.assignments) out.push({ kind: "Assignment", courseId: c.id, course, title: a.name, url: a.url, where: a.due_at ? `due ${new Date(a.due_at).toLocaleDateString([], { month: "short", day: "numeric" })}` : "", text: [a.name, a.details].filter(Boolean).join("\n") });
  }
  for (const a of snapshot?.announcements || []) out.push({ kind: "Announcement", courseId: a.course_id, course: courseName(a.course_id), title: a.title, url: a.url, where: a.posted_at ? new Date(a.posted_at).toLocaleDateString([], { month: "short", day: "numeric" }) : "", text: `${a.title}\n${a.message || ""}` });
  for (const [id, s] of Object.entries(syllabus)) for (const t of splitLong(s.text || "")) out.push({ kind: "Syllabus", courseId: Number(id), course: courseName(Number(id)), title: "Syllabus", url: s.url || null, where: "", text: t });
  for (const e of exams) out.push({ kind: "Exam", courseId: e.courseId, course: e.course, title: e.title, where: new Date(e.date).toLocaleDateString([], { month: "short", day: "numeric" }), text: `${e.title} ${e.source || ""}` });
  for (const q of questions) {
    if (q.type === "card" && q.source === "auto") continue;
    const ans = q.type === "mcq" ? q.options?.[q.answer] : q.type === "tf" ? String(q.answer) : q.answer;
    out.push({ kind: "Question", courseId: q.courseId, course: courseName(q.courseId), title: q.topic || "Question", where: q.lectureTitle || "", qid: q.id, text: `${q.prompt}\n${ans ?? ""}${q.explanation ? `\n${q.explanation}` : ""}` });
  }
  return out;
}

// ---------- search ----------
const KIND_BOOST = { Module: 0.8, Slides: 1.15, Page: 1.1, Video: 1, Syllabus: 1.05, Assignment: 1, Announcement: 0.95, Exam: 1.2, Question: 0.9 };
export function search(chunks, query, { limit = 40, courseId = null } = {}) {
  const { words, phrases } = terms(query);
  if (!words.length && !phrases.length) return [];
  const res = [];
  for (const ch of chunks) {
    if (courseId != null && ch.courseId !== courseId) continue;
    const text = ch.text, low = text.toLowerCase();
    let score = 0, hits = 0;
    for (const p of phrases) { const n = low.split(p).length - 1; if (!n) { score = -1; break; } score += 6 * Math.min(n, 4); }
    if (score < 0) continue;
    for (const w of words) {
      const n = (text.match(wordRe(w)) || []).length;
      if (n) { hits++; score += 1 + Math.log2(1 + n); }
      if (wordRe(w).test(ch.title || "")) score += 1.5;
    }
    if (!phrases.length && hits < Math.min(words.length, words.length > 2 ? words.length - 1 : words.length)) continue;
    if (words.length > 1 && low.includes(words.join(" "))) score += 4;
    score *= (KIND_BOOST[ch.kind] || 1) / (1 + Math.max(0, text.length - 900) / 3000);
    res.push({ ...ch, score });
  }
  res.sort((a, b) => b.score - a.score);
  // At most 3 results from the same lecture, so one long deck doesn't crowd out the rest.
  const per = {};
  return res.filter((r) => { const k = r.key || `${r.kind}:${r.title}`; per[k] = (per[k] || 0) + 1; return per[k] <= 3; }).slice(0, limit);
}

/** A short excerpt around the first match: [{ t, hit }] pieces, for highlighting. */
export function snippet(text, query, size = 220) {
  const { words, phrases } = terms(query);
  const res = [...phrases.map((p) => new RegExp(esc(p), "gi")), ...words.map(wordRe)];
  let first = -1;
  for (const re of res) { re.lastIndex = 0; const m = re.exec(text); if (m && (first < 0 || m.index < first)) first = m.index; }
  const start = Math.max(0, first - Math.floor(size / 3));
  let s = text.slice(start, start + size).replace(/\s+/g, " ");
  if (start > 0) s = "…" + s.replace(/^\S*\s/, "");
  if (start + size < text.length) s = s.replace(/\s\S*$/, "") + "…";
  const all = new RegExp(res.map((r) => r.source).join("|") || "$^", "gi");
  const out = [];
  let last = 0;
  for (const m of s.matchAll(all)) { if (!m[0]) continue; if (m.index > last) out.push({ t: s.slice(last, m.index) }); out.push({ t: m[0], hit: true }); last = m.index + m[0].length; }
  if (last < s.length) out.push({ t: s.slice(last) });
  return out;
}

/** The request for "Ask my AI using these results". */
export function askPrompt(query, results) {
  const blocks = results.slice(0, 10).map((r, i) => `### [${i + 1}] ${r.course}: ${r.title}${r.where ? ` (${r.where})` : ""} · ${r.kind}\n${r.text.slice(0, 1500)}`);
  return `# Question about my course material

My question: ${query}

Answer using the excerpts from my course below (from my slides, lecture recordings, assignments and syllabus). Say which excerpt each part of your answer comes from, like [2]. If the excerpts don't answer it, say so and tell me what to look for instead. If this is about graded work, help me understand the ideas without giving the answer.

${blocks.join("\n\n")}`;
}
