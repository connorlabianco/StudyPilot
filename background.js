import { CanvasClient, stripHtml, hash } from "./lib/canvas.js";
import * as lib from "./lib/library.js";
import { allQuestions } from "./lib/quiz.js";
import { formatOf } from "./lib/extract.js";
import { isLocked } from "./lib/safety.js";
import { openWork } from "./lib/packs.js";
import * as gcal from "./lib/gcal.js";
import { parsePlan } from "./lib/planparse.js";
import * as hubApi from "./lib/jupyterhub.js";
import { isGitPullLink, nbToMarkdown, hubFromLink, knownHubs, hubForCourse, nbCellsText, nbProblemText, notebookData, summarizeData, notebookDirs, prettyNotebook } from "./lib/jupyter.js";
import { timeSnippets, weekEvents, mondayOf, addDays, ymd, emptyWeek } from "./lib/schedule.js";
import { planDays, planInfo } from "./lib/planner.js";
import { download, waitForDownload } from "./lib/dl.js";
import { icsBusy } from "./lib/ical.js";
import { parseSyllabusWeights } from "./lib/grades.js";
import * as gs from "./lib/gradescope.js";
import { diffSnapshots, diffExams, addChanges } from "./lib/changes.js";
import * as focusTimer from "./lib/focus.js";
import * as searchLib from "./lib/search.js";
import { collectExams } from "./lib/exams.js";
import * as vids from "./lib/videos.js";
import * as gsync from "./lib/sync.js";

// Keep StudyPilot's downloads in their "StudyPilot/…" folders. Without this, another downloads
// extension or the server's suggested name can override the path and files land loose in Downloads.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id) { suggest(); return; }
  const key = "dl:" + item.url;
  chrome.storage.session.get(key).then((r) => {
    const filename = r[key];
    chrome.storage.session.remove(key);
    if (filename) suggest({ filename, conflictAction: "overwrite" }); else suggest();
  }).catch(() => suggest());
  return true; // we answer asynchronously
});

export const DEFAULT_SETTINGS = {
  canvasUrl: "", canvasToken: "",
  studyStart: "09:00", studyEnd: "22:00", maxHoursPerDay: 4, sessionMinutes: 60, daysAhead: 14, notes: "",
  // Canvas page enhancements
  dashTodo: true, cardBadges: true, darkMode: false, hideDone: true, lectureButtons: true,
  replaceTodo: true, replaceFeedback: true,
  onlyFavorites: true,  // only favorited courses (or dashboard courses when none are starred)
  // Accessibility
  textSize: "normal", highContrast: false, reduceMotion: false, readableFont: false,
  // JupyterHub
  // jupyterHubs: course id → that course's hub address ("none" = the course doesn't use Jupyter).
  // jupyterUrl is the older single-hub setting, still honored for courses that already had folders picked.
  jupyterUrl: "", jupyterHubs: {}, jupyterPullLinks: [], jupyterPullFirst: true,
  // Lecture library: courses synced automatically, and courses whose originals are also mirrored to Downloads
  libraryCourses: [], libraryMirror: [],
  moduleLayout: {}, masteryLevel: {}, // per course: Lectures-tab arrangement; what "mastered" means
  // Calendar feed (private iCal link) for busy times without Google sign-in; courses hidden from StudyPilot
  icalUrl: "", hiddenCourses: [],
  // Canvas look (see lib/look.js); empty = defaults
  look: null,
  // v5: your AI (any chat assistant, by copy and paste), quiz defaults, notebooks per course
  aiProvider: "", aiName: "", aiUrl: "", aiClipboard: true, aiAutofill: true,
  quizCount: 10, quizDifficulty: "mixed",
  jupyterCourseFolders: {},
  gradescopeMap: {},
  videoHost: "", videoFolderMap: {},
  videoSpeedOn: true, videoSpeedMore: false,
  onboarded: false,
};

async function settings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// JupyterHub: only hubs the student connected (for some course) may be opened.
async function checkHub(hub) {
  const s = await settings();
  if (!hub || !knownHubs(s).includes(hub)) throw new Error("Connect this course's JupyterHub first (on the course's Files page).");
  return hub;
}
// The student's own server on that hub, from the last check (checks again if needed).
async function serverFor(hub) {
  const { jupyterState = {} } = await chrome.storage.local.get("jupyterState");
  let st = jupyterState[hub];
  if (!st?.serverBase) {
    st = await hubApi.status(hub);
    if (!st.serverBase) throw new Error(st.state === "login" ? `Log in to ${new URL(hub).host} first.` : "Start your Jupyter server first.");
    jupyterState[hub] = { ...st, checked_at: Date.now() };
    await chrome.storage.local.set({ jupyterState });
  }
  return st.serverBase;
}

async function client() {
  const s = await settings();
  if (!s.canvasUrl) throw new Error("Add your Canvas address in Settings first.");
  return new CanvasClient({ baseUrl: s.canvasUrl, token: s.canvasToken });
}

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const progress = (p) => chrome.storage.session.set({ progress: p });

// ---------- Badge: number of things due in the next 48 hours ----------
async function updateBadge(snapshot) {
  const { focus } = await chrome.storage.local.get("focus");
  if (focus && (focus.phase === "focus" || focus.phase === "break")) return focusTimer.badge(focus); // the timer owns the badge while it runs
  const n = snapshot ? openWork(snapshot, { daysAhead: 2 }).length : 0;
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#e0603d" });
}

// ---------- Downloads ----------
// Windows/macOS-safe single path segment (no slashes, no trailing dots/spaces, no reserved names).
// Rough size of a downloaded lecture recording (for the size warning only).
const VIDEO_BYTES_PER_MIN = 6e6;
let backupPlanCache = null;

// Lecture video files, when the video site offers downloads (instructors can turn that off; those are skipped).
async function downloadVideoFiles(list, onEach = () => {}) {
  const s = await settings();
  let done = 0, notAllowed = 0, failed = 0;
  await progress({ label: "Checking which videos can be downloaded" });
  const allowed = await vids.panoptoDownloadable(s.videoHost, list.map((v) => v.video_id)).catch(() => ({}));
  for (const [i, v] of list.entries()) {
    await progress({ label: `Lecture videos: ${v.title}`, done: i, total: list.length });
    onEach(i, list.length);
    const url = vids.podcastUrl(s.videoHost, v.video_id);
    if (!allowed[v.video_id]) { notAllowed++; continue; }
    try {
      const id = await download(url, `StudyPilot/${safeName(v.course)}/Lecture videos/${v.date ? v.date.slice(0, 10) + " " : ""}${safeName(v.title).slice(0, 80)}.mp4`, { conflictAction: "uniquify" });
      const st = await waitForDownload(id, 6 * 3600e3);
      if (st === "complete") done++; else failed++;
    } catch { failed++; }
  }
  await progress(null);
  return { done, notAllowed, failed, total: list.length };
}

// The student can remove a wrong exam date or add one StudyPilot missed.
function applyExamEdits(courseId, list, edits = {}) {
  const key = (e) => `${e.title}|${e.date.slice(0, 10)}`;
  const removed = new Set(edits.removed || []);
  return [...list.filter((e) => !removed.has(key(e))), ...(edits.added || []).map((e) => ({ ...e, source: "added by you", mine: true }))]
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Does this Canvas course use Gradescope? (a Gradescope tab, Gradescope assignments, or a Gradescope link in modules)
async function courseUsesGradescope(courseId) {
  const { snapshot } = await chrome.storage.local.get("snapshot");
  const course = snapshot?.courses.find((x) => x.id === courseId);
  if ((course?.assignments || []).some((a) => /gradescope/i.test(a.kind_label || ""))) return true;
  const c = await client();
  const tabs = await c.optional(`/courses/${courseId}/tabs`, {}, { all: false }).catch(() => null);
  if ((tabs || []).some((t) => /gradescope/i.test(t.label || ""))) return true;
  const mods = await c.optional(`/courses/${courseId}/modules`, { "include[]": "items", per_page: 50 }).catch(() => null);
  return (mods || []).some((m) => (m.items || []).some((i) => /gradescope/i.test(`${i.title} ${i.external_url || ""} ${i.url || ""}`)));
}
// Which Gradescope course goes with a Canvas course: the student's pick, else a match by code or name.
async function gsLinkFor(courseId, gsCourses) {
  const s = await settings();
  const pick = s.gradescopeMap?.[courseId];
  if (pick === "none") return null;
  if (pick) return gsCourses.find((g) => g.id === pick) || { id: pick, short: "Gradescope course" };
  const { snapshot } = await chrome.storage.local.get("snapshot");
  const course = snapshot?.courses.find((x) => x.id === courseId);
  return course ? gs.matchCourse(course, gsCourses) : null;
}
// Jupyter notebook JSON → readable cells
function notebookText(raw) {
  try {
    const nb = JSON.parse(raw);
    return (nb.cells || []).map((c) => `${c.cell_type === "code" ? "[code]" : "[text]"}\n${[].concat(c.source || []).join("")}`).join("\n\n");
  } catch { return raw; }
}

// ---------- search index (built from what's already stored, plus module titles) ----------
let searchCache = null;
const moduleCache = {};
async function moduleItems(cl, courseId) {
  const m = moduleCache[courseId];
  if (m && Date.now() - m.at < 15 * 60e3) return m.list;
  const list = await cl.lectures(courseId).catch(() => m?.list || []);
  moduleCache[courseId] = { at: Date.now(), list };
  return list;
}
async function searchChunks() {
  if (searchCache && Date.now() - searchCache.at < 60e3) return searchCache;
  const s = await settings();
  const { snapshot, syllabusText = {}, exams = {} } = await chrome.storage.local.get(["snapshot", "syllabusText", "exams"]);
  const hidden = new Set(s.hiddenCourses || []);
  const courses = (snapshot?.courses || []).filter((c) => !hidden.has(c.id));
  const name = (id) => { const c = courses.find((x) => x.id === id); return c ? c.code || c.name : ""; };
  const list = [];
  let docs = 0;
  const cl = await client().catch(() => null);
  let unread = 0;
  for (const c of courses) {
    const cdocs = await lib.docsForCourse(c.id).catch(() => []);
    for (const d of cdocs) { docs++; list.push(...searchLib.docChunks(d, { course: c.code || c.name })); }
    // Module items StudyPilot hasn't read yet are still findable by title and module name.
    const items = cl ? await moduleItems(cl, c.id) : [];
    const have = new Set(cdocs.map((d) => d.key));
    for (const l of items) if (!have.has(l.doc_key)) { unread++; list.push({ kind: "Module", courseId: c.id, course: c.code || c.name, title: l.title, url: l.url, where: l.module, key: l.doc_key, text: `${l.title}\n${l.module}` }); }
  }
  const visible = { ...snapshot, courses, announcements: (snapshot?.announcements || []).filter((a) => !hidden.has(a.course_id)) };
  const syl = Object.fromEntries(Object.entries(syllabusText).filter(([id]) => !hidden.has(Number(id))));
  const examList = courses.flatMap((c) => (exams[c.id]?.list || []).map((e) => ({ ...e, courseId: c.id, course: c.code || c.name })));
  const questions = (await allQuestions().catch(() => [])).filter((q) => !hidden.has(q.courseId));
  list.push(...searchLib.otherChunks({ snapshot: visible, syllabus: syl, exams: examList, questions, courseName: name }));
  searchCache = { at: Date.now(), list, stats: { unread, docs, syllabi: Object.keys(syl).length, chunks: list.length, courses: courses.length } };
  return searchCache;
}

// ---------- focus timer helpers ----------
const restoreBadge = async () => updateBadge((await chrome.storage.local.get("snapshot")).snapshot);
const tickAlarm = (on) => on ? chrome.alarms.create("focus-tick", { periodInMinutes: 1 }) : chrome.alarms.clear("focus-tick");
async function focusNotify(note) {
  if (!note) return;
  if ((await settings()).focusNotify === false || !(await chrome.permissions.contains({ permissions: ["notifications"] }).catch(() => false))) return;
  chrome.notifications.create(`sp-focus-${Date.now()}`, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title: note.title, message: note.message, priority: 2, requireInteraction: false }).catch?.(() => {});
}

