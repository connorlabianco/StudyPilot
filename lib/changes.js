// Change alerts: what's different since the last sync (due dates moved, new work, new grades, exam dates).
// Pure functions, tested in Node.
const DAY = 864e5;
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: /T00:00(:00)?(\.000)?Z?$/.test(iso) || iso.length <= 10 ? "UTC" : undefined });
const when = (iso) => iso ? new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "no due date";

/** Compares two snapshots. Returns [{ id, kind, courseId, course, title, detail, url, important, at }] */
export function diffSnapshots(prev, next, { now = Date.now() } = {}) {
  if (!prev?.courses || !next?.courses) return [];
  const out = [];
  const add = (c) => out.push({ at: now, ...c, id: `${c.kind}:${c.key}:${now}` });
  for (const c of next.courses) {
    const old = prev.courses.find((x) => x.id === c.id);
    if (!old) continue; // a newly added course isn't "a change"
    const course = c.code || c.name;
    const oldById = new Map(old.assignments.map((a) => [a.id, a]));
    for (const a of c.assignments) {
      const o = oldById.get(a.id);
      const base = { courseId: c.id, course, title: a.name, url: a.url };
      if (!o) {
        // New work (skip things already past due; those are usually old items being published late)
        if (!a.due_at || Date.parse(a.due_at) > now) add({ ...base, kind: "new", key: a.id, detail: a.due_at ? `New, due ${when(a.due_at)}` : "New assignment", important: !!a.due_at && Date.parse(a.due_at) - now < 7 * DAY });
        continue;
      }
      if ((o.due_at || "") !== (a.due_at || "") && !a.submitted) {
        const earlier = a.due_at && o.due_at && Date.parse(a.due_at) < Date.parse(o.due_at);
        const detail = !a.due_at ? `Due date removed (was ${when(o.due_at)})` : !o.due_at ? `Now due ${when(a.due_at)}` : `Due ${when(a.due_at)} (was ${when(o.due_at)})`;
        add({ ...base, kind: earlier ? "earlier" : "moved", key: a.id, detail, important: !!earlier || (!o.due_at && Date.parse(a.due_at) - now < 7 * DAY) });
      }
      const graded = a.graded && a.score != null;
      if (graded && (!o.graded || o.score !== a.score)) {
        add({ ...base, kind: o.graded ? "regrade" : "grade", key: a.id, detail: `${o.graded ? `Grade changed: ${o.score} → ` : "Graded: "}${a.score}${a.points ? ` / ${a.points}` : ""}`, important: false });
      }
    }
    if (old.current_score != null && c.current_score != null && Math.abs(old.current_score - c.current_score) >= 0.5) {
      add({ courseId: c.id, course, title: "Course grade", kind: "course-grade", key: c.id, detail: `${old.current_score}% → ${c.current_score}%`, important: false });
    }
  }
  return out;
}

/** Exam dates that moved or appeared (same course, matched by title). */
export function diffExams(prevList = [], nextList = [], { courseId, course, now = Date.now() } = {}) {
  const out = [];
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const e of nextList) {
    if (Date.parse(e.date) < now) continue;
    const o = prevList.find((x) => norm(x.title) === norm(e.title));
    if (o && o.date.slice(0, 10) !== e.date.slice(0, 10)) {
      out.push({ at: now, id: `exam:${norm(e.title)}:${now}`, kind: "exam", courseId, course, title: e.title, detail: `Now ${day(e.date)} (was ${day(o.date)})`, important: true });
    } else if (!o && prevList.length) {
      out.push({ at: now, id: `exam:${norm(e.title)}:${now}`, kind: "exam-new", courseId, course, title: e.title, detail: `Found: ${day(e.date)}`, important: Date.parse(e.date) - now < 14 * DAY });
    }
  }
  return out;
}

// Keeps two weeks of changes (at most 80); the same item changing twice keeps only the latest.
export function addChanges(list = [], fresh = [], { now = Date.now() } = {}) {
  const keyOf = (c) => `${c.kind === "earlier" ? "moved" : c.kind}:${c.courseId}:${c.title}`;
  const merged = [...fresh, ...list];
  const seen = new Set();
  return merged.filter((c) => now - c.at < 14 * DAY && !seen.has(keyOf(c)) && seen.add(keyOf(c))).slice(0, 80);
}
