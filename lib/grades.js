// Fills the Grade Ledger from Canvas: assignment-group weights when the course uses them,
// otherwise weights found in the syllabus, otherwise points. Pure functions (testable in Node).

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const stem = (s) => norm(s).split(" ").map((w) => w.replace(/(zes|ses|es|s)$/, "")).filter((w) => w && !["and", "the", "of", "in", "class"].includes(w));

/** groups: [{ name, weight, assignments: [{ points, score, excused, graded, omit }] }] → per-group totals */
export function groupTotals(groups) {
  return groups.map((g) => {
    const counted = (g.assignments || []).filter((a) => !a.omit && !a.excused && a.points > 0);
    const graded = counted.filter((a) => a.graded && a.score != null);
    const earned = graded.reduce((s, a) => s + a.score, 0);
    const possible = graded.reduce((s, a) => s + a.points, 0);
    return {
      name: g.name, weight: g.weight || 0, earned, possible, gradedCount: graded.length, total: counted.length,
      pct: possible > 0 ? (earned / possible) * 100 : null,
      remainingPoints: counted.filter((a) => !(a.graded && a.score != null)).reduce((s, a) => s + a.points, 0),
    };
  });
}

// Finds a grading breakdown in syllabus text (from the Syllabus page, a page, or a PDF/Word file):
// "Homework 25%", "Midterm 1 ..... 20 %", "30% Final", "Labs (15%)", "Quizzes – 10 percent", table rows
// split across lines ("Homework" / "20%"), and several on one line ("HW 20% Quizzes 10% Final 30%").
const PCT = String.raw`(\d{1,3}(?:\.\d+)?)\s*(?:%|percent\b)`;
const NAME = String.raw`([A-Za-z][A-Za-z0-9 &/()'’,+\-]{1,60}?)`;
const SKIP = /\b(late|per day|per hour|deduct\w*|penalt\w*|extra credit|bonus|or higher|or above|or better|or below|at least|no less than|curve\w*|plagiar\w*)\b/i;
const FILLER = /\b(is|are|will be|worth|counts?( for| as)?|accounts? for|makes? up|weighted|weight|of (the |your )?(final |course |overall )?grade|of total|total|grade|points?)\b/gi;