// ---------- change alerts ----------
async function recordChanges(fresh) {
  if (!fresh?.length) return;
  const { changes = [] } = await chrome.storage.local.get("changes");
  await chrome.storage.local.set({ changes: addChanges(changes, fresh) });
  const s = await settings();
  if (s.alertsNotify === false || !(await chrome.permissions.contains({ permissions: ["notifications"] }).catch(() => false))) return;
  const important = fresh.filter((c) => c.important || (s.alertsGrades && /grade/.test(c.kind)));
  if (!important.length) return;
  const one = important[0];
  chrome.notifications.create(`sp-change-${Date.now()}`, {
    type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), priority: 1,
    title: important.length === 1 ? `${one.course}: ${one.title}` : `${important.length} changes in your courses`,
    message: important.length === 1 ? one.detail : important.slice(0, 3).map((c) => `${c.course}: ${c.title} (${c.detail})`).join("\n"),
  }).catch?.(() => {});
}

// What's been turned in on Gradescope, per Canvas course, so "Overdue" isn't shown for work that was handed in there.
async function rememberTurnedIn(courseId, list) {
  const { gsSubmitted = {}, snapshot } = await chrome.storage.local.get(["gsSubmitted", "snapshot"]);
  gsSubmitted[courseId] = { at: Date.now(), keys: gs.turnedIn(list) };
  await chrome.storage.local.set({ gsSubmitted });
  if (snapshot) { gs.applyTurnedIn(snapshot, gsSubmitted); gs.applyMarked(snapshot, (await settings()).doneItems); await chrome.storage.local.set({ snapshot }); await updateBadge(snapshot); }
}
// In the background (at most every 3 hours): re-check courses that have Gradescope work due soon or past due
// and not turned in according to Canvas. Only when Gradescope is connected and logged in.
async function checkTurnedIn() {
  const { snapshot, gsSubmitted = {}, gsCheckAt = 0 } = await chrome.storage.local.get(["snapshot", "gsSubmitted", "gsCheckAt"]);
  if (!snapshot || Date.now() - gsCheckAt < 3 * 3600e3 || !(await gs.hasGsPermission())) return;
  const map = (await settings()).gradescopeMap || {};
  const usesGs = (c) => map[c.id] ? map[c.id] !== "none" : c.assignments.some((a) => /gradescope/i.test(a.kind_label || ""));
  const soon = (a) => a.due_at && !a.submitted && (a.kind === "tool" || a.kind === "offline") && Math.abs(Date.parse(a.due_at) - Date.now()) < 7 * 864e5;
  const ids = snapshot.courses.filter((c) => usesGs(c) && c.assignments.some(soon)).map((c) => c.id);
  await chrome.storage.local.set({ gsCheckAt: Date.now() });
  if (!ids.length) return;
  const st = await gs.status().catch(() => null);
  if (st?.state !== "ok") return;
  for (const id of ids) {
    const link = await gsLinkFor(id, st.courses);
    if (!link) continue;
    const list = await gs.assignments(link.id).catch(() => null);
    if (list) await rememberTurnedIn(id, list.assignments);
  }
}

// For backups: Canvas courses that have a Gradescope course, if Gradescope is connected and logged in.
async function gsLinkedCourses(courseIds) {
  if (!(await gs.hasGsPermission())) return [];
  const st = await gs.status().catch(() => null);
  if (st?.state !== "ok") return [];
  const out = [];
  for (const id of courseIds) { const l = await gsLinkFor(id, st.courses); if (l) out.push({ courseId: id, gsId: l.id }); }
  return out;
}

const safeName = (s) => {
  let n = String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "").slice(0, 100);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = "_" + n;
  return n || "file";
};

// Remembers what was downloaded (by Canvas file id / Jupyter path + version) so repeat runs
// only fetch new or changed files. A file you deleted from Downloads is fetched again.
async function downloadAll(files, label, { onlyNew = true } = {}) {
  const { downloadIndex = {} } = await chrome.storage.local.get("downloadIndex");
  let done = 0, failed = 0, skipped = 0, i = 0;
  for (const f of files) {
    i++;
    const path = ["StudyPilot", safeName(f.course), ...String(f.folder || "").split("/").filter(Boolean).map(safeName), safeName(f.name)].join("/");
    const prev = f.key ? downloadIndex[f.key] : null;
    if (onlyNew && prev && prev.version === f.version && prev.path === path && await stillOnDisk(prev.id)) {
      skipped++;
    } else {
      try {
        const id = await download(f.url, path);
        if (f.key) downloadIndex[f.key] = { version: f.version, path, id, at: Date.now() };
        done++;
      } catch { failed++; }
    }
    if (i % 10 === 0 || i === files.length) await progress({ label, done: i, total: files.length });
  }
  await chrome.storage.local.set({ downloadIndex });
  return { done, skipped, failed };
}

async function stillOnDisk(downloadId) {
  if (downloadId == null) return false;
  const [item] = await chrome.downloads.search({ id: downloadId }).catch(() => []);
  return !!(item && item.exists && item.state !== "interrupted");
}


// ---------- Lecture library ----------
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html", reasons: ["DOM_PARSER"],
    justification: "Read text, diagrams and handwritten pages from lecture PDFs and slides",
  }).catch((e) => { if (!/single offscreen|already/i.test(e.message)) throw e; });
}

async function readFileRemote(file) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "EXTRACT", payload: { url: file.url, name: file.name, mime: file.type } });
  if (!r?.ok) throw new Error(r?.error || "couldn't read the file");
  return r.data;
}

const fileMeta = (f) => ({ id: f.id, name: f.display_name, url: f.url, size: f.size, type: f["content-type"] || "" });
const docKey = (courseId, l) => l.doc_key || (l.type === "Page" ? `${courseId}:P:${l.page_url}` : l.type === "Video" ? `${courseId}:V:${l.video_id}` : `${courseId}:F:${l.file_id}`);


// ---------- JupyterHub notebooks as lectures ----------
const pathKey = (p) => { let h = 2166136261; for (let i = 0; i < p.length; i++) { h ^= p.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
/** The course's lecture notebooks (folders sorted as lecture material), from the last look at its hub. */
async function hubLectures(courseId) {
  const s = await settings();
  const hub = hubForCourse(s, courseId);
  const folders = (s.jupyterCourseFolders || {})[courseId] || [];
  if (!hub || hub === "none" || !folders.length) return [];
  const { jupyterScans = {} } = await chrome.storage.local.get("jupyterScans");
  const files = jupyterScans[hub]?.files || [];
  const dirs = notebookDirs(files, folders, (s.jupyterKinds || {})[courseId] || {});
  const out = [];
  let i = 0;
  for (const [dir, g] of Object.entries(dirs)) {
    if (g.kind !== "lecture") continue;
    for (const f of g.notebooks.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))) {
      const key = `${courseId}:J:${pathKey(f.path)}`;
      out.push({ key, doc_key: key, course_id: courseId, title: prettyNotebook(f.path), module: "From JupyterHub", module_id: "jhub", module_index: 100000,
        position: i++, type: "Notebook", is_lecture: true, hub, path: f.path, date: f.last_modified || null, url: `${hub}/hub/user-redirect/lab/tree/${f.path.split("/").map(encodeURIComponent).join("/")}` });
    }
  }
  return out;
}
/** Homework notebooks (folders sorted as assignments): problem text and data descriptions, for the study plan. */
async function hubHomework(courseId) {
  const s = await settings();
  const hub = hubForCourse(s, courseId);
  const folders = (s.jupyterCourseFolders || {})[courseId] || [];
  if (!hub || hub === "none" || !folders.length) return { hub: null, notebooks: [], files: [] };
  const { jupyterScans = {} } = await chrome.storage.local.get("jupyterScans");
  const files = jupyterScans[hub]?.files || [];
  const dirs = notebookDirs(files, folders, (s.jupyterKinds || {})[courseId] || {});
  return { hub, files, notebooks: Object.values(dirs).filter((g) => g.kind === "assignment").flatMap((g) => g.notebooks) };
}
// Reads a lecture notebook: its cells (numbered like slides), plots as attachable figures, and a short description
// of each data file it uses (columns, types, first rows), read with the student's own hub login.
async function ensureNotebook(courseId, l, existing) {
  const hub = await checkHub(l.hub);
  if (existing?.version === (l.date || "") && existing.text) return existing;
  const server = await serverFor(hub);
  const [r] = await hubApi.readFiles(hub, server, [l.path]);
  if (!r || r.skipped || !r.notebook) throw new Error(`Couldn't read ${l.path} on JupyterHub${r?.skipped ? ` (${r.skipped})` : ""}.`);
  const figures = [];
  const base = l.path.split("/").pop().replace(/\.ipynb$/i, "");
  let figBytes = 0;
  const figure = (cell, k, mime, data) => {
    if (figures.length >= 12 || figBytes + data.length > 6e6) return null;
    const name = `${base} - cell ${cell}${k > 1 ? `.${k}` : ""}.${mime === "image/png" ? "png" : "jpg"}`;
    figures.push({ name, url: `data:${mime};base64,${data.replace(/\s+/g, "")}`, size: Math.round(data.length * 0.75) });
    figBytes += data.length;
    return name;
  };
  const { text, cells } = nbCellsText(r.content, { figure });
  const { jupyterScans = {} } = await chrome.storage.local.get("jupyterScans");
  const data = notebookData(r.content, l.path, jupyterScans[hub]?.files || []);
  const heads = await hubApi.readHeads(hub, server, data.filter((f) => /\.(csv|tsv|txt|json|geojson)$/i.test(f.path)).map((f) => f.path)).catch(() => ({}));
  const dataText = data.map((f) => summarizeData(f, heads[f.path] || "")).join("\n\n");
  const doc = { key: docKey(courseId, l), course_id: courseId, kind: "notebook", title: l.title, module: l.module, version: l.date || r.last_modified || "",
    text: text + (dataText ? `\n\n--- Data files used ---\n${dataText}` : ""), cells, figures, url: l.url, hub, path: l.path, visual: figures.length > 0 };
  await lib.putDoc(doc);
  return doc;
}

// Transcripts for videos inside a Canvas page: Canvas's own media captions, and Panopto embeds (if connected).
async function pageVideoText(c, body) {
  const parts = [];
  const { mediaIds, attachmentIds } = vids.canvasMediaIn(body);
  const tracks = async (path) => {
    const list = await c.optional(path, { "include[]": "content" }, { all: false }).catch(() => null);
    const t = (list || []).find((x) => /^en/i.test(x.locale || "")) || (list || [])[0];
    return t?.content ? vids.captionsToText(t.content) : "";
  };
  for (const id of mediaIds) { const t = await tracks(`/media_objects/${id}/media_tracks`); if (t) parts.push(t); }
  for (const id of attachmentIds) { const t = await tracks(`/media_attachments/${id}/media_tracks`); if (t) parts.push(t); }
  const pano = vids.panoptoLinksIn(body);
  const s = await settings();
  const hosts = [...new Set(pano.map((p) => p.host))].filter((h) => h === s.videoHost);
  for (const host of hosts) {
    const caps = await vids.panoptoCaptions(host, pano.filter((p) => p.host === host).map((p) => p.id).slice(0, 5)).catch(() => ({}));
    for (const raw of Object.values(caps)) if (raw) parts.push(vids.captionsToText(raw));
  }
  return parts.length ? `\n\n[Video transcript]\n${parts.join("\n\n[Next video]\n")}` : "";
}

