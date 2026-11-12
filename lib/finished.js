// Is an AI reply complete? A reply that was stopped, cut off or hit an error must never be imported.
// Quizzes end with an explicit {"end":true,"count":N} line; the other replies are one JSON object, which
// only parses when it's whole.
import { parseChecklist } from "./checklist.js";
import { parseWeightsReply } from "./ai.js";
import { parsePlan } from "./planparse.js";
import { repairLatexJson } from "./rich.js";

const END_RE = /\{\s*"end"\s*:\s*true\s*(?:,\s*"count"\s*:\s*(\d+)\s*)?\}/;

function quizBody(t) {
  const at = t.indexOf("```studypilot-quiz");
  let body = at >= 0 ? t.slice(at + 18) : t;
  const end = body.search(/\n```\s*(\n|$)/);
  return end >= 0 ? body.slice(0, end) : body;
}

/** Returns { done, got, total }: got = how many questions/items are in so far, total = what the AI says it wrote. */
export function replyProgress(kind, text) {
  const t = String(text || "");
  if (kind === "quiz") {
    const body = quizBody(t);
    const got = (body.match(/"type"\s*:/g) || []).length;
    const m = body.match(END_RE);
    if (m) return { done: true, got, total: m[1] ? Number(m[1]) : got };
    // Older one-object form {"questions":[…]}: whole only if it parses.
    const trimmed = body.trim();
    if (/^\{\s*"questions"/.test(trimmed)) {
      for (const c of [repairLatexJson(trimmed), trimmed]) { try { JSON.parse(c); return { done: true, got, total: got }; } catch { /* not whole */ } }
    }
    return { done: false, got, total: 0 };
  }
  if (kind === "checklist") {
    const got = (t.match(/"text"\s*:/g) || []).length;
    try { parseChecklist(t); return { done: true, got, total: got }; } catch { return { done: false, got, total: 0 }; }
  }
  if (kind === "schedule" || kind === "sizes" || kind === "priorities") {
    const tag = `\`\`\`studypilot-${kind}`;
    const at = t.indexOf(tag);
    const body = at >= 0 ? t.slice(at + tag.length) : t;
    const a = body.indexOf("{"), b = body.lastIndexOf("}");
    const got = (body.match({ schedule: /"start"\s*:/g, sizes: /"hours"\s*:/g, priorities: /"minutes"\s*:/g }[kind]) || []).length;
    const list = { schedule: "courses", sizes: "assignments", priorities: "tasks" }[kind];
    try { const o = JSON.parse(body.slice(a, b + 1)); return { done: Array.isArray(o[list]) && o.end === true, got, total: got }; } catch { return { done: false, got, total: 0 }; }
  }
  const parse = kind === "weights" ? parseWeightsReply : kind === "plan" ? parsePlan : null;
  if (!parse) return { done: true, got: 0, total: 0 };
  try { parse(t); return { done: true, got: 0, total: 0 }; } catch { return { done: false, got: 0, total: 0 }; }
}

export const isFinished = (kind, text) => replyProgress(kind, text).done;

// What to send the AI when its reply stopped part-way.
export function redoPrompt(kind) {
  const tag = { quiz: "studypilot-quiz", checklist: "studypilot-checklist", plan: "studypilot-plan", weights: "studypilot-weights", schedule: "studypilot-schedule", sizes: "studypilot-sizes", priorities: "studypilot-priorities" }[kind] || "studypilot";
  return `Your last reply stopped before it finished. Please write the whole \`${tag}\` code block again from the beginning, complete, directly in your reply (not in an artifact or file)${kind === "quiz" ? ', and end it with the line {"end":true,"count":<number of questions>}' : ["schedule", "sizes", "priorities"].includes(kind) ? ', ending with "end": true' : ""}. Keep your answer short so it fits; if it's long, I'll ask for the rest in another message.`;
}
