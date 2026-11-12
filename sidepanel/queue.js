// "For your AI": one list of every request waiting for the student's AI (lecture checklists, part questions,
// key terms, class times). Start runs them one after another: each request is filled in, the reply is picked up
// by itself, and the next one follows. The student only presses Send each time.
// New lectures (in courses where the student uses lecture mastery) and the next part of a lecture join on their own.
import { state, toast, plural, ai, lecturesFor, rerender, saveSettings } from "./core.js";

const KEY = "aiQueue";
export const jobKey = (j) => `${j.kind}:${j.lecture?.key || (j.refs || []).join(",")}:${j.n || ""}`;
export const getQueue = async () => (await chrome.storage.local.get(KEY))[KEY] || [];
const setQueue = (list) => chrome.storage.local.set({ [KEY]: list.slice(0, 60) });

export function jobLabel(j) {
  const t = j.lecture?.title || "";
  switch (j.kind) {
    case "checklist": return { title: `Checklist: ${t}`, sub: j.course || "" };
    case "part": return { title: `${t}: Part ${j.n}`, sub: `${j.course ? `${j.course} · ` : ""}questions` };
    case "terms": return { title: `Key terms: ${t}`, sub: j.course || "" };
    case "classTimes": return { title: "Class times for My week", sub: "All your courses" };
    case "sizes": return { title: `How long ${(j.refs || []).length === 1 ? "an assignment takes" : `${(j.refs || []).length} assignments take`}`, sub: "Study plan · their files go along" };
    case "priorities": return { title: "Your study plan", sub: "Priorities for the coming days" };
    default: return { title: t || "Request", sub: "" };
  }
}

/** Adds a request to the list (no duplicates). front: run it next. */
export async function addJob(job, { front = false, quiet = false } = {}) {
  const list = await getQueue();
  const key = jobKey(job);
  if (list.some((j) => jobKey(j) === key)) return false;
  const j = { ...job, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now() };
  await setQueue(front ? [j, ...list] : [...list, j]);
  if (!quiet) toast(`Added to your list for ${ai().name}: ${jobLabel(j).title}.`, { ms: 5000 });
  rerender();
  return true;
}
export async function removeJob(idOrKey) {
  const list = await getQueue();
  await setQueue(list.filter((j) => j.id !== idOrKey && jobKey(j) !== idOrKey));
  rerender();
}

/**
 * Every AI button goes through here. If another request is still waiting for an answer, this one joins the list
 * (it runs right after); otherwise it runs now. Running it removes it from the list.
 */
export async function aiAction(job) {
  if (state.pending) { await addJob(job, { front: true }); return; }
  await removeJob(jobKey(job));
  await runJob(job);
}

async function runJob(j) {
  const m = await import("./mastery.js");
  const { lectureScope } = await import("./sheet.js");
  const scope = j.lecture ? lectureScope(j.courseId, j.lecture) : null;
  if (j.kind === "checklist") return m.buildChecklist(scope, j.fix ? { fix: j.fix } : {});
  if (j.kind === "part") return m.generatePart(scope, j.n, j.only ? { only: j.only } : {});
  if (j.kind === "terms") return m.getTerms(scope);
  if (j.kind === "classTimes") return (await import("./weekai.js")).findClassTimes(j.courseIds || null);
  if (j.kind === "sizes") return (await import("./plan.js")).requestSizes(j.refs || []);
  if (j.kind === "priorities") return (await import("./plan.js")).requestPriorities();
  throw new Error("StudyPilot doesn't know this request anymore; remove it from the list.");
}