// Reads one lecture into the library if it's new or changed; returns the doc (with fresh download links).
async function ensureLecture(c, courseId, l) {
  const key = docKey(courseId, l);
  const existing = await lib.getDoc(key);

  if (l.type === "Notebook") return ensureNotebook(courseId, l, existing);
  if (l.type === "Video") {
    if (existing?.text) return existing;
    const caps = await vids.panoptoCaptions(l.host, [l.video_id]);
    const text = vids.captionsToText(caps[l.video_id]);
    if (!text) throw new Error(`"${l.title}" has no captions yet, so StudyPilot can't read it.`);
    const doc = { key, course_id: courseId, kind: "page", video: true, title: l.title, module: l.module || "Lecture videos", version: l.video_id,
      text: `Transcript of the recorded lecture "${l.title}"${l.date ? ` (${new Date(l.date).toLocaleDateString()})` : ""}:\n\n${text}`, images: [], visual: false, url: l.url };
    await lib.putDoc(doc);
    return doc;
  }

  if (l.type === "Page") {
    const p = await c.page(courseId, l.page_url);
    if (!p || isLocked(p)) throw new Error(`"${l.title}" is locked`);
    const body = p.body || "";
    const version = p.updated_at || hash(body);
    // Images embedded in the page (diagrams pasted into Canvas pages)
    const ids = [...new Set([...body.matchAll(/\/files\/(\d+)/g)].map((m) => Number(m[1])))]
      .filter((id) => new RegExp(`<img[^>]+/files/${id}\\b`).test(body)).slice(0, 15);
    const images = (await Promise.all(ids.map((id) => c.file(id).catch(() => null))))
      .filter((f) => f && !f.locked_for_user && /^image\//.test(f["content-type"] || "")).map(fileMeta);
    if (existing?.version === version) return { ...existing, images };
    const videoText = await pageVideoText(c, body).catch(() => "");
    const doc = { key, course_id: courseId, kind: "page", title: p.title || l.title, module: l.module || "", version,
      text: stripHtml(body) + videoText, images: images.map(({ id, name, size, type }) => ({ id, name, size, type })), visual: images.length > 0, url: p.html_url };
    await lib.putDoc(doc);
    return { ...doc, images };
  }

  const f = await c.file(l.file_id);
  if (!f || f.locked_for_user) throw new Error(`"${l.title}" is locked`);
  const file = fileMeta(f);
  const version = `${f.modified_at || f.updated_at || ""}|${f.size}`;
  if (existing?.version === version && !existing.analysis?.error) return { ...existing, file };
  let analysis;
  try { analysis = await readFileRemote(file); } catch (e) { analysis = { error: e.message }; }
  const doc = {
    key, course_id: courseId, kind: "file", title: l.title || file.name, module: l.module || "", version,
    format: formatOf(file.name, file.type), file: { id: file.id, name: file.name, size: file.size, type: file.type },
    analysis, visual: analysis.error ? true : !!analysis.visual, url: l.url || null,
  };
  await lib.putDoc(doc);
  return { ...doc, file };
}

async function syncLibraryCourse(c, courseId, label) {
  const lectures = await c.lectures(courseId);
  let done = 0, failed = 0;
  for (const l of lectures) {
    await progress({ label, done, total: lectures.length });
    try { await ensureLecture(c, courseId, l); } catch { failed++; }
    done++;
  }
  return { lectures: lectures.length, failed, list: lectures };
}


// ---------- Zips: one archive per course / folder ----------
async function zipCall(type, payload) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: "offscreen", type, payload });
  if (!r?.ok) throw new Error(r?.error || "zip error");
  return r;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Builds StudyPilot/<name>.zip. items: [{path, url}|{path, text}], plus optional `extra(add)` for streamed sources.
 * Files that can't be fetched are listed in "_Not included.txt" inside the zip and returned in `failed`.
 */
async function buildZip(name, items, { label = "Zipping", extra = null, note = "", saveAs = false } = {}) {
  const id = crypto.randomUUID();
  await zipCall("ZIP_START", { id });
  const failed = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (i % 3 === 0) await progress({ label, done: i, total: items.length });
      try {
        if (it.text != null) await zipCall("ZIP_ADD_TEXT", { id, path: it.path, text: it.text });
        else await zipCall("ZIP_ADD_URL", { id, path: it.path, url: it.url, date: it.date });
        it.ok = true;
      } catch (e) { failed.push({ ...it, error: e.message }); }
    }
    if (extra) failed.push(...(await extra(id)));
    const listed = failed.filter((f) => f.path);
    if (listed.length || note) {
      await zipCall("ZIP_ADD_TEXT", { id, path: "_Not included.txt", text:
        (note ? note + "\n\n" : "") +
        (listed.length ? "These files couldn't be added to this zip:\n\n" + listed.map((f) => `- ${f.path}: ${f.error}`).join("\n") : "") });
    }
    const { url, size, count } = await zipCall("ZIP_FINISH", { id });
    await progress({ label: "Saving zip…" });
    const dlId = await download(url, `StudyPilot/${safeName(name)}.zip`, { conflictAction: "uniquify", saveAs });
    const state = await waitForDownload(dlId, saveAs ? 60 * 60e3 : undefined);
    zipCall("ZIP_REVOKE", { url }).catch(() => {});
    if (state === "interrupted" && saveAs) throw new Error("Backup not saved (the save window was closed).");
    if (state !== "complete") throw new Error("Chrome couldn't save the zip");
    return { name: `${safeName(name)}.zip`, size, count, failed, downloadId: dlId };
  } catch (e) {
    zipCall("ZIP_ABORT", { id }).catch(() => {});
    throw e;
  }
}

// Remembers what went into earlier zips so "only what's new" zips skip unchanged files.
async function zipIndex() { return (await chrome.storage.local.get("zipIndex")).zipIndex || {}; }
async function saveZipIndex(idx) { await chrome.storage.local.set({ zipIndex: idx }); }


// Course files + my submissions → "StudyPilot/<course> - files - <date>.zip" (one per course).
// Anything the zip builder can't fetch is downloaded loose into a clearly named folder instead.
async function zipCourseFiles(files, { onlyNew = true } = {}) {
  const idx = await zipIndex();
  const byCourse = new Map();
  let skipped = 0;
  for (const f of files) {
    if (onlyNew && f.key && idx[f.key] === f.version) { skipped++; continue; }
    if (!byCourse.has(f.course)) byCourse.set(f.course, []);
    byCourse.get(f.course).push(f);
  }
  const zips = [];
  let done = 0, failed = 0;
  for (const [course, list] of byCourse) {
    const items = list.map((f) => ({ ...f, path: `${f.folder || ""}/${f.name}` }));
    const z = await buildZip(`${course} - files - ${today()}${onlyNew && Object.keys(idx).length ? " (new & changed)" : ""}`, items, { label: `Zipping ${course}` });
    for (const it of items) if (it.ok && it.key) idx[it.key] = it.version;
    done += z.count - (z.failed.length ? 1 : 0);
    if (z.failed.length) {
      const loose = z.failed.filter((x) => x.url).map((x) => ({ ...x, course: `${course} - files not in zip` }));
      const r = await downloadAll(loose, `Downloading ${loose.length} files separately`, { onlyNew: false });
      failed += r.failed;
      for (const x of loose) if (x.key) idx[x.key] = x.version;
    }
    zips.push(z.name);
  }
  await saveZipIndex(idx);
  return { done, skipped, failed, zips };
}

