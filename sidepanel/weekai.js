// My week: find class times with the student's AI (from the syllabus and course pages), and save them.
import { send, state, toast, plural, visibleSnapshot } from "./core.js";
import { handToAI } from "./aiflow.js";
import { classTimesPrompt, parseSchedule, mergeClasses, emptyWeek, sectionGroups } from "../lib/schedule.js";

export const getWeek = async () => ({ ...emptyWeek(), ...((await chrome.storage.local.get("week")).week || {}) });
export const saveWeek = async (week) => { await chrome.storage.local.set({ week: { ...week, at: Date.now() } }); };

/** courseIds: which courses (default: every visible course). One request covers them all. */
export async function findClassTimes(courseIds = null) {
  const courses = (visibleSnapshot()?.courses || state.snapshot?.courses || []).filter((c) => !courseIds || courseIds.includes(c.id));
  if (!courses.length) throw new Error("StudyPilot doesn't see any courses yet. Connect Canvas first.");
  const found = await send("CLASS_TIME_SOURCES", { courseIds: courses.map((c) => c.id) });
  const withText = found.filter((c) => c.text);
  if (!withText.length) throw new Error("No class times found in your syllabi or course pages. Add them yourself on My week (“Add a class time”).");
  const text = classTimesPrompt(found.map((c) => ({ name: c.name, text: c.text })));
  await handToAI(text, { expect: "schedule", title: "Class times", meta: { courses: found.map((c) => ({ id: c.id, name: c.name, code: c.code })) } });
}

export async function importSchedule(text, meta) {
  const found = parseSchedule(text, meta.courses);
  const week = mergeClasses(await getWeek(), found);
  await saveWeek(week);
  const n = Object.values(found).reduce((a, c) => a + c.meetings.length, 0);
  const toPick = Object.entries(found).filter(([id, c]) => Object.values(sectionGroups(c.meetings)).some((opts) => opts.length > 1 && !week.picks?.[id]));
  toast(`${plural(n, "class time")} added to My week${toPick.length ? `. Pick your section${toPick.length > 1 ? "s" : ""} there (${toPick.length === 1 ? "1 course" : `${toPick.length} courses`})` : ""}.`, { ms: 9000 });
  openWeek();
}

/** Opens My week, or brings it to the front if it's already open. */
export async function openWeek() {
  const tabId = await new Promise((resolve) => {
    const ch = new BroadcastChannel("studypilot-week");
    const t = setTimeout(() => { ch.close(); resolve(null); }, 300);
    ch.onmessage = (e) => { if (e.data?.type === "here") { clearTimeout(t); ch.close(); resolve(e.data.tabId); } };
    ch.postMessage({ type: "where" });
  });
  if (tabId != null) { const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null); if (tab) { chrome.windows?.update(tab.windowId, { focused: true }).catch(() => {}); return; } }
  chrome.tabs.create({ url: chrome.runtime.getURL("week/week.html"), active: true });
}