function cleanName(raw) {
  let name = raw.replace(/\([^)]*\)/g, " ").replace(/^[-*•·\d.)\s]+(?=[A-Za-z])/, "").replace(/^(the|a|an|your|and)\s+/i, "").replace(FILLER, " ").replace(/[(:\-–—=,.|]+\s*$/g, "").replace(/^[\s(|]+/, "").replace(/\s+/g, " ").trim();
  if (/^\(?[A-F][+-]?\)?$/i.test(name)) return ""; // letter-grade scale rows
  name = name.charAt(0).toUpperCase() + name.slice(1);
  if (name.length < 3 || name.split(" ").length > 7) return "";
  if (/^(grade|total|overall|course|final grade|your grade|the|and|or)$/i.test(name)) return "";
  return name;
}

export function extractWeightLines(text) {
  // Join "Homework" / "20%" table cells that PDF text puts on separate lines.
  const rawLines = String(text || "").replace(/\r/g, "").split(/\n|•|;/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const lines = [];
  for (const l of rawLines) {
    if (/^\(?\d{1,3}(?:\.\d+)?\s*%\)?$/.test(l) && lines.length && !/%/.test(lines[lines.length - 1])) lines[lines.length - 1] += " " + l;
    else lines.push(l);
  }
  const items = [];
  for (const line of lines) {
    if (line.length > 400) continue;
    if (/^---\s*(page|slide)/i.test(line)) continue;
    // "20% Homework, 30% Midterm" (percent first) vs "Homework 20%, Midterm 30%" (name first)
    const pctFirst = /^[\W_]*\(?\d{1,3}(?:\.\d+)?\s*(?:%|percent\b)/i.test(line);
    const re = pctFirst
      ? new RegExp(String.raw`\(?` + PCT + String.raw`\)?\s*(?:[:=\-–—|]|for|of|on)?\s*` + NAME + String.raw`(?=\s*(?:[,;/]|and\b|\(?\d{1,3}(?:\.\d+)?\s*(?:%|percent)|$))`, "gi")
      : new RegExp(NAME + String.raw`\s*(?:[:=\-–—|]|\.{2,})?\s*\(?\s*` + PCT + String.raw`\)?`, "g");
    for (const m of line.matchAll(re)) {
      // "late work loses 10% per day", "A: 93% or higher": percentages that aren't weights
      if (SKIP.test(line.slice(m.index, m.index + m[0].length + 18))) continue;
      const name = cleanName(pctFirst ? m[2] : m[1]), w = Number(pctFirst ? m[1] : m[2]);
      if (name && w > 0 && w <= 100) items.push({ name, weight: w });
    }
  }
  return items;
}

// A real breakdown adds up to about 100%. Syllabi sometimes list two schemes or extra percentages,
// so take the first run of consecutive items that sums to 100 (or close to it).
export function parseSyllabusWeights(text) {
  const items = extractWeightLines(text);
  const pick = (lo, hi) => {
    for (let i = 0; i < items.length; i++) {
      let sum = 0;
      const seen = new Set(), run = [];
      for (let j = i; j < items.length && sum < hi; j++) {
        const k = items[j].name.toLowerCase();
        if (seen.has(k)) break;
        seen.add(k); run.push(items[j]); sum += items[j].weight;
        if (run.length >= 2 && sum >= lo && sum <= hi) return run;
      }
    }
    return null;
  };
  return pick(99.5, 100.5) || pick(95, 105) || pick(90, 110) || [];
}

function matchGroup(name, totals) {
  const a = stem(name);
  let best = null, bestScore = 0;
  for (const t of totals) {
    const b = stem(t.name);
    const overlap = a.filter((w) => b.includes(w)).length;
    const score = overlap / Math.max(a.length, b.length, 1);
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

const fmt = (n) => (n == null ? "" : String(round(n, 4)));

/**
 * data: { weighted, groups: [...], syllabus: "text", current_score }
 * Returns { state, source, note } where state is the Grade Ledger's state shape.
 */
export function ledgerFromCanvas(data, { target = 90, assume = 85 } = {}) {
  const totals = groupTotals(data.groups || []).filter((t) => t.total > 0 || t.weight > 0);
  const base = { decimals: "2", target: String(target), assume: String(assume) };
  const weightSum = totals.reduce((s, t) => s + t.weight, 0);

  if (data.weighted && weightSum > 0) {
    return {
      source: "canvas-weights",
      note: "Categories and weights from Canvas. Categories with nothing graded yet count as still to come.",
      state: { ...base, mode: "percent", rows: totals.filter((t) => t.weight > 0).map((t) => ({ name: t.name, g: fmt(t.pct), l: "", e: "", p: "", w: fmt(t.weight) })) },
    };
  }

  const syl = data.syllabusWeights?.length ? data.syllabusWeights : parseSyllabusWeights(data.syllabus);
  if (syl.length) {
    const src = data.weightSource;
    const where = src ? (src.kind === "file" ? `${src.name}${src.via ? ` (${src.via})` : ""}` : src.kind === "page" ? `the page “${src.name}”` : src.name) : "your syllabus";
    return {
      source: "syllabus",
      note: `Weights read from ${where}, since Canvas doesn't list them. Grades in each category come from Canvas. Check the weights and edit anything that's off.`,
      state: { ...base, mode: "percent", rows: syl.map((s) => {
        const g = matchGroup(s.name, totals);
        return { name: s.name, g: fmt(g?.pct ?? null), l: "", e: "", p: "", w: fmt(s.weight) };
      }) },
    };
  }

  return {
    source: "points",
    note: (data.checked?.length ? "No grading breakdown found in Canvas or your syllabus. " : "Canvas doesn't list weights and no syllabus was found. ")
      + "Showing points for now; if your syllabus gives percentages, switch to Percent and type the weights.",
    state: { ...base, mode: "points", rows: totals.filter((t) => t.total > 0).map((t) => ({ name: t.name, g: "", l: "", e: t.possible ? fmt(t.earned) : "", p: t.possible ? fmt(t.possible) : "", w: "" })) },
  };
}