// ---------- running the list ----------
export const isRunning = () => !!state.queueRun;
// The running list is remembered, so closing and reopening the panel doesn't stop it.
const saveRun = (run) => chrome.storage.local.set({ aiQueueRun: run ? { ...run, at: Date.now() } : null });
export async function restoreRun() {
  const { aiQueueRun } = await chrome.storage.local.get("aiQueueRun");
  if (aiQueueRun && Date.now() - aiQueueRun.at < 6 * 3600e3) state.queueRun = aiQueueRun;
  // The panel was closed while the list ran and the last reply already came in: carry on.
  if (state.queueRun && !state.pending) {
    const list = await getQueue();
    if (list.length && !state.queueRun.only) setTimeout(() => { if (state.queueRun && !state.pending) next(list[0]); }, 1500);
    else { state.queueRun = null; saveRun(null); }
  }
}
/** Starts the list (or one job from it). Each finished reply starts the next request by itself. */
export async function startQueue(onlyId = null) {
  if (state.pending) return toast("Your AI is still answering the last request. The list continues when that reply comes in.", { ms: 7000 });
  const list = await getQueue();
  const j = onlyId ? list.find((x) => x.id === onlyId) : list[0];
  if (!j) return;
  state.queueRun = { only: !!onlyId, done: 0, total: onlyId ? 1 : list.length };
  saveRun(state.queueRun);
  await next(j);
}
async function next(j) {
  await removeJob(j.id);
  state.queueRun.current = jobLabel(j).title;
  saveRun(state.queueRun);
  try { await runJob(j); }
  catch (e) {
    toast(`${jobLabel(j).title}: ${e.message}`, { error: true, ms: 9000 });
    // keep it for later, at the end of the list
    await addJob(j, { quiet: true });
    state.queueRun = null; saveRun(null);
  }
  rerender();
}
/** Called after a reply was added. Fills in the next request if the list is running. */
export async function afterReply() {
  if (!state.queueRun) { const { aiQueueRun } = await chrome.storage.local.get("aiQueueRun"); if (aiQueueRun) state.queueRun = aiQueueRun; }
  const run = state.queueRun;
  if (!run) return;
  run.done++;
  saveRun(run);
  const list = await getQueue();
  if (run.only || !list.length) {
    state.queueRun = null; saveRun(null);
    if (!run.only && run.done > 1) toast(`Your AI list is done (${plural(run.done, "request")}).`, { ms: 6000 });
    rerender();
    return;
  }
  run.total = run.done + list.length; // things can join while the list runs (Part 1 after a checklist)
  setTimeout(() => { if (state.queueRun === run && !state.pending) next(list[0]); }, 1200);
}
export function stopQueue() { state.queueRun = null; saveRun(null); rerender(); }

// ---------- adding things on their own ----------
// Courses where new lectures join the list: on once the student has made a checklist there (they use mastery in
// that course), unless they turned it off. Only lectures posted after that point are added (no backlog).
export function autoFor(courseId, checklists) {
  const set = (state.settings.autoChecklist || {})[courseId];
  if (set) return set.on ? set : null;
  const first = Object.values(checklists || {}).filter((r) => String(r.courseId) === String(courseId)).map((r) => r.at || 0).sort((a, b) => a - b)[0];
  return first ? { on: true, since: new Date(first).toISOString() } : null;
}
export async function setAuto(courseId, on) {
  await saveSettings({ autoChecklist: { ...(state.settings.autoChecklist || {}), [courseId]: { on, since: new Date().toISOString() } } });
}

/** Looks for new lectures (a few times a day) and adds their checklists to the list. */
export async function checkNewLectures({ force = false } = {}) {
  const { aiQueueChecked = 0, checklists = {} } = await chrome.storage.local.get(["aiQueueChecked", "checklists"]);
  if (!force && Date.now() - aiQueueChecked < 3 * 3600e3) return 0;
  await chrome.storage.local.set({ aiQueueChecked: Date.now() });
  const courses = (state.snapshot?.courses || []).filter((c) => !(state.settings.hiddenCourses || []).includes(c.id));
  const { aiQueueSkip = [] } = await chrome.storage.local.get("aiQueueSkip");
  let added = 0;
  for (const c of courses) {
    const auto = autoFor(c.id, checklists);
    if (!auto) continue;
    const list = await lecturesFor(c.id, { fresh: true }).catch(() => []);
    for (const l of list) {
      if (!l.is_lecture || !["File", "Page"].includes(l.type) || checklists[l.key] || aiQueueSkip.includes(l.key)) continue; // notebooks: the background check
      if (!l.date || l.date < auto.since) continue;
      if (await addJob({ kind: "checklist", courseId: c.id, course: c.code || c.name, lecture: l }, { quiet: true })) added++;
    }
  }
  if (added) { toast(`${plural(added, "new lecture")} added to your list for ${ai().name}.`, { ms: 6000 }); rerender(); }
  return added;
}
/** Removing an automatically added lecture means "don't add this one again". */
export async function skipLecture(key) {
  const { aiQueueSkip = [] } = await chrome.storage.local.get("aiQueueSkip");
  await chrome.storage.local.set({ aiQueueSkip: [...new Set([...aiQueueSkip, key])].slice(-500) });
}