// ---------- Actions ----------
const actions = {
  async GET_SETTINGS() { return settings(); },

  // ---------- to-do: mark an item done (or undo) ----------
  async MARK_DONE({ courseId, assignmentId, done = true }) {
    const s = await settings();
    const doneItems = { ...(s.doneItems || {}) };
    const key = `${courseId}:${assignmentId}`;
    if (done) doneItems[key] = Date.now(); else delete doneItems[key];
    // forget marks older than 6 months
    for (const [k, at] of Object.entries(doneItems)) if (Date.now() - at > 180 * 864e5) delete doneItems[k];
    await chrome.storage.local.set({ settings: { ...s, doneItems, settingsUpdatedAt: Date.now() } });
    const { snapshot } = await chrome.storage.local.get("snapshot");
    if (snapshot) { gs.applyMarked(snapshot, doneItems); await chrome.storage.local.set({ snapshot }); await updateBadge(snapshot); }
    return true;
  },

  // ---------- the actual material behind each assignment (for plans and AI help) ----------
  // For each assignment: the files linked in its instructions (homework PDFs, lab files, data sets), read into text.
  // Read-only, skips locked files, caps sizes so a request stays a sensible length.
  async ASSIGNMENT_MATERIALS({ items = [], perFile = 9000, total = 60000 } = {}) {
    const c = await client();
    const out = {};
    let used = 0;
    for (const { courseId, id } of items.slice(0, 12)) {
      const a = await c.optional(`/courses/${courseId}/assignments/${id}`, {}, { all: false }).catch(() => null);
      if (!a || a.locked_for_user || a.is_quiz_assignment || (a.submission_types || []).includes("online_quiz")) continue; // never quizzes or locked work
      const html = a.description || "";
      const ids = [...new Set([...html.matchAll(/\/files\/(\d+)/g)].map((m) => Number(m[1])))].slice(0, 6);
      const files = [];
      for (const fid of ids) {
        const f = (await c.optional(`/courses/${courseId}/files/${fid}`, {}, { all: false }).catch(() => null)) || (await c.file(fid).catch(() => null));
        if (!f || f.locked_for_user) { files.push({ name: f?.display_name || `file ${fid}`, skipped: f?.locked_for_user ? "locked" : "not available" }); continue; }
        const meta = fileMeta(f);
        let text = "", note = "";
        if (used < total) {
          try {
            const r = await readFileRemote(meta);
            text = r.text || "";
            if (/\.ipynb$/i.test(meta.name)) text = notebookText(text);
            if (/\.(csv|tsv)$/i.test(meta.name)) { const lines = text.split("\n"); text = lines.slice(0, 16).join("\n") + (lines.length > 16 ? `\n… (${lines.length - 1} rows in total)` : ""); }
            if (!text.trim() && r.visual) note = "handwritten or image-only; attached as a file instead";
          } catch (e) { note = e.message; }
        }
        text = text.replace(/\n{3,}/g, "\n\n").trim().slice(0, Math.min(perFile, Math.max(0, total - used)));
        used += text.length;
        files.push({ name: meta.name, url: meta.url, type: meta.type, size: meta.size, text, note });
      }
      out[`${courseId}:${id}`] = { files };
    }
    return out;
  },

  // Re-check Gradescope right now (for plans), so turned-in work isn't planned again.
  async GS_RECHECK() { await chrome.storage.local.set({ gsCheckAt: 0 }); await checkTurnedIn().catch(() => {}); return (await chrome.storage.local.get("snapshot")).snapshot; },

  // ---------- search across everything ----------
  async SEARCH({ q, courseId = null, limit = 40, fresh = false }) {
    if (fresh) searchCache = null;
    const chunks = await searchChunks();
    const results = searchLib.search(chunks.list, q, { courseId, limit });
    return { results, stats: chunks.stats };
  },

  // ---------- focus timer ----------
  async FOCUS_START(opts) { const f = await focusTimer.start(opts); tickAlarm(true); return f; },
  async FOCUS_PAUSE() { return focusTimer.pause(); },
  async FOCUS_RESUME() { return focusTimer.resume(); },
  async FOCUS_EXTEND({ minutes = 5 } = {}) { const f = await focusTimer.extend(minutes); tickAlarm(true); return f; },
  async FOCUS_STOP() { await focusTimer.stop(restoreBadge); tickAlarm(false); return true; },
  async FOCUS_SKIP() { const r = await focusTimer.skip(restoreBadge); await focusNotify(r?.note); tickAlarm(r?.state?.phase === "break"); return r?.state || r; },

  async SAVE_SETTINGS(patch) {
    const s = { ...(await settings()), ...patch, settingsUpdatedAt: Date.now() };
    await chrome.storage.local.set({ settings: s });
    return s;
  },

  async SYNC() {
    const c = await client();
    const snapshot = await c.snapshot({ onlyFavorites: (await settings()).onlyFavorites !== false });
    const { gsSubmitted = {}, snapshot: prev } = await chrome.storage.local.get(["gsSubmitted", "snapshot"]);
    gs.applyTurnedIn(snapshot, gsSubmitted);
    gs.applyMarked(snapshot, (await settings()).doneItems);
    await chrome.storage.local.set({ snapshot });
    const hidden = new Set((await settings()).hiddenCourses || []);
    await recordChanges(diffSnapshots(prev, snapshot).filter((c) => !hidden.has(c.courseId))).catch(() => {});
    await updateBadge(snapshot);
    return snapshot;
  },

  // Full announcements for the in-Canvas expanded view (longer history, full text).
  async ANNOUNCEMENTS_FULL({ days = 120 } = {}) {
    const s = await settings();
    const { snapshot } = await chrome.storage.local.get("snapshot");
    const ids = (snapshot?.courses || []).map((c) => c.id).filter((id) => !(s.hiddenCourses || []).includes(id));
    if (!ids.length) return [];
    const list = await (await client()).announcements(ids, days);
    return list.map((a) => ({
      id: a.id, course_id: Number(String(a.context_code).replace("course_", "")),
      title: a.title, posted_at: a.posted_at, url: a.html_url, unread: a.read_state === "unread",
      author: a.author?.display_name || a.user_name || "", message: stripHtml(a.message || "").slice(0, 8000),
    })).sort((a, b) => Date.parse(b.posted_at) - Date.parse(a.posted_at));
  },

  async SCAN({ courseIds }) {
    const c = await client();
    const out = {};
    let i = 0;
    for (const id of courseIds) {
      await progress({ label: "Checking what's in your courses", done: i++, total: courseIds.length });
      out[id] = await c.scanCourse(id).catch((e) => ({ error: e.message }));
    }
    await progress(null);
    return out;
  },

  // want: {syllabus, assignments, modules, pages, discussions, announcements, files, myFiles}
  // mode: "new" = only what changed since this course's last export, "all" = everything.
  async EXPORT({ courseIds, want, mode = "new" }) {
    const c = await client();
    const { snapshot, exportIndex = {} } = await chrome.storage.local.get(["snapshot", "exportIndex"]);
    const names = Object.fromEntries((snapshot?.courses || []).map((x) => [x.id, x.code || x.name]));
    const contents = [];
    const toDownload = [];
    let i = 0;
    for (const id of courseIds) {
      i++;
      const label = `Reading ${names[id] || "course"} (${i}/${courseIds.length})`;
      await progress({ label, done: i - 1, total: courseIds.length });
      const last = exportIndex[id];
      const prev = mode === "new" && last ? last.fp : {};
      const content = await c.courseContent(id, want, (part) => progress({ label: `${label}: ${part}`, done: i - 1, total: courseIds.length }), prev);
      content.since = mode === "new" && last ? last.at : null;
      contents.push(content);
      // Merge so categories not chosen this time keep their earlier fingerprints.
      exportIndex[id] = { at: new Date().toISOString(), fp: { ...(last?.fp || {}), ...content.fp } };
      if (want.files) toDownload.push(...(await c.collectFiles(id)).list.map((f) => ({ ...f, course: names[id] || id, folder: ["Course files", f.folder].filter(Boolean).join("/") })));
      if (want.myFiles) toDownload.push(...(await c.myFiles(id)).map((f) => ({ ...f, course: names[id] || id })));
    }
    let downloads = null;
    if (toDownload.length) downloads = await zipCourseFiles(toDownload, { onlyNew: mode === "new" });
    await chrome.storage.local.set({ exportIndex });
    await progress(null);
    contents.forEach((x) => delete x.fp);
    return { contents, downloads, mode };
  },

  async EXPORT_HISTORY() {
    const { exportIndex = {} } = await chrome.storage.local.get("exportIndex");
    return Object.fromEntries(Object.entries(exportIndex).map(([id, v]) => [id, v.at]));
  },

  async RESET_HISTORY() {
    await chrome.storage.local.remove(["exportIndex", "downloadIndex", "jupyterSent", "packIndex", "zipIndex"]);
    return true;
  },

  // ---------- Library ----------
  async LIBRARY_ENSURE({ courseId, lectures }) {
    const c = await client();
    const out = [];
    for (let i = 0; i < lectures.length; i++) {
      await progress({ label: `Reading ${lectures[i].title}`, done: i, total: lectures.length });
      try { out.push(await ensureLecture(c, courseId, lectures[i])); }
      catch (e) { out.push({ key: docKey(courseId, lectures[i]), title: lectures[i].title, error: e.message }); }
    }
    await progress(null);
    searchCache = null;
    return out;
  },

  async LIBRARY_SYNC({ courseIds } = {}) {
    searchCache = null;
    const s = await settings();
    const ids = courseIds || s.libraryCourses;
    const c = await client();
    const { snapshot, libraryMeta = {} } = await chrome.storage.local.get(["snapshot", "libraryMeta"]);
    const names = Object.fromEntries((snapshot?.courses || []).map((x) => [x.id, x.code || x.name]));
    const results = {};
    try {
      for (const id of ids) {
        const r = await syncLibraryCourse(c, id, `Saving lectures: ${names[id] || "course"}`);
        if (s.libraryMirror.includes(id)) {
          const files = [];
          for (const l of r.list.filter((x) => x.type === "File")) {
            const f = await c.file(l.file_id).catch(() => null);
            if (f && !f.locked_for_user) files.push({ ...fileMeta(f), course: names[id] || id, folder: `Lectures/${l.module}`, key: `f:${f.id}`, version: `${f.modified_at || f.updated_at || ""}|${f.size}` });
          }
          r.mirrored = await downloadAll(files, `Updating copies in Downloads: ${names[id] || "course"}`);
        }
        delete r.list;
        results[id] = r;
        libraryMeta[id] = { at: Date.now(), ...r };
      }
    } finally {
      await chrome.storage.local.set({ libraryMeta });
      await progress(null);
    }
    return results;
  },

  // Everything needed to write a Project pack: course overview + every lecture (read into the library first).
  async PROJECT_DATA({ courseIds }) {
    const c = await client();
    const { snapshot } = await chrome.storage.local.get("snapshot");
    const names = Object.fromEntries((snapshot?.courses || []).map((x) => [x.id, x.code || x.name]));
    const out = [];
    try {
      for (const id of courseIds) {
        const label = `Preparing ${names[id] || "course"}`;
        await progress({ label: `${label}: overview` });
        const overview = await c.courseContent(id, { syllabus: true, assignments: true, modules: true, discussions: true, announcements: true }, () => {}, {});
        delete overview.fp;
        const lectures = await c.lectures(id);
        const docs = [];
        for (let i = 0; i < lectures.length; i++) {
          await progress({ label: `${label}: reading lectures`, done: i, total: lectures.length });
          try { docs.push({ lecture: lectures[i], doc: await ensureLecture(c, id, lectures[i]) }); }
          catch (e) { docs.push({ lecture: lectures[i], error: e.message }); }
        }
        out.push({ id, name: names[id] || overview.name, overview, docs });
      }
    } finally { await progress(null); }
    return out;
  },

  // courses: [{ name, howto, files: [{path, text} | {path, url, key, version}] }] → one zip per course
  async PROJECT_ZIP({ courses, onlyNew = true }) {
    const idx = await zipIndex();
    const results = [];
    try {
      for (const c of courses) {
        const changed = c.files.filter((f) => {
          const k = f.key || `pm:${c.name}:${f.path}`;
          const v = f.version || hash(f.text || "");
          return !(onlyNew && idx[k] === v);
        });
        if (!changed.length) { results.push({ course: c.name, unchanged: true }); continue; }
        const items = [{ path: "How to use these files.md", text: c.howto }, ...changed];
        const z = await buildZip(`Project - ${c.name} - ${today()}${onlyNew && changed.length < c.files.length ? " (new & changed)" : ""}`, items, { label: `Zipping ${c.name}` });
        for (const f of changed) if (f.ok) idx[f.key || `pm:${c.name}:${f.path}`] = f.version || hash(f.text || "");
        results.push({ course: c.name, zip: z.name, files: z.count, failed: z.failed.length, unchangedFiles: c.files.length - changed.length, downloadId: z.downloadId });
      }
    } finally { await saveZipIndex(idx); await progress(null); }
    return results;
  },

  // Any list of Canvas files → one zip per course (used by the action sheet's Download).
  async ZIP_FILES({ files, onlyNew = true }) {
    try { return await zipCourseFiles(files, { onlyNew }); } finally { await progress(null); }
  },

  // A course's files and/or my own submissions → that course's zip.
  async COURSE_FILES_ZIP({ courseId, courseFiles = true, mine = false, onlyNew = true, estimate = false }) {
    const c = await client();
    const { snapshot } = await chrome.storage.local.get("snapshot");
    const course = snapshot?.courses.find((x) => x.id === courseId);
    const name = course?.code || course?.name || String(courseId);
    const list = [];
    try {
      await progress({ label: `Listing ${name} files` });
      if (courseFiles) list.push(...(await c.collectFiles(courseId)).list.map((f) => ({ ...f, course: name, folder: ["Course files", f.folder].filter(Boolean).join("/") })));
      if (mine) list.push(...(await c.myFiles(courseId)).map((f) => ({ ...f, course: name })));
      if (!list.length) return { zips: [], done: 0, skipped: 0, failed: 0, empty: true, bytes: 0, count: 0 };
      if (estimate) {
        const idx = await zipIndex();
        const todo = onlyNew ? list.filter((f) => !(f.key && idx[f.key] === f.version)) : list;
        return { bytes: todo.reduce((n, f) => n + (f.size || 0), 0), count: todo.length };
      }
      return await zipCourseFiles(list, { onlyNew });
    } finally { await progress(null); }
  },

  // Grades + where the weights come from: Canvas groups, else the Syllabus tab, else syllabus pages/files (PDF, Word).
  // Everything from the chosen courses in one zip, laid out like Canvas (modules, sections, files, pages,
  // assignments, announcements, syllabus) plus my submissions and grades. Chrome asks where to save it.
  async FULL_BACKUP({ courseIds, estimate = false, transcripts = true, videoFiles = false }) {
    const c = await client();
    const { snapshot } = await chrome.storage.local.get("snapshot");
    const key = JSON.stringify([...courseIds].sort());
    let plans = backupPlanCache?.key === key && Date.now() - backupPlanCache.at < 15 * 60e3 ? backupPlanCache.plans : null;
    try {
      if (!plans) {
        plans = [];
        for (const [i, id] of courseIds.entries()) {
          const course = snapshot?.courses.find((x) => x.id === id);
          const label = course?.code || course?.name || String(id);
          const root = safeName(`${course?.code && course.code !== course.name ? course.code + " - " : ""}${course?.name || id}`).slice(0, 80);
          const plan = await c.backupPlan(id, root, (msg) => progress({ label: `${label}: ${msg}`, done: i, total: courseIds.length }));
          let videos = [];
          try { const v = await actions.VIDEOS({ courseId: id }); if (v.state === "ok") videos = v.videos; } catch { /* no video site */ }
          plans.push({ ...plan, root, label, courseId: id, videos });
        }
        backupPlanCache = { key, at: Date.now(), plans };
      }
      const fileBytes = plans.reduce((n, p) => n + p.items.reduce((m, it) => m + (it.size || 0), 0), 0);
      const videoMinutes = plans.reduce((n, p) => n + p.videos.reduce((m, v) => m + (v.minutes || 0), 0), 0);
      const videoCount = plans.reduce((n, p) => n + p.videos.length, 0);
      if (estimate) return { bytes: fileBytes, items: plans.reduce((n, p) => n + p.items.length, 0), videoCount, videoMinutes, videoBytes: videoMinutes * VIDEO_BYTES_PER_MIN };
      const bytes = plans.reduce((n, p) => n + p.items.reduce((m, it) => m + (it.size || 0), 0), 0);
      const note = (list) => list.filter((p) => p.skipped.length).map((p) => `${p.root}\n${p.skipped.map((x) => `- ${x}`).join("\n")}`).join("\n\n");
      const head = "Quizzes, tests and outside tools are never opened by StudyPilot, and locked items are skipped. These weren't included:";
      // Very large backups are split per course so no single zip gets unwieldy.
      const groups = bytes > 3e9 && plans.length > 1 ? plans.map((p) => [p]) : [plans];
      const out = [];
      for (const g of groups) {
        const name = g.length === 1 && groups.length > 1 ? `${g[0].label} backup ${today()}` : `Canvas backup ${today()}`;
        const items = g.flatMap((p) => p.items);
        const n = note(g);
        const gsCourses = await gsLinkedCourses(g.map((p) => p.courseId));
        const s2 = await settings();
        const withTranscripts = transcripts && s2.videoHost && g.some((p) => p.videos.length);
        const extra = gsCourses.length || withTranscripts ? async (id) => {
          const failed = [];
          // Lecture video transcripts as text files: <course>/Lecture videos/<date> <title>.txt
          if (withTranscripts) for (const p of g) {
            const list = p.videos;
            for (let k = 0; k < list.length; k += 10) {
              const batch = list.slice(k, k + 10);
              await progress({ label: `${p.label}: video transcripts`, done: k, total: list.length });
              const caps = await vids.panoptoCaptions(s2.videoHost, batch.map((v) => v.video_id)).catch(() => ({}));
              for (const v of batch) {
                const text = vids.captionsToText(caps[v.video_id]);
                const name = `${p.root}/Lecture videos/${v.date ? v.date.slice(0, 10) + " " : ""}${safeName(v.title).slice(0, 80)}.txt`;
                if (text) await zipCall("ZIP_ADD_TEXT", { id, path: name, text: `${v.title}\n${v.date ? new Date(v.date).toLocaleString() : ""}\n${v.url}\n\n${text}\n` });
                else failed.push({ path: name, error: "no captions" });
              }
            }
          }
          for (const { courseId: cid, gsId } of gsCourses) {
            const plan = g.find((p) => p.courseId === cid);
            try {
              const r = await gs.streamCourse(gsId, {
                prefix: `${plan.root}/My submissions/Gradescope`,
                addChunk: (path, b64) => zipCall("ZIP_CHUNK", { id, path, b64 }),
                commit: (path) => zipCall("ZIP_COMMIT", { id, path }),
                addUrl: (path, url) => zipCall("ZIP_ADD_URL", { id, path, url }),
                onProgress: (i, n2, nm) => progress({ label: `Gradescope: ${nm}`, done: i, total: n2 }),
              });
              failed.push(...r.failed);
            } catch (e) { failed.push({ path: `${plan.root}/My submissions/Gradescope`, error: e.message }); }
          }
          return failed;
        } : null;
        const z = await buildZip(name, items, { label: `Zipping ${items.length} items`, note: n ? `${head}\n\n${n}` : "", saveAs: true, extra });
        out.push({ name: z.name, count: z.count, failed: z.failed.length, size: z.size, downloadId: z.downloadId });
      }
      // Video files are already compressed and very large, so they're saved as they are (not zipped),
      // in Downloads › StudyPilot › <course> › Lecture videos, and only when the video site allows downloads.
      let videos = null;
      if (videoFiles) videos = await downloadVideoFiles(plans.flatMap((p) => p.videos.map((v) => ({ ...v, course: p.label }))));
      backupPlanCache = null;
      return { zips: out, items: plans.reduce((n, p) => n + p.items.length, 0), bytes: fileBytes, videos };
    } finally { await progress(null); }
  },

  // ---------- Google sign-in & sync ----------
  async SYNC_STATUS() {
    const { syncAccount = null, syncState = null } = await chrome.storage.local.get(["syncAccount", "syncState"]);
    return { ready: gsync.oauthReady(), account: syncAccount, state: syncState };
  },
  async SYNC_SIGN_IN() { const account = await gsync.signIn(); const r = await gsync.syncNow(); return { account, state: r }; },
  async SYNC_SIGN_OUT() { await gsync.signOut(); return true; },
  async SYNC_NOW() { return gsync.syncNow(); },

  // ---------- Lecture videos (Panopto) ----------
  // Finds the school's Panopto address from links in courses (modules, syllabus) so the student doesn't have to.
  async VIDEO_DETECT() {
    const c = await client();
    const { snapshot } = await chrome.storage.local.get("snapshot");
    for (const course of (snapshot?.courses || []).slice(0, 8)) {
      const mods = await c.optional(`/courses/${course.id}/modules`, { "include[]": "items", per_page: 50 }).catch(() => null);
      const urls = (mods || []).flatMap((m) => (m.items || []).map((i) => `${i.external_url || ""} ${i.title || ""}`)).join(" ");
      const found = vids.panoptoLinksIn(urls)[0]?.host || (urls.match(/https?:\/\/([a-z0-9.-]*panopto\.(?:com|eu|ca|com\.au))/i) || [])[1];
      if (found) return { host: found.toLowerCase() };
      const info = await c.course(course.id).catch(() => null);
      const h2 = vids.panoptoLinksIn(info?.syllabus_body || "")[0]?.host;
      if (h2) return { host: h2 };
    }
    return { host: null };
  },
  // One course's recordings: transcripts as one zip of text files, or the video files themselves.
  async VIDEO_TRANSCRIPTS_ZIP({ courseId, videoIds = null }) {
    const s = await settings();
    const v = await actions.VIDEOS({ courseId });
    if (v.state !== "ok") throw new Error("Connect your lecture video site first.");
    const list = videoIds ? v.videos.filter((x) => videoIds.includes(x.video_id)) : v.videos;
    const { snapshot } = await chrome.storage.local.get("snapshot");
    const course = snapshot?.courses.find((x) => x.id === courseId);
    let added = 0;
    try {
      const z = await buildZip(`Lecture transcripts - ${course?.code || v.folderName} - ${today()}`, [], {
        label: "Zipping transcripts",
        extra: async (id) => {
          const failed = [];
          for (let k = 0; k < list.length; k += 10) {
            const batch = list.slice(k, k + 10);
            await progress({ label: "Reading captions", done: k, total: list.length });
            const caps = await vids.panoptoCaptions(s.videoHost, batch.map((x) => x.video_id)).catch(() => ({}));
            for (const x of batch) {
              const text = vids.captionsToText(caps[x.video_id]);
              const path = `${x.date ? x.date.slice(0, 10) + " " : ""}${safeName(x.title).slice(0, 80)}.txt`;
              if (text) { await zipCall("ZIP_ADD_TEXT", { id, path, text: `${x.title}\n${x.date ? new Date(x.date).toLocaleString() : ""}\n${x.url}\n\n${text}\n` }); added++; }
              else failed.push({ path, error: "no captions" });
            }
          }
          return failed;
        },
      });
      return { zip: z.name, added, noCaptions: list.length - added, downloadId: z.downloadId };
    } finally { await progress(null); }
  },
  async VIDEO_FILES({ courseId, videoIds = null, estimate = false }) {
    const v = await actions.VIDEOS({ courseId });
    if (v.state !== "ok") throw new Error("Connect your lecture video site first.");
    const list = videoIds ? v.videos.filter((x) => videoIds.includes(x.video_id)) : v.videos;
    if (estimate) return { count: list.length, minutes: list.reduce((n, x) => n + (x.minutes || 0), 0), bytes: list.reduce((n, x) => n + (x.minutes || 0), 0) * VIDEO_BYTES_PER_MIN };
    const { snapshot } = await chrome.storage.local.get("snapshot");
    const course = snapshot?.courses.find((x) => x.id === courseId);
    return downloadVideoFiles(list.map((x) => ({ ...x, course: course?.code || v.folderName })));
  },
  async VIDEO_LOGIN() { const s = await settings(); if (s.videoHost) await vids.openPanoptoLogin(s.videoHost); return true; },
  // The recordings for one course: Panopto folder matched by name (the student can pick another).
  async VIDEOS({ courseId, refresh = false }) {
    const s = await settings();
    if (!s.videoHost) return { state: "setup" };
    if (!(await chrome.permissions.contains({ origins: vids.panoptoOrigins(s.videoHost) }).catch(() => false))) return { state: "permission", host: s.videoHost };
    let cache = refresh ? null : (await chrome.storage.session.get("videoSessions")).videoSessions;
    if (!cache || cache.host !== s.videoHost || Date.now() - cache.at > 15 * 60e3) {
      const r = await vids.panoptoSessions(s.videoHost);
      if (r.state !== "ok") return { state: r.state, host: s.videoHost };
      cache = { host: s.videoHost, at: Date.now(), sessions: r.sessions };
      await chrome.storage.session.set({ videoSessions: cache });
    }
    const folders = new Map();
    for (const v of cache.sessions) {
      if (!folders.has(v.folderId)) folders.set(v.folderId, { id: v.folderId, name: v.folder, count: 0, latest: "" });
      const f = folders.get(v.folderId); f.count++; if ((v.date || "") > f.latest) f.latest = v.date || "";
    }
    const list = [...folders.values()].sort((a, b) => b.latest.localeCompare(a.latest));
    const pick = s.videoFolderMap?.[courseId];
    const { snapshot } = await chrome.storage.local.get("snapshot");
    const course = snapshot?.courses.find((x) => x.id === courseId);
    const folder = pick === "none" ? null : pick ? list.find((f) => f.id === pick) : course ? vids.matchFolder(course, list) : null;
    const videos = folder ? cache.sessions.filter((v) => v.folderId === folder.id).sort((a, b) => (b.date || "").localeCompare(a.date || "")) : [];
    return { state: "ok", host: s.videoHost, folders: list, folderId: folder?.id || null, folderName: folder?.name || null,
      videos: videos.map((v) => ({ key: `${courseId}:V:${v.id}`, doc_key: `${courseId}:V:${v.id}`, type: "Video", video_id: v.id, host: s.videoHost, title: v.title, date: v.date, minutes: v.minutes,
        module: "Lecture videos", module_index: 9999, is_lecture: true, url: v.url.startsWith("http") ? v.url : `https://${s.videoHost}${v.url}` })) };
  },

  // ---------- Exam dates ----------
  // From Canvas (exam-named assignments, calendar events), announcements (newest first: they announce changes),
  // and the syllabus, syllabus files and schedule pages. Cached per course; refreshed every few days.
  async EXAMS({ courseId, refresh = false }) {
    const { exams = {} } = await chrome.storage.local.get("exams");
    if (!refresh && exams[courseId] && Date.now() - exams[courseId].at < 24 * 3600e3) return exams[courseId];
    const c = await client();
    const { snapshot } = await chrome.storage.local.get("snapshot");
    const course = snapshot?.courses.find((x) => x.id === courseId);
    const ref = course?.start_at ? Date.parse(course.start_at) + 45 * 864e5 : Date.now();
    const texts = [];
    try {
      await progress({ label: `Looking for exam dates in ${course?.code || "the course"}` });
      const info = await c.course(courseId);
      if (info.syllabus_body) texts.push({ name: "Syllabus page", text: stripHtml(info.syllabus_body) });
      const { sources } = await c.syllabusSources(courseId, info.syllabus_body || "");
      for (const src of sources.slice(0, 4)) {
        if (src.kind === "page") texts.push({ name: src.name, text: src.text });
        else { try { texts.push({ name: src.name, text: (await readFileRemote(src.file)).text }); } catch { /* unreadable file: skip */ } }
      }
      const sched = await c.optional(`/courses/${courseId}/pages`, { search_term: "schedule", per_page: 5 }).catch(() => null);
      for (const p of (sched || []).slice(0, 3)) {
        const pg = await c.optional(`/courses/${courseId}/pages/${encodeURIComponent(p.url)}`, {}, { all: false }).catch(() => null);
        if (pg?.body && !pg.locked_for_user) texts.push({ name: pg.title, text: stripHtml(pg.body) });
      }
      const events = await c.optional("/calendar_events", { type: "event", all_events: true, "context_codes[]": `course_${courseId}`, per_page: 100 }).catch(() => null);
      const announcements = await c.announcements([courseId], 200).catch(() => []);
      const list = collectExams({
        assignments: (course?.assignments || []).map((a) => ({ name: a.name, due_at: a.due_at })),
        events: (events || []).map((e) => ({ title: e.title, start_at: e.start_at, all_day: e.all_day })),
        announcements: (announcements || []).map((a) => ({ title: a.title, message: stripHtml(a.message || ""), posted_at: a.posted_at })),
        texts,
      }, { ref });
      if (exams[courseId]?.list) await recordChanges(diffExams(exams[courseId].list, list, { courseId, course: course?.code || course?.name }));
      exams[courseId] = { list, at: Date.now(), checked: texts.map((t) => t.name) };
      // Keep the syllabus text for Search (it's the student's own course material, stored only in this browser)
      if (texts.length) {
        const { syllabusText = {} } = await chrome.storage.local.get("syllabusText");
        syllabusText[courseId] = { at: Date.now(), url: `${(await settings()).canvasUrl.replace(/\/$/, "")}/courses/${courseId}/assignments/syllabus`,
          text: texts.map((t) => `## ${t.name}\n\n${t.text}`).join("\n\n").slice(0, 400000) };
        await chrome.storage.local.set({ syllabusText });
      }
      await chrome.storage.local.set({ exams });
      return exams[courseId];
    } finally { await progress(null); }
  },
  // Study plan: homework notebooks on the course's hub that match these assignments by name ("hw03.ipynb" ↔
  // "Homework 3"): their problem text (never the student's code or outputs) and a description of the data they use.
  async JUPYTER_HOMEWORK({ courseId, assignments }) {
    const { hub, files, notebooks } = await hubHomework(courseId);
    if (!hub || !notebooks.length) return {};
    const key = (s) => gs.workKey(s).replace(/\b0+(\d)/g, "$1");
    const out = {}, want = [];
    for (const a of assignments) {
      const k = key(a.name);
      // "Lab 02 (Gradescope)" and lab2-pandas.ipynb are the same thing: the kind and number decide.
      const lead = (s) => (s.match(/^([a-z]+) (\d+)\b/) || [])[0] || s;
      const nb = notebooks.find((f) => lead(key(prettyNotebook(f.path).replace(/^hw/i, "homework "))) === lead(k));
      if (nb) { out[a.id] = { path: nb.path }; want.push(nb.path); }
    }
    if (!want.length) return {};
    const server = await serverFor(await checkHub(hub)).catch(() => null);
    if (!server) return {};
    const read = await hubApi.readFiles(hub, server, [...new Set(want)]).catch(() => []);
    for (const [id, v] of Object.entries(out)) {
      const r = read.find((x) => x.path === v.path);
      if (!r?.notebook) { delete out[id]; continue; }
      const data = notebookData(r.content, v.path, files);
      const heads = await hubApi.readHeads(hub, server, data.filter((f) => /\.(csv|tsv|txt|json|geojson)$/i.test(f.path)).map((f) => f.path)).catch(() => ({}));
      out[id] = { name: v.path.split("/").pop(), text: nbProblemText(r.content) + (data.length ? `\n\nData it uses:\n${data.map((f) => summarizeData(f, heads[f.path] || "")).join("\n\n")}` : "") };
    }
    return out;
  },
  // My week: the parts of each course's syllabus and course pages that mention days, times and places
  // (lectures, sections, labs, office hours). The student's AI turns them into class times.
  async CLASS_TIME_SOURCES({ courseIds }) {
    const c = await client();
    const { snapshot } = await chrome.storage.local.get("snapshot");
    const out = [];
    for (const courseId of courseIds) {
      const course = snapshot?.courses.find((x) => x.id === courseId);
      await progress({ label: `Looking for class times in ${course?.code || "your courses"}` });
      try {
        let { syllabusText = {} } = await chrome.storage.local.get("syllabusText");
        if (!syllabusText[courseId] || Date.now() - syllabusText[courseId].at > 7 * 864e5) {
          await actions.EXAMS({ courseId, refresh: true }).catch(() => {});
          ({ syllabusText = {} } = await chrome.storage.local.get("syllabusText"));
        }
        const texts = [syllabusText[courseId]?.text || ""];
        // The course home page, and pages about sections, office hours or course info.
        const front = await c.optional(`/courses/${courseId}/front_page`, {}, { all: false }).catch(() => null);
        if (front?.body && !front.locked_for_user) texts.push(`## Course home page\n${stripHtml(front.body)}`);
        for (const term of ["office", "section", "course info", "contact", "logistics"]) {
          const list = await c.optional(`/courses/${courseId}/pages`, { search_term: term, per_page: 5 }).catch(() => null);
          for (const p of (list || []).slice(0, 2)) {
            const pg = await c.optional(`/courses/${courseId}/pages/${encodeURIComponent(p.url)}`, {}, { all: false }).catch(() => null);
            if (pg?.body && !pg.locked_for_user) texts.push(`## ${pg.title}\n${stripHtml(pg.body)}`);
          }
        }
        const text = [...new Set(texts.map((t) => timeSnippets(t, { max: 3500 })).filter(Boolean))].join("\n…\n").slice(0, 7000);
        out.push({ id: courseId, name: course?.name || String(courseId), code: course?.code || "", text });
      } catch (e) { out.push({ id: courseId, name: course?.name || String(courseId), code: course?.code || "", text: "", error: e.message }); }
    }
    await progress(null);
    return out;
  },
  // Canvas calendar page: StudyPilot's study time, planned work and class times for the dates shown (drawn on the
  // page only; nothing is written to Canvas).
  async CAL_OVERLAY({ from, to }) {
    const s = await settings();
    return { on: s.calendarOverlay !== false, events: await weekItems(from, to) };
  },
  // Keep My week in Google Calendar: class times and planned study sittings (or study time, without a plan),
  // for the next two weeks. StudyPilot's own events only; replaced whenever the week or the plan changes.
  async GCAL_PUSH_WEEK() {
    const today = ymd(new Date()), to = ymd(addDays(new Date(), 14));
    const items = await weekItems(today, to);
    const hasPlan = items.some((e) => e.kind === "plan");
    const now = Date.now();
    const events = items.filter((e) => e.kind === "class" || e.kind === "plan" || (e.kind === "study" && !hasPlan))
      .filter((e) => Date.parse(`${e.date}T${e.end}:00`) > now)
      .map((e) => ({ summary: e.kind === "study" ? "Study time" : e.kind === "plan" ? `Study: ${e.title}` : e.title, location: e.sub || "",
        start: `${e.date}T${e.start}:00`, end: `${e.date}T${e.end}:00`, colorId: e.kind === "class" ? "8" : "10", quiet: e.kind === "class",
        description: e.kind === "class" ? "Class time from My week" : "From your StudyPilot study plan" }));
    const n = await gcal.replaceEvents("week", events, Intl.DateTimeFormat().resolvedOptions().timeZone);
    await chrome.storage.local.set({ gcalWeekAt: Date.now() });
    return { count: n };
  },
  async GCAL_REMOVE_WEEK() { return { count: await gcal.removeEvents("week") }; },
  async CAL_OVERLAY_SET({ on }) { const s = await settings(); await chrome.storage.local.set({ settings: { ...s, calendarOverlay: !!on, settingsUpdatedAt: Date.now() } }); return true; },
  // Check courses whose exam dates haven't been looked at for 3 days (a few at a time).
  async EXAMS_STALE() {
    const { exams = {}, snapshot } = await chrome.storage.local.get(["exams", "snapshot"]);
    const s = await settings();
    const stale = (snapshot?.courses || []).filter((c) => !(s.hiddenCourses || []).includes(c.id) && Date.now() - (exams[c.id]?.at || 0) > 3 * 864e5).slice(0, 4);
    for (const c of stale) await actions.EXAMS({ courseId: c.id, refresh: true }).catch(() => {});
    return { checked: stale.length };
  },
  // Every course's upcoming exams (cached; with the student's own additions and removals).
  async ALL_EXAMS() {
    const { exams = {}, examEdits = {}, snapshot } = await chrome.storage.local.get(["exams", "examEdits", "snapshot"]);
    const s = await settings();
    const hidden = new Set(s.hiddenCourses || []);
    const out = [];
    for (const c of snapshot?.courses || []) {
      if (hidden.has(c.id)) continue;
      out.push(...applyExamEdits(c.id, exams[c.id]?.list || [], examEdits[c.id]).map((e) => ({ ...e, courseId: c.id, course: c.code || c.name })));
    }
    return out.filter((e) => Date.parse(e.date) > Date.now() - 864e5).sort((a, b) => a.date.localeCompare(b.date));
  },

  // ---------- Gradescope (the student's own work, through their Gradescope login) ----------
  async GS_COURSE({ courseId, refresh = false }) {
    const uses = await courseUsesGradescope(courseId);
    if (!(await gs.hasGsPermission())) return { uses, state: "permission" };
    let st = refresh ? null : (await chrome.storage.session.get("gsStatus")).gsStatus;
    if (!st || Date.now() - st.at > 10 * 60e3) {
      st = { ...(await gs.status()), at: Date.now() };
      if (st.state === "ok" && st.courses?.length) await chrome.storage.session.set({ gsStatus: st }); // never remember an empty list
    }
    if (st.state !== "ok") return { uses, state: st.state };
    const link = await gsLinkFor(courseId, st.courses);
    if (!link) return { uses, state: "ok", courses: st.courses, gsId: null };
    const list = await gs.assignments(link.id);
    await rememberTurnedIn(courseId, list.assignments);
    return { uses, state: "ok", courses: st.courses, gsId: link.id, gsCourse: link, assignments: list.assignments };
  },
  async GS_ALL_COURSES() {
    if (!(await gs.hasGsPermission())) return { state: "permission" };
    const st = await gs.status();
    if (st.state === "ok") await chrome.storage.session.set({ gsStatus: { ...st, at: Date.now() } });
    return st;
  },
  // Every Gradescope course you pick → one zip: <term>/<course>/<assignment>/… Chrome asks where to save it.
  async GS_EXPORT_ALL({ gsIds }) {
    const st = await gs.status();
    if (st.state !== "ok") throw new Error("Log in to Gradescope first.");
    const picked = st.courses.filter((g) => gsIds.includes(g.id));
    if (!picked.length) throw new Error("Pick at least one course.");
    let added = 0, notSubmitted = 0;
    try {
      const z = await buildZip(`Gradescope - all my work - ${today()}`, [], {
        label: "Zipping Gradescope work", saveAs: true,
        extra: async (id) => {
          const failed = [];
          for (const [i, g] of picked.entries()) {
            try {
              const r = await gs.streamCourse(g.id, {
                prefix: [safeName(g.term || "Other"), safeName(g.short || g.name || g.id)].join("/"),
                addChunk: (path, b64) => zipCall("ZIP_CHUNK", { id, path, b64 }),
                commit: (path) => zipCall("ZIP_COMMIT", { id, path }),
                addUrl: (path, url) => zipCall("ZIP_ADD_URL", { id, path, url }),
                onProgress: (j, n, nm) => progress({ label: `${g.short} (${i + 1}/${picked.length}): ${nm}`, done: j, total: n }),
              });
              added += r.added; notSubmitted += r.skipped.length; failed.push(...r.failed);
            } catch (e) { failed.push({ path: g.short, error: e.message }); }
          }
          return failed;
        },
      });
      return { zip: z.name, added, failed: z.failed.length, courses: picked.length, notSubmitted };
    } finally { await progress(null); }
  },
  async GS_LOGIN() { await gs.openLogin(); return true; },
  async GS_DOWNLOAD({ courseId }) {
    const { gsStatus } = await chrome.storage.session.get("gsStatus");
    const link = await gsLinkFor(courseId, gsStatus?.courses || (await gs.status()).courses || []);
    if (!link) throw new Error("Pick this course's Gradescope course first.");
    const { snapshot } = await chrome.storage.local.get("snapshot");
    const course = snapshot?.courses.find((x) => x.id === courseId);
    let result = null;
    try {
      const z = await buildZip(`Gradescope - ${course?.code || link.short} - ${today()}`, [], {
        label: "Zipping Gradescope work",
        extra: async (id) => {
          result = await gs.streamCourse(link.id, {
            addChunk: (path, b64) => zipCall("ZIP_CHUNK", { id, path, b64 }),
            commit: (path) => zipCall("ZIP_COMMIT", { id, path }),
            addUrl: (path, url) => zipCall("ZIP_ADD_URL", { id, path, url }),
            onProgress: (i, n, nm) => progress({ label: `Gradescope: ${nm}`, done: i, total: n }),
          });
          return result.failed;
        },
      });
      return { zip: z.name, added: result?.added || 0, failed: result?.failed.length || 0, notSubmitted: result?.skipped.length || 0, downloadId: z.downloadId };
    } finally { await progress(null); }
  },

  async GRADE_DATA({ courseId, skipSyllabus = false }) {
    const c = await client();
    const data = await c.gradeData(courseId);
    const html = data.syllabusHtml;
    delete data.syllabusHtml;
    data.checked = [];
    if (skipSyllabus || (data.weighted && data.groups.some((g) => g.weight > 0))) return data;
    let w = parseSyllabusWeights(data.syllabus);
    if (w.length) { data.syllabusWeights = w; data.weightSource = { kind: "tab", name: "the Syllabus page" }; return data; }
    if (data.syllabus.trim()) data.checked.push({ name: "Syllabus page", found: 0 });
    try {
      await progress({ label: "Looking for your syllabus" });
      const { sources, notes } = await c.syllabusSources(courseId, html);
      data.checked.push(...notes);
      for (const src of sources.slice(0, 10)) {
        let text = src.text;
        if (src.kind === "file") {
          await progress({ label: `Reading ${src.name}` });
          try { text = (await readFileRemote(src.file)).text; }
          catch (e) { data.checked.push({ name: src.name, error: e.message, file: true }); data.needsFileAccess = true; continue; }
        }
        w = parseSyllabusWeights(text);
        data.checked.push({ name: src.name, found: w.length, readable: (text || "").replace(/\s/g, "").length > 200 });
        if (w.length) { data.syllabusWeights = w; data.weightSource = { kind: src.kind, name: src.name, via: src.via }; break; }
      }
      data.syllabusFound = sources.map((x) => x.name);
    } finally { await progress(null); }
    return data;
  },

  // The syllabus for "Read the weights with my AI": text of each source, plus the file itself when it has no typed text.
  async SYLLABUS_FOR_AI({ courseId }) {
    const c = await client();
    const course = await c.course(courseId);
    const { sources } = await c.syllabusSources(courseId, course.syllabus_body || "");
    const texts = [], files = [];
    const tab = stripHtml(course.syllabus_body || "");
    if (tab.trim()) texts.push({ name: "Syllabus page", text: tab.slice(0, 40000) });
    for (const src of sources.slice(0, 4)) {
      if (src.kind === "page") { texts.push({ name: src.name, text: src.text.slice(0, 40000) }); continue; }
      let a = null;
      try { a = await readFileRemote(src.file); } catch { /* attach instead */ }
      if (a && !a.needsFile && (a.text || "").length > 300) texts.push({ name: src.name, text: a.text.slice(0, 60000) });
      else files.push({ url: src.file.url, name: src.file.name, size: src.file.size });
    }
    return { course: course.name, texts, files };
  },

  async SHOW_DOWNLOAD({ id }) { chrome.downloads.show(id); return true; },

  async DOWNLOAD_FILES({ files, label = "Downloading files", onlyNew = true }) {
    try { return await downloadAll(files, label, { onlyNew }); } finally { await progress(null); }
  },

  async LIBRARY_STATS() {
    const { libraryMeta = {} } = await chrome.storage.local.get("libraryMeta");
    return { ...(await lib.libraryStats()), meta: libraryMeta };
  },

  async LIBRARY_CLEAR() {
    await lib.clearLibrary();
    await chrome.storage.local.remove("libraryMeta");
    return true;
  },

  async LECTURES({ courseId }) {
    const list = await (await client()).lectures(courseId);
    const { seenLectures = [] } = await chrome.storage.local.get("seenLectures");
    const docs = Object.fromEntries((await lib.docsForCourse(courseId).catch(() => [])).map((d) => [d.key, d]));
    return [...list, ...(await hubLectures(courseId))].map((l) => {
      const d = docs[l.doc_key];
      return {
        ...l, is_new: !seenLectures.includes(l.key),
        saved: !!d, visual: !!d?.visual, no_text: !!d?.analysis?.noTextPages?.length, scanned: !!d?.analysis?.scanned,
        pages: d?.analysis?.pageCount || d?.cells || null, unit: d?.analysis?.unit || (d?.cells ? "cell" : null),
      };
    });
  },

  async MARK_SEEN({ keys }) {
    const { seenLectures = [] } = await chrome.storage.local.get("seenLectures");
    await chrome.storage.local.set({ seenLectures: [...new Set([...seenLectures, ...keys])].slice(-5000) });
    return true;
  },

  // One lecture → text, or (for slides/PDFs) the file downloaded so it can be attached in an AI chat.
  async LECTURE_CONTENT({ courseId, lecture }) {
    const c = await client();
    const res = await c.lectureContent(courseId, lecture);
    if (res.file) {
      const { snapshot } = await chrome.storage.local.get("snapshot");
      const course = snapshot?.courses.find((x) => x.id === courseId);
      await downloadAll([{ ...res.file, course: course?.code || course?.name || courseId, folder: `Lectures/${lecture.module}` }], "Downloading lecture file");
      await progress(null);
    }
    return res;
  },

  // The in-page "Quiz me" buttons hand a lecture to the panel through session storage.
  async QUEUE_LECTURE(req) {
    await chrome.storage.session.set({ queuedLecture: { ...req, at: Date.now() } });
    return true;
  },

  // ---------- JupyterHub ----------
  // Each course can have its own hub. Every call names the hub, and only hubs the student connected are ever opened.
  async JUPYTER_STATUS({ hub }) {
    hub = await checkHub(hub);
    const st = await hubApi.status(hub);
    const { jupyterState = {} } = await chrome.storage.local.get("jupyterState");
    jupyterState[hub] = { ...st, checked_at: Date.now() };
    await chrome.storage.local.set({ jupyterState });
    return st;
  },
  async JUPYTER_LOGIN({ hub }) { await hubApi.openLogin(await checkHub(hub)); return true; },
  async JUPYTER_START({ hub }) {
    hub = await checkHub(hub);
    await progress({ label: "Starting your Jupyter server (can take a minute)…" });
    try { return await hubApi.startServer(hub); } finally { await progress(null); }
  },
  // Which hub does this course use? Looks at the course's modules and assignment pages for Jupyter links (any site).
  async JUPYTER_DETECT({ courseId }) {
    const c = await client();
    const links = await c.gitPullLinks(courseId, (u) => !!hubFromLink(u)).catch(() => []);
    const count = new Map();
    for (const l of links) { const h = hubFromLink(l.url); count.set(h, (count.get(h) || 0) + 1); }
    return [...count].sort((a, b) => b[1] - a[1]).map(([hub, links]) => ({ hub, links }));
  },
  async JUPYTER_FIND_LINKS({ hub, courseId }) {
    const s = await settings();
    hub = await checkHub(hub);
    const isMatch = (u) => isGitPullLink(u, hub);
    const out = [];
    if (s.canvasUrl && courseId) {
      const c = await client();
      for (const l of await c.gitPullLinks(courseId, isMatch).catch(() => [])) out.push(l);
    }
    for (const url of s.jupyterPullLinks || []) if (isMatch(url) && !out.some((l) => l.url === url)) out.push({ url, title: "Added by you" });
    return out;
  },
  async JUPYTER_PULL({ hub, links }) {
    hub = await checkHub(hub);
    const safe = links.filter((u) => isGitPullLink(u, hub)); // only ever opens links on that course's own hub
    try {
      return await hubApi.pullLatest(hub, safe, (i, n) => progress({ label: "Getting the latest course files", done: i, total: n }));
    } finally { await progress(null); }
  },
  async JUPYTER_SCAN({ hub }) {
    hub = await checkHub(hub);
    const server = await serverFor(hub);
    await progress({ label: "Listing your Jupyter files…" });
    try {
      const r = await hubApi.scan(hub, server);
      // remembered so lecture notebooks can show up in the course's lecture list
      const { jupyterScans = {} } = await chrome.storage.local.get("jupyterScans");
      jupyterScans[hub] = { files: r.files, at: Date.now() };
      await chrome.storage.local.set({ jupyterScans });
      return r;
    } finally { await progress(null); }
  },
  // files: [{path, size, last_modified}] from the scan → one zip per top-level folder
  async JUPYTER_DOWNLOAD({ hub, files, onlyNew = true }) {
    hub = await checkHub(hub);
    const serverBase = await serverFor(hub);
    const idx = await zipIndex();
    const key = (p) => `j:${serverBase}:${p}`;
    const version = (f) => `${f.last_modified || ""}|${f.size ?? ""}`;
    const todo = onlyNew ? files.filter((f) => idx[key(f.path)] !== version(f)) : files;
    const groups = new Map();
    for (const f of todo) {
      const top = f.path.includes("/") ? f.path.split("/")[0] : "Home folder";
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(f);
    }
    const zips = [];
    let done = 0, failed = 0;
    try {
      for (const [top, list] of groups) {
        const host = new URL(hub).host.split(".")[0];
        const z = await buildZip(`Jupyter - ${host} - ${top} - ${today()}${onlyNew && list.length < files.length ? " (new & changed)" : ""}`, [], {
          label: `Zipping ${top}`,
          extra: async (id) => {
            const r = await hubApi.streamFiles(hub, serverBase, list.map((f) => f.path), {
              addChunk: (p, b64) => zipCall("ZIP_CHUNK", { id, path: inner(p), b64 }),
              commit: (p) => zipCall("ZIP_COMMIT", { id, path: inner(p), date: list.find((f) => f.path === p)?.last_modified }),
              onProgress: (i, n) => progress({ label: `Zipping ${top}`, done: i, total: n }),
            });
            return r.failed.map((x) => ({ path: x.path, error: x.error }));
          },
        });
        // Paths inside the zip: drop the top folder name (the zip is named after it)
        function inner(p) { return top === "Home folder" ? p : p.split("/").slice(1).join("/"); }
        const bad = new Set(z.failed.map((x) => x.path));
        for (const f of list) if (!bad.has(f.path)) idx[key(f.path)] = version(f);
        done += list.length - bad.size; failed += bad.size;
        zips.push(z.name);
      }
    } finally { await saveZipIndex(idx); await progress(null); }
    return { done, skipped: files.length - todo.length, failed, zips };
  },
  // files: [{path, last_modified}]; with onlyNew, notebooks unchanged since they were last sent are skipped.
  async JUPYTER_READ({ hub, files, onlyNew = true }) {
    hub = await checkHub(hub);
    const serverBase = await serverFor(hub);
    const { jupyterSent = {} } = await chrome.storage.local.get("jupyterSent");
    const key = (p) => `${serverBase}:${p}`;
    const todo = onlyNew ? files.filter((f) => jupyterSent[key(f.path)] !== (f.last_modified || "")) : files;
    if (!todo.length) return { docs: [], unchanged: files.length };
    await progress({ label: `Reading ${todo.length} files…` });
    try {
      const raw = await hubApi.readFiles(hub, serverBase, todo.map((f) => f.path));
      // Plot outputs become attachable image files (capped so a bundle stays reasonable).
      let totalFigs = 0;
      const docs = raw.map((r) => {
        if (r.skipped) return r;
        const images = [];
        const base = r.path.split("/").pop().replace(/\.ipynb$/, "");
        const figure = (cellNo, outNo, mime, data) => {
          if (images.length >= 30 || totalFigs >= 120 || data.length > 3e6) return null;
          const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "svg";
          const name = `${base} - cell ${cellNo}${outNo > 1 ? `.${outNo}` : ""}.${ext}`;
          images.push({ name, mime, data, base64: ext !== "svg" });
          totalFigs++;
          return name;
        };
        return {
          path: r.path, last_modified: r.last_modified,
          status: key(r.path) in jupyterSent ? "changed" : "new",
          text: r.notebook ? nbToMarkdown(r.content, { figure }) : "```\n" + r.content.slice(0, 200000) + "\n```",
          images,
        };
      });
      for (const d of docs) if (d.text) jupyterSent[key(d.path)] = d.last_modified || "";
      await chrome.storage.local.set({ jupyterSent });
      return { docs, unchanged: files.length - todo.length };
    } finally { await progress(null); }
  },

  async SHOW_DOWNLOADS() { chrome.downloads.showDefaultFolder(); return true; },

  // ---------- Google Calendar ----------
  // Calendar and sync share one Google sign-in; revoking would end both, so turning one off only forgets it here.
  async GCAL_STATUS() {
    const { gcalEmail, gcalOff } = await chrome.storage.local.get(["gcalEmail", "gcalOff"]);
    return { connected: !gcalOff && (await gcal.isConnected()), email: gcalEmail || null };
  },
  async GCAL_CONNECT() {
    const { email } = await gcal.connect();
    await chrome.storage.local.set({ gcalEmail: email, gcalOff: false });
    return { connected: true, email };
  },
  async GCAL_DISCONNECT() {
    const { syncAccount } = await chrome.storage.local.get("syncAccount");
    if (!syncAccount) await gcal.disconnect();
    await chrome.storage.local.set({ gcalOff: true });
    await chrome.storage.local.remove("gcalEmail");
    return { connected: false };
  },
  // Busy times from the student's private calendar link (.ics), for planning without Google sign-in.
  async CAL_FEED_BUSY({ url } = {}) {
    const s = await settings();
    const feed = url || s.icalUrl;
    if (!feed) return [];
    const res = await fetch(feed, { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 404 ? "That calendar link didn't work (404). Copy it again from your calendar's settings." : `Calendar link returned ${res.status}.`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("That link isn't a calendar file. Use the \"secret address in iCal format\" link.");
    return icsBusy(text, { from: Date.now(), to: Date.now() + s.daysAhead * 864e5, tz: tz() });
  },

  async GCAL_PUSH_DEADLINES() {
    const { snapshot } = await chrome.storage.local.get("snapshot");
    if (!snapshot) throw new Error("Sync Canvas first.");
    const events = openWork(snapshot).filter((a) => !a.overdue).map((a) => ({
      summary: `Due: ${a.course}: ${a.name}`,
      description: `${a.points ?? "?"} pts\n${a.url}`,
      start: new Date(Date.parse(a.due_at) - 30 * 60e3).toISOString(),
      end: a.due_at,
    }));
    return { count: await gcal.replaceEvents("deadline", events, tz()) };
  },
  async GCAL_IMPORT_PLAN({ text }) {
    const sessions = parsePlan(text);
    const events = sessions.map((s) => ({ summary: `Study: ${s.title}`, description: s.goal, start: s.start, end: s.end }));
    return { count: await gcal.replaceEvents("session", events, tz()), sessions };
  },
  async PARSE_PLAN({ text }) { return parsePlan(text); },
  async GCAL_REMOVE({ kind }) { return { count: await gcal.removeEvents(kind) }; },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Must run synchronously inside the click's message handler to keep the user gesture.
  if (msg?.type === "OPEN_PANEL") {
    if (sender?.tab?.id) chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    if (msg.payload?.lecture || msg.payload?.module || msg.payload?.action) chrome.storage.session.set({ queuedLecture: { ...msg.payload, at: Date.now() } });
    sendResponse({ ok: true });
    return false;
  }
  const fn = actions[msg?.type];
  if (!fn) return false;
  fn(msg.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => { progress(null); sendResponse({ ok: false, error: err.message || String(err) }); });
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.alarms.create("refresh", { periodInMinutes: 120 });
  const { snapshot } = await chrome.storage.local.get("snapshot");
  updateBadge(snapshot);
});

// Video speed also runs inside lecture-video players on other sites: the school's Panopto site, and
// (if the student allows it) YouTube and Kaltura. Those scripts are registered only for sites with permission.
const MORE_VIDEO_ORIGINS = ["https://www.youtube.com/*", "https://www.youtube-nocookie.com/*", "https://*.kaltura.com/*"];
async function syncSpeedScripts() {
  const s = await settings();
  const want = [];
  if (s.videoSpeedOn !== false) {
    if (s.videoHost && (await chrome.permissions.contains({ origins: [`https://${s.videoHost}/*`] }).catch(() => false))) want.push(`https://${s.videoHost}/*`);
    for (const o of MORE_VIDEO_ORIGINS) if (s.videoSpeedMore && (await chrome.permissions.contains({ origins: [o] }).catch(() => false))) want.push(o);
    if (s.videoSpeedEverywhere) {
      for (const o of ["https://*/*", "http://*/*"]) if (await chrome.permissions.contains({ origins: [o] }).catch(() => false)) want.push(o);
      if (await chrome.extension.isAllowedFileSchemeAccess().catch(() => false)) want.push("file:///*");
    }
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ["sp-speed"] }).catch(() => []);
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ["sp-speed"] }).catch(() => {});
  const all = [...new Set(want)];
  if (all.length) await chrome.scripting.registerContentScripts([{ id: "sp-speed", matches: all, js: ["content/speed.js"], allFrames: true, matchOriginAsFallback: true, runAt: "document_idle", persistAcrossSessions: true }]).catch(async () => {
    // older Chrome without matchOriginAsFallback
    await chrome.scripting.registerContentScripts([{ id: "sp-speed", matches: all, js: ["content/speed.js"], allFrames: true, runAt: "document_idle", persistAcrossSessions: true }]).catch(() => {});
  });
}
chrome.permissions.onAdded.addListener(() => syncSpeedScripts());
chrome.permissions.onRemoved.addListener(() => syncSpeedScripts());
chrome.runtime.onStartup?.addListener(() => syncSpeedScripts());
chrome.runtime.onInstalled.addListener(() => syncSpeedScripts());

