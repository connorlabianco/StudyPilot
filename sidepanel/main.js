// StudyPilot side panel: Today · Courses · Practice · Settings.
import { $, state, send, TABS, go, rerender, applyA11y, sync, lecturesFor, openCourse, toast } from "./core.js";
import { restorePending } from "./aiflow.js";
import { openSheet, lectureScope, moduleScope } from "./sheet.js";
import "./views/today.js";
import "./views/courses.js";
import "./views/practice.js";
import "./views/settings.js";
import { icon } from "../lib/icons.js";
import { initFocus } from "./focus.js";
import { openSearch } from "./search.js";

TABS.forEach((t, i) => {
  const tab = $(`#tab-${t}`);
  tab.onclick = () => go(t, t === "courses" && state.tab === "courses" ? { course: null } : {});
  tab.onkeydown = (e) => {
    if (e.key === "ArrowRight") { go(TABS[(i + 1) % TABS.length]); $(`#tab-${state.tab}`).focus(); }
    if (e.key === "ArrowLeft") { go(TABS[(i + TABS.length - 1) % TABS.length]); $(`#tab-${state.tab}`).focus(); }
  };
});
$("#syncBtn").onclick = () => sync();
initFocus();
$("#searchBtn").onclick = () => openSearch();
$("#sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
// After practice, sync soon (signed-in only); after a sync, show fresh data.
let syncSoon = null;
const syncAfter = (ms) => { clearTimeout(syncSoon); syncSoon = setTimeout(async () => {
  if (!state.sync?.account) return;
  try { await send("SYNC_NOW"); state.sync = await send("SYNC_STATUS"); state.bank = null; if ($("#runner").hidden) rerender(); } catch { /* offline: next time */ }
}, ms); };
state.onRunnerClose = () => { rerender(); syncAfter(3000); };

function showProgress(p) {
  const box = $("#progress");
  if (!p) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const pct = p.total ? Math.round((p.done / p.total) * 100) : null;
  box.classList.toggle("indeterminate", pct == null);
  box.querySelector(".fill").style.width = pct == null ? "" : `${Math.max(6, pct)}%`;
  box.querySelector(".label").textContent = p.label + (p.total ? ` · ${p.done}/${p.total}` : "");
}
chrome.storage.session.onChanged.addListener((ch) => {
  if (ch.progress) showProgress(ch.progress.newValue);
  if (ch.queuedLecture?.newValue) handleQueued(ch.queuedLecture.newValue);
});
chrome.storage.local.onChanged.addListener((ch) => {
  if (ch.snapshot) { state.snapshot = ch.snapshot.newValue; if (state.tab === "today" && $("#runner").hidden) rerender(); }
});

// "Practice" buttons on Canvas lecture pages and module headers open the action sheet here.
let lastQueued = 0;
async function handleQueued(q) {
  if (q.at === lastQueued) return;
  lastQueued = q.at;
  await chrome.storage.session.remove("queuedLecture");
  if (Date.now() - q.at > 60e3) return;
  openCourse(q.courseId, "lectures");
  try {
    const all = await lecturesFor(q.courseId).catch(() => []);
    if (q.lecture) {
      const key = `${q.courseId}:${q.lecture.type}:${q.lecture.page_url || q.lecture.file_id}`;
      const found = all.find((l) => l.key === key || (q.lecture.type === "File" ? l.file_id === q.lecture.file_id : l.page_url === q.lecture.page_url));
      await openSheet(lectureScope(q.courseId, found || { ...q.lecture, key }));
    } else if (q.module) {
      const items = all.filter((l) => l.module.trim() === q.module.trim());
      if (!items.length) throw new Error("This module has no lecture pages or slides StudyPilot can read.");
      await openSheet(moduleScope(q.courseId, q.module, items));
    }
  } catch (e) { toast(e.message, { error: true, ms: 8000 }); }
}

document.querySelectorAll("[data-icon]").forEach((el) => el.replaceChildren(icon(el.dataset.icon, el.classList.contains("logo") ? 18 : 20)));

(async () => {
  state.settings = await send("GET_SETTINGS");
  applyA11y();
  ({ snapshot: state.snapshot = null } = await chrome.storage.local.get("snapshot"));
  state.gcal = await send("GCAL_STATUS").catch(() => ({ connected: false }));
  await restorePending();
  state.sync = await send("SYNC_STATUS").catch(() => ({}));
  go("today");
  syncAfter(500);
  // Look for exam dates in courses not checked recently (quietly; Today updates when done).
  if (state.snapshot) send("EXAMS_STALE").then((r) => { if (r?.checked && state.tab === "today" && $("#runner").hidden) rerender(); }).catch(() => {});
  const { queuedLecture, progress } = await chrome.storage.session.get(["queuedLecture", "progress"]);
  if (progress) showProgress(progress);
  if (queuedLecture) handleQueued(queuedLecture);
})();
