// Rules that keep StudyPilot from touching anything that could start, consume or submit an attempt.
// Everything is read through GET requests to the Canvas REST API; nothing is ever POSTed to Canvas.

// Module item types we never open or fetch.
export const BLOCKED_ITEM_TYPES = new Set(["Quiz", "ExternalTool", "ExternalUrl"]);

// Assignment submission types that are quizzes or third-party tools (New Quizzes, Respondus, publisher tools…).
const BLOCKED_SUBMISSION_TYPES = new Set(["online_quiz", "external_tool"]);

// URL patterns for pages StudyPilot must never read or decorate.
export const PROTECTED_URL = /\/quizzes(\/|$)|\/assessments?\/|quiz-lti|\/external_tools\/|lockdown|respondus|proctor/i;

export function isBlockedAssignment(a) {
  if (a.is_quiz_assignment || a.quiz_id) return true;
  return (a.submission_types || []).some((t) => BLOCKED_SUBMISSION_TYPES.has(t));
}

export function isLocked(obj) {
  return !!(obj?.locked_for_user || obj?.hidden_for_user || obj?.locked || obj?.hidden);
}

// Content of a blocked assignment is never exported: only its name and due date, so it can still be planned around.
export function safeAssignmentContent(a) {
  if (isBlockedAssignment(a)) return "(Quiz or external tool, so StudyPilot doesn't open it. Only the due date is listed.)";
  if (isLocked(a)) return "(Locked until it opens in Canvas.)";
  return null;
}

// What kind of work an assignment is, for planning. Reads only the assignment's own fields; nothing is opened.
const TOOL_NAMES = [[/gradescope/i, "Gradescope"], [/prairielearn/i, "PrairieLearn"], [/webassign/i, "WebAssign"], [/mylab|pearson/i, "Pearson MyLab"],
  [/mcgraw|connect\.mheducation/i, "McGraw-Hill Connect"], [/wiley/i, "WileyPLUS"], [/zybooks/i, "zyBooks"], [/turnitin/i, "Turnitin"],
  [/github/i, "GitHub Classroom"], [/edstem/i, "Ed"], [/piazza/i, "Piazza"], [/perusall/i, "Perusall"], [/hypothes/i, "Hypothesis"]];

export function assignmentKind(a) {
  const types = a.submission_types || [];
  const url = a.external_tool_tag_attributes?.url || "";
  if (a.is_quiz_assignment || a.quiz_id || types.includes("online_quiz") || /quiz-lti|quizzes\.next/i.test(url)) return { kind: "quiz", label: "quiz/test" };
  if (types.includes("external_tool")) {
    let host = "";
    try { host = url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { /* not a URL */ }
    const tool = TOOL_NAMES.find(([re]) => re.test(url))?.[1] || host || "an outside tool";
    return { kind: "tool", label: `submitted on ${tool}`, tool };
  }
  if (types.includes("discussion_topic")) return { kind: "discussion", label: "discussion post" };
  if (types.includes("none") || types.includes("on_paper")) return { kind: "offline", label: "in class / on paper" };
  return { kind: "assignment", label: "assignment" };
}