// Sync every 30 minutes, and shortly after anything worth syncing changes on this computer.
chrome.alarms.create("gsync", { periodInMinutes: 30 });
let syncTimer = null;
// Google Calendar: My week follows changes (a couple of minutes later, so a burst of edits is one update).
let gcalWeekTimer = null;
function gcalWeekSoon() {
  clearTimeout(gcalWeekTimer);
  gcalWeekTimer = setTimeout(async () => {
    const s = await settings();
    const { gcalOff } = await chrome.storage.local.get("gcalOff");
    if (!s.gcalWeekSync || gcalOff || !(await gcal.isConnected())) return;
    actions.GCAL_PUSH_WEEK().catch(() => {});
  }, 120e3);
}
chrome.storage.local.onChanged.addListener((ch) => {
  if (ch.settings) {
    const o = ch.settings.oldValue || {}, n = ch.settings.newValue || {};
    if (o.videoHost !== n.videoHost || o.videoSpeedOn !== n.videoSpeedOn || o.videoSpeedMore !== n.videoSpeedMore || o.videoSpeedEverywhere !== n.videoSpeedEverywhere) syncSpeedScripts();
  }
  // Plan pieces without their own time get stamped when they change here (so the newest copy wins when syncing).
  const stamp = gsync.STAMPED.filter((k) => k in ch);
  if (stamp.length && !gsync.isApplying()) chrome.storage.local.get("syncStamps").then(({ syncStamps = {} }) => {
    for (const k of stamp) syncStamps[k] = Date.now();
    chrome.storage.local.set({ syncStamps });
  });
  if (["week", "plan", "planDay", "planDone"].some((k) => k in ch)) gcalWeekSoon();
  if (!["settings", "ledger", "gl", "examEdits", "lectureTopics", "studyLog", "checklists", "itemStats", "week", ...gsync.PLAN_KEYS].some((k) => k in ch)) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => gsync.syncNow().catch(() => {}), 20e3);
});

