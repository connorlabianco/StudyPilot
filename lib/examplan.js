// Exam countdown: what's on the exam (lectures since the previous exam), how ready you are, and what to do today.
// Pure functions, tested in Node.
import { coverage, sameTopic } from "./topics.js";
import { mastery, isDue } from "./quiz.js";

const DAY = 864e5;
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const daysUntil = (iso, now = Date.now()) => Math.round((dayStart(Date.parse(iso)) - dayStart(now)) / DAY);

/**
 * Lectures that the exam covers: posted after the previous exam in the same course and before this one.
 * A final with no earlier exam (or "cumulative") covers everything. Lectures with no date are kept.
 */
export function examLectures(exam, allExams, lectures) {
  const t = Date.parse(exam.date);
  const before = allExams.filter((e) => e.courseId === exam.courseId && Date.parse(e.date) < t).map((e) => Date.parse(e.date)).sort((a, b) => b - a)[0];
  const cumulative = /\bfinal\b|cumulative|comprehensive/i.test(exam.title) && !/\bfinal (project|paper|presentation)\b/i.test(exam.title);
  const from = cumulative || !before ? -Infinity : before;
  return (lectures || []).filter((l) => l.is_lecture !== false && (!l.date || (Date.parse(l.date) > from && Date.parse(l.date) <= t)));
}

/**
 * The plan: readiness, gaps, and today's steps.
 * questions: the course's question bank; topicsByLecture: { lectureKey: [topic, …] }
 */
export function examPlan({ exam, allExams = [], lectures = [], questions = [], topicsByLecture = {}, now = Date.now() }) {
  const days = daysUntil(exam.date, now);
  const scope = examLectures(exam, allExams, lectures);
  const keys = new Set(scope.map((l) => l.key));
  const qs = questions.filter((q) => q.courseId === exam.courseId && q.type !== "card" && (!scope.length || keys.has(q.lectureKey)));
  const topicNames = [];
  for (const l of scope) for (const t of topicsByLecture[l.key] || []) if (!topicNames.some((x) => sameTopic(x, t))) topicNames.push(t);
  const cov = coverage(topicNames, qs);
  const noQuestions = scope.filter((l) => !qs.some((q) => q.lectureKey === l.key));
  const weak = cov.rows.filter((r) => r.n && (r.level === "Learning" || r.level === "New")).map((r) => r.name);
  const due = qs.filter((q) => q.seen && isDue(q, now));
  const m = mastery(qs);
  const covPct = cov.total ? cov.covered / cov.total : (scope.length ? (scope.length - noQuestions.length) / scope.length : 0);
  const ready = Math.round((0.4 * covPct + 0.6 * m) * 100);

  // Today's steps, by how close the exam is:
  //  more than 2 days: fill gaps first (lectures with no questions, then missing topics), then review and weak topics;
  //  last 2 days: timed exam mode and weak topics; exam day: a light review only.
  const steps = [];
  if (days <= 0) {
    steps.push({ kind: "review", title: "Light review", sub: "A few questions to warm up. No cramming today.", count: 10 });
  } else if (days <= 2) {
    steps.push({ kind: "exam", title: "Timed practice exam", sub: `A mixed set across ${scope.length ? `${scope.length} lectures` : "the course"}, answers at the end`, count: Math.min(25, Math.max(10, qs.length)) });
    if (weak.length) steps.push({ kind: "weak", title: "Weak topics", sub: weak.slice(0, 3).join(", ") + (weak.length > 3 ? "…" : ""), topics: weak });
    if (noQuestions.length) steps.push({ kind: "guide", title: `Skim: ${noQuestions[0].title}`, sub: "No practice yet. A study guide is quicker than a quiz now.", lecture: noQuestions[0] });
  } else {
    // Spread the gaps over the days left (at least one a day, at most 3).
    const perDay = Math.min(3, Math.max(1, Math.ceil(noQuestions.length / Math.max(1, days - 2))));
    noQuestions.slice(0, perDay).forEach((l) => steps.push({ kind: "quiz", title: `Start: ${l.title}`, sub: "Not practiced yet: build its checklist and learn part 1", lecture: l }));
    if (!noQuestions.length && cov.missing.length) steps.push({ kind: "missing", title: `Quiz the ${cov.missing.length === 1 ? "missing topic" : `${cov.missing.length} missing topics`}`, sub: cov.missing.slice(0, 3).join(", ") + (cov.missing.length > 3 ? "…" : ""), topics: cov.missing });
    if (due.length) steps.push({ kind: "review", title: `Review ${due.length} due`, sub: "Spaced review keeps earlier lectures fresh", count: Math.min(20, due.length) });
    if (weak.length) steps.push({ kind: "weak", title: "Weak topics", sub: weak.slice(0, 3).join(", ") + (weak.length > 3 ? "…" : ""), topics: weak });
    if (!steps.length && qs.length) steps.push({ kind: "practice", title: "Mixed practice", sub: "Everything on this exam, weakest first", count: 15 });
  }
  return { exam, days, lectures: scope, questions: qs, coverage: cov, noQuestions, weak, due: due.length, mastery: m, ready, steps };
}
