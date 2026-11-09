// Mastery levels and topic coverage. Pure functions (no chrome.*), tested in Node.
// Topics come from the AI's quiz reply ("topics": every main topic in the material); each question names its topic.
import { mastery } from "./quiz.js";

export const normTopic = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\b(the|a|an|of|and|in|to|for)\b/g, " ").replace(/\s+/g, " ").trim();
export const sameTopic = (a, b) => {
  const x = normTopic(a), y = normTopic(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x))));
};

// New → Learning → Familiar → Mastered, from how far questions have moved through spaced review.
export const LEVELS = ["Not covered", "New", "Learning", "Familiar", "Mastered"];
export function levelOf(list) {
  const real = (list || []).filter((q) => q.type !== "retired");
  if (!real.length) return "Not covered";
  if (!real.some((q) => q.seen)) return "New";
  const m = mastery(real);
  return m >= 0.7 ? "Mastered" : m >= 0.35 ? "Familiar" : "Learning";
}
export const levelClass = (lv) => ({ "Not covered": "lv-none", New: "lv-new", Learning: "lv-learn", Familiar: "lv-fam", Mastered: "lv-done" })[lv] || "";

// "topics" in an AI reply: ["Bayes' rule", …] or [{ "name": "Bayes' rule", "lecture": "Lecture 4" }, …]
export function topicsFromReply(obj) {
  const raw = Array.isArray(obj?.topics) ? obj.topics : [];
  const out = [];
  for (const t of raw) {
    const name = String(typeof t === "string" ? t : t?.name || t?.topic || "").trim().slice(0, 60);
    if (name && !out.some((o) => sameTopic(o.name, name))) out.push({ name, lecture: typeof t === "object" ? String(t?.lecture || "").trim() : "" });
  }
  return out.slice(0, 30);
}

// Which lecture each topic belongs to: the one it names, else where most of that topic's questions landed,
// else (a one-lecture quiz) that lecture.
export function assignTopics(topics, { lectures = [], records = [] } = {}) {
  const byKey = {};
  const titleKey = (title) => lectures.find((l) => normTopic(l.title) === normTopic(title))?.key
    || lectures.find((l) => title && (normTopic(l.title).includes(normTopic(title)) || normTopic(title).includes(normTopic(l.title))))?.key;
  for (const t of topics) {
    let key = t.lecture ? titleKey(t.lecture) : null;
    if (!key) {
      const counts = {};
      records.filter((r) => sameTopic(r.topic, t.name) && r.lectureKey).forEach((r) => (counts[r.lectureKey] = (counts[r.lectureKey] || 0) + 1));
      key = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    }
    if (!key && lectures.length === 1) key = lectures[0].key;
    if (key) (byKey[key] ||= []).push(t.name);
  }
  return byKey;
}
// Adds topics to what's stored per lecture ({ [lectureKey]: { topics: [...], at } }), without duplicates.
export function mergeTopics(stored = {}, byKey = {}, now = Date.now()) {
  const out = { ...stored };
  for (const [key, names] of Object.entries(byKey)) {
    const cur = [...(out[key]?.topics || [])];
    for (const n of names) if (!cur.some((c) => sameTopic(c, n))) cur.push(n);
    out[key] = { topics: cur.slice(0, 40), at: now };
  }
  return out;
}

/**
 * Coverage of a set of lectures: every known topic, how many questions practice it, and its level.
 * Questions whose topic isn't in the list still count toward their own topic (shown after the listed ones).
 */
export function coverage(topicNames, questions) {
  const qs = (questions || []).filter((q) => q.type !== "card");
  const rows = [];
  for (const name of topicNames || []) {
    if (rows.some((r) => sameTopic(r.name, name))) continue;
    const list = qs.filter((q) => sameTopic(q.topic, name));
    rows.push({ name, n: list.length, level: levelOf(list), mastery: mastery(list), listed: true });
  }
  for (const q of qs) {
    if (!q.topic || rows.some((r) => sameTopic(r.name, q.topic))) continue;
    const list = qs.filter((x) => sameTopic(x.topic, q.topic));
    rows.push({ name: q.topic, n: list.length, level: levelOf(list), mastery: mastery(list), listed: false });
  }
  const listed = rows.filter((r) => r.listed);
  return { rows, total: listed.length, covered: listed.filter((r) => r.n > 0).length, missing: listed.filter((r) => !r.n).map((r) => r.name) };
}