// My week items for a date range: class times, study time and the plan's sittings (for Canvas's calendar page
// and Google Calendar).
async function weekItems(from, to) {
  const st = await chrome.storage.local.get(["week", "snapshot", "plan", "planDone", "planDay", "checklists", "itemStats"]);
  const s = await settings();
  const week = { ...emptyWeek(), ...(st.week || {}) };
  const courses = (st.snapshot?.courses || []).filter((c) => !(s.hiddenCourses || []).includes(c.id));
  const terms = Object.fromEntries(courses.map((c) => [c.id, { start: c.term_start ? ymd(new Date(c.term_start)) : null, end: c.term_end ? ymd(new Date(c.term_end)) : null }]));
  const color = (id) => { const own = s.look?.courseColors?.[id]; return (own && own !== "none" ? own : null) || st.snapshot?.colors?.[id] || "#8a8a8a"; };
  const name = (id) => { const c = courses.find((x) => String(x.id) === String(id)); return c ? c.code || c.name : ""; };
  const out = [];
  for (let m = mondayOf(new Date(`${from}T12:00:00`)); ymd(m) <= to; m = addDays(m, 7)) {
    for (const e of weekEvents(week, m, { courses, terms })) {
      if (e.date < from || e.date > to || e.type === "choose") continue;
      if (e.type === "study") out.push({ date: e.date, start: e.start, end: e.end, kind: "study", title: "Study time" });
      else out.push({ date: e.date, start: e.start, end: e.end, kind: e.meeting.kind === "office" ? "office" : "class", title: `${name(e.courseId)} ${e.meeting.label}`, sub: e.meeting.location || "", color: color(e.courseId) });
    }
  }
  if (st.plan) {
    const info = planInfo({ snapshot: st.snapshot, checklists: st.checklists, itemStats: st.itemStats, masteryLevel: s.masteryLevel || {} });
    const days = planDays(st.plan, week, { today: ymd(new Date()), done: st.planDone || {}, info, day: st.planDay, courses, terms });
    for (const c of [...days.today.map((x) => ({ ...x, date: ymd(new Date()) })), ...days.later])
      if (c.date >= from && c.date <= to) out.push({ date: c.date, start: c.start, end: c.end, kind: "plan", title: c.title, done: !!c.done, color: color(c.ref.split(":")[1]) });
  }
  return out;
}

