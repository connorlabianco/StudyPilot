// Focus timer (Pomodoro-style): focus, then a short break, then you choose whether to go again.
// Runs in the background (chrome.alarms), so it keeps time with the side panel closed.
// State lives in chrome.storage.local "focus"; finished focus time goes to "studyLog" (synced with Google sign-in).

export const PRESETS = [
  { id: "starter", focus: 5, brk: 0, label: "Just 5 minutes", sub: "Start small. Keep going if you're in the zone." },
  { id: "short", focus: 15, brk: 5, label: "15 + 5", sub: "Short and steady" },
  { id: "classic", focus: 25, brk: 5, label: "25 + 5", sub: "Classic Pomodoro" },
  { id: "deep", focus: 50, brk: 10, label: "50 + 10", sub: "Deep work" },
];
const MIN = 6e4;

const get = async () => (await chrome.storage.local.get("focus")).focus || { phase: "idle" };
const put = (focus) => chrome.storage.local.set({ focus });

export const leftMs = (f, now = Date.now()) => f.pausedLeft != null ? f.pausedLeft : Math.max(0, (f.endsAt || 0) - now);

async function schedule(f) {
  await chrome.alarms.clear("focus-end");
  if (f.endsAt && f.pausedLeft == null && f.phase !== "idle" && f.phase !== "done") chrome.alarms.create("focus-end", { when: f.endsAt });
  await badge(f);
}

// The toolbar badge shows minutes left while a timer runs (green focus, blue break); otherwise the due count comes back.
export async function badge(f, restore) {
  if (!f || f.phase === "idle" || f.phase === "done") { if (restore) await restore(); return; }
  const m = Math.ceil(leftMs(f) / MIN);
  await chrome.action.setBadgeBackgroundColor({ color: f.pausedLeft != null ? "#8a8378" : f.phase === "break" ? "#3b7dd8" : "#2f9e6a" });
  await chrome.action.setBadgeText({ text: f.pausedLeft != null ? "||" : `${m}m` });
}

async function log(f, minutes) {
  if (minutes < 1) return;
  const { studyLog = [] } = await chrome.storage.local.get("studyLog");
  studyLog.push({ id: `${f.startedAt}-${f.round || 1}`, at: Date.now(), minutes: Math.round(minutes), courseId: f.courseId ?? null, label: f.label || "", task: f.task || null });
  await chrome.storage.local.set({ studyLog: studyLog.slice(-3000) });
}
const focusedMinutes = (f) => (f.phase === "focus" ? ((f.focus * MIN) - leftMs(f)) / MIN : 0);

export async function start({ focus = 25, brk = 5, label = "", courseId = null, task = null, preset = null }) {
  const now = Date.now();
  const cur = await get();
  if (cur.phase === "focus") await log(cur, focusedMinutes(cur));
  const f = { phase: "focus", focus, brk, label, courseId, task, preset, startedAt: now, endsAt: now + focus * MIN, round: cur.phase !== "idle" && cur.label === label ? (cur.round || 1) + 1 : 1, pausedLeft: null };
  await put(f); await schedule(f);
  return f;
}
export async function pause() {
  const f = await get();
  if (f.phase !== "focus" && f.phase !== "break") return f;
  if (f.pausedLeft == null) { f.pausedLeft = leftMs(f); await put(f); await schedule(f); }
  return f;
}
export async function resume() {
  const f = await get();
  if (f.pausedLeft == null) return f;
  f.endsAt = Date.now() + f.pausedLeft; f.pausedLeft = null;
  await put(f); await schedule(f);
  return f;
}
export async function extend(minutes = 5) {
  const f = await get();
  if (f.phase === "idle") return f;
  if (f.phase === "done") return start({ ...f, focus: minutes });
  if (f.pausedLeft != null) f.pausedLeft += minutes * MIN; else f.endsAt += minutes * MIN;
  if (f.phase === "focus") f.focus += minutes;
  await put(f); await schedule(f);
  return f;
}
// Stop: keeps the minutes you focused so far.
export async function stop(restore) {
  const f = await get();
  if (f.phase === "focus") await log(f, focusedMinutes(f));
  await chrome.alarms.clear("focus-end");
  await put({ phase: "idle", last: { label: f.label, courseId: f.courseId, focus: f.focus, brk: f.brk, preset: f.preset, task: f.task } });
  await badge(null, restore);
}
// Skip ahead: end focus now (go to break) or end the break now.
export async function skip(restore) {
  const f = await get();
  if (f.phase === "focus") return finishPhase(f, restore, { early: true });
  if (f.phase === "break") return finishPhase(f, restore);
  return f;
}

/** Called when the alarm fires (or on skip). Returns the new state and a message for a notification. */
export async function finishPhase(f, restore, { early = false } = {}) {
  f = f || await get();
  let next, note = null;
  if (f.phase === "focus") {
    await log(f, early ? focusedMinutes(f) : f.focus);
    if (f.brk > 0) {
      next = { ...f, phase: "break", endsAt: Date.now() + f.brk * MIN, pausedLeft: null };
      note = { title: early ? "Break time" : `${f.focus} minutes done. Nice work!`, message: `Take ${f.brk} minutes away from the screen. Stretch, get water.` };
    } else {
      next = { ...f, phase: "done", endsAt: null, pausedLeft: null };
      note = { title: `${f.focus} minutes done!`, message: "Keep going? Open StudyPilot to add more time, or stop here. Starting was the hard part." };
    }
  } else if (f.phase === "break") {
    next = { ...f, phase: "done", endsAt: null, pausedLeft: null };
    note = { title: "Break's over", message: f.label ? `Ready for another round of ${f.label}?` : "Ready for another round?" };
  } else return f;
  await put(next); await schedule(next);
  if (next.phase === "done") await badge(null, restore);
  return { state: next, note };
}

export const status = get;

// ---------- the study log ----------
/** Minutes per day for the last `days` days, and per course this week. */
export function summarize(studyLog = [], { now = Date.now(), days = 7 } = {}) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const from = start.getTime() - (days - 1) * 864e5;
  const recent = studyLog.filter((r) => r.at >= from);
  const perDay = Array.from({ length: days }, (_, i) => {
    const d0 = from + i * 864e5;
    return { day: new Date(d0).toISOString().slice(0, 10), date: d0, minutes: recent.filter((r) => r.at >= d0 && r.at < d0 + 864e5).reduce((a, r) => a + r.minutes, 0) };
  });
  const perCourse = {};
  recent.forEach((r) => { const k = r.courseId ?? "other"; perCourse[k] = (perCourse[k] || 0) + r.minutes; });
  let streak = 0;
  for (let i = perDay.length - 1; i >= 0; i--) { if (perDay[i].minutes > 0) streak++; else if (i !== perDay.length - 1) break; }
  return { total: recent.reduce((a, r) => a + r.minutes, 0), sessions: recent.length, perDay, perCourse, streak, today: perDay[perDay.length - 1].minutes };
}
export const fmtMin = (m) => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`;
