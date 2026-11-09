// Parses a study plan pasted back from your AI into calendar sessions.
// Prefers the ```studypilot-plan``` JSON block; falls back to any JSON with a "sessions" array.

export function parsePlan(text) {
  const blocks = [...String(text).matchAll(/```([\w-]*)\s*([\s\S]*?)```/g)];
  const ordered = [...blocks.filter((b) => b[1] === "studypilot-plan"), ...blocks.filter((b) => b[1] !== "studypilot-plan")];
  const candidates = ordered.map((b) => b[2]);
  candidates.push(text);

  for (const raw of candidates) {
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start < 0 || end < start) continue;
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      const sessions = (obj.sessions || []).map(clean).filter(Boolean);
      if (sessions.length) return sessions;
    } catch { /* try next */ }
  }
  throw new Error("Couldn't find the plan. Paste the AI's whole reply, including the block that starts with ```studypilot-plan.");
}

function clean(s) {
  const start = Date.parse(s.start), end = Date.parse(s.end);
  if (!s.title || isNaN(start) || isNaN(end) || end <= start) return null;
  return { title: String(s.title).slice(0, 200), course: s.course || "", goal: s.goal || "", start: s.start, end: s.end };
}