// New lectures join the "For your AI" list (courses where the student uses lecture mastery; same rules as the
// panel: only lectures posted after they started, never ones they removed). Runs with the regular refresh.
async function newLecturesToList(s) {
  const { checklists = {}, aiQueue = [], aiQueueSkip = [], aiQueueChecked = 0, snapshot } = await chrome.storage.local.get(["checklists", "aiQueue", "aiQueueSkip", "aiQueueChecked", "snapshot"]);
  if (Date.now() - aiQueueChecked < 3 * 3600e3) return;
  await chrome.storage.local.set({ aiQueueChecked: Date.now() });
  const queued = new Set(aiQueue.map((j) => `${j.kind}:${j.lecture?.key || ""}`));
  const add = [];
  for (const c of snapshot?.courses || []) {
    if ((s.hiddenCourses || []).includes(c.id)) continue;
    const set = (s.autoChecklist || {})[c.id];
    const first = Object.values(checklists).filter((r) => String(r.courseId) === String(c.id)).map((r) => r.at || 0).sort((a, b) => a - b)[0];
    const auto = set ? (set.on ? set : null) : first ? { since: new Date(first).toISOString() } : null;
    if (!auto) continue;
    const list = await actions.LECTURES({ courseId: c.id }).catch(() => []);
    // Notebooks change date whenever they're edited, so a notebook is "new" only the first time it shows up.
    const { nbSeen = {} } = await chrome.storage.local.get("nbSeen");
    const nbs = list.filter((l) => l.type === "Notebook").map((l) => l.key);
    const firstLook = !nbSeen[c.id];
    const freshNb = new Set(firstLook ? [] : nbs.filter((k) => !nbSeen[c.id].includes(k)));
    if (nbs.length) { nbSeen[c.id] = [...new Set([...(nbSeen[c.id] || []), ...nbs])].slice(-2000); await chrome.storage.local.set({ nbSeen }); }
    for (const l of list) {
      if (!l.is_lecture || !["File", "Page", "Notebook"].includes(l.type) || checklists[l.key] || aiQueueSkip.includes(l.key) || queued.has(`checklist:${l.key}`)) continue;
      if (l.type === "Notebook") { if (!freshNb.has(l.key)) continue; }
      else if (!l.date || l.date < auto.since) continue;
      add.push({ kind: "checklist", courseId: c.id, course: c.code || c.name, lecture: l, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now() });
    }
  }
  if (add.length) await chrome.storage.local.set({ aiQueue: [...aiQueue, ...add].slice(0, 60) });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "gsync") { gsync.syncNow().catch(() => {}); return; }
  if (a.name === "focus-end") {
    const r = await focusTimer.finishPhase(null, restoreBadge);
    await focusNotify(r?.note);
    tickAlarm(r?.state?.phase === "break");
    return;
  }
  if (a.name === "focus-tick") {
    const f = await focusTimer.status();
    if (f.phase === "focus" || f.phase === "break") {
      await focusTimer.badge(f);
      // Missed alarm (computer was asleep): finish the phase now.
      if (f.pausedLeft == null && f.endsAt && Date.now() > f.endsAt + 30e3) { const r = await focusTimer.finishPhase(f, restoreBadge); await focusNotify(r?.note); tickAlarm(r?.state?.phase === "break"); }
    } else tickAlarm(false);
    return;
  }
  if (a.name !== "refresh") return;
  const s = await settings();
  if (!s.canvasUrl) return;
  await actions.SYNC().catch(() => {});
  await checkTurnedIn().catch(() => {});
  // Exam dates: refresh any course not checked for 3 days (one per run, so it stays light)
  {
    const { exams = {}, snapshot } = await chrome.storage.local.get(["exams", "snapshot"]);
    const stale = (snapshot?.courses || []).find((c) => !(s.hiddenCourses || []).includes(c.id) && Date.now() - (exams[c.id]?.at || 0) > 3 * 864e5);
    if (stale) await actions.EXAMS({ courseId: stale.id, refresh: true }).catch(() => {});
  }
  await newLecturesToList(s).catch(() => {});
  if (s.gcalWeekSync) { const { gcalWeekAt = 0 } = await chrome.storage.local.get("gcalWeekAt"); if (Date.now() - gcalWeekAt > 12 * 3600e3) gcalWeekSoon(); }
  if (s.libraryCourses.length) {
    const { libraryMeta = {} } = await chrome.storage.local.get("libraryMeta");
    const due = s.libraryCourses.filter((id) => Date.now() - (libraryMeta[id]?.at || 0) > 3 * 3600e3);
    if (due.length) actions.LIBRARY_SYNC({ courseIds: due }).catch(() => {});
  }
});
