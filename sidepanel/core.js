// Shared helpers and state for the side panel.
import { download } from "../lib/dl.js";
import { DEFAULT_LOOK, FONTS } from "../lib/look.js";
import { icon } from "../lib/icons.js";
import { providerOf } from "../lib/ai.js";

export const $ = (s) => document.querySelector(s);
export const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const DAY = 864e5;

export function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith("aria-")) { n.setAttribute(k, String(v)); continue; }
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  kids.flat(Infinity).forEach((k) => k != null && k !== false && n.append(k));
  return n;
}

export function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload }).then((r) => {
    if (!r?.ok) throw new Error(r?.error || "Something went wrong");
    return r.data;
  });
}

let toastTimer;
export function toast(text, { error = false, ms = 5000, action = null } = {}) {
  const t = $("#toast");
  t.textContent = text; t.classList.toggle("error", error); t.classList.add("show");
  if (action) t.append(" ", h("button", { class: "toast-act", onclick: async () => { t.classList.remove("show"); await action.run(); } }, action.label));
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

export async function busy(btn, label, fn) {
  const old = [...btn.childNodes]; btn.disabled = true; btn.textContent = label;
  try { return await fn(); }
  catch (e) { toast(e.message, { error: true, ms: 8000 }); }
  finally { btn.disabled = false; btn.replaceChildren(...old); }
}

// A button that runs an async action with a busy label and error toast.
export const act = (label, fn, { cls = "btn", ico = null, busyLabel = "Working…", attrs = {} } = {}) =>
  h("button", { class: cls, ...attrs, onclick: (e) => busy(e.currentTarget, busyLabel, fn) }, ico ? icon(ico, 16) : null, label);

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* activation expired */ }
  const ta = h("textarea", { style: "position:fixed;opacity:0" }); ta.value = text;
  document.body.append(ta); ta.select();
  const ok = document.execCommand("copy"); ta.remove();
  if (!ok) throw new Error("Couldn't copy. Use Download instead.");
}

// Single files go into Downloads › StudyPilot, never loose in Downloads.
export async function downloadText(name, text, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const id = await download(url, `StudyPilot/${name}`, { conflictAction: "uniquify" });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return id;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const fmtBytes = (b) => b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
export const shortDate = (iso) => iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
export const plural = (n, w, p = w + "s") => `${n} ${n === 1 ? w : p}`;
export const safeFile = (n) => {
  let s = String(n).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "").slice(0, 120);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = "_" + s;
  return s || "file";
};

export function relDue(iso, a) {
  const d = new Date(iso), diff = d - Date.now();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diff < 0 && a?.kind === "tool") return { text: `Turned in on ${String(a.kind_label || "").replace(/^submitted on /, "") || "the tool"}?`, tone: "maybe", title: "Canvas doesn't see work turned in on outside sites until it's graded. Connect Gradescope (Settings › Connections) so StudyPilot can check." };
  if (diff < 0 && a?.kind === "offline") return { text: "Past due", tone: "maybe", title: "Handed in on paper or elsewhere, so Canvas can't tell whether it's done." };
  if (diff < 0) return { text: "Overdue", tone: "late" };
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const days = Math.floor((d - start) / DAY);
  if (days === 0) return { text: `Today ${time}`, tone: diff < 3 * 3600e3 ? "now" : "soon" };
  if (days === 1) return { text: `Tomorrow ${time}`, tone: "soon" };
  if (days < 7) return { text: `${d.toLocaleDateString([], { weekday: "short" })} ${time}`, tone: "week" };
  return { text: d.toLocaleDateString([], { month: "short", day: "numeric" }), tone: "" };
}

// ---------- state ----------
export const state = {
  settings: {}, snapshot: null, gcal: { connected: false },
  tab: "today", course: null, courseSub: "overview",
  lectureCache: {}, lectureFilter: "new", libraryStats: null,
  pending: null, imported: null, handoff: null, planSessions: null, attachOffer: null,
  bank: null, // all questions (loaded lazily)
  jup: { status: null, links: null, scan: null },
};

// ---------- small building blocks ----------
export const card = (title, ...kids) => h("div", { class: "card" }, title ? h("h3", {}, title) : null, ...kids);
export const empty = (ico, text, ...kids) => h("div", { class: "card empty" }, h("span", { class: "big" }, icon(ico, 28)), text, ...kids);
export const seg = (options, current, onPick, label) => h("div", { class: "seg", role: "group", "aria-label": label },
  options.map(([v, l]) => h("button", { "aria-pressed": current === v, onclick: () => onPick(v) }, l)));
export function toggle(title, sub, checked, onChange) {
  return h("label", { class: "switch" }, h("span", {}, h("b", {}, title), sub ? h("small", {}, sub) : null),
    h("input", { type: "checkbox", role: "switch", checked: !!checked, onchange: (e) => onChange(e.target.checked, e) }));
}
export const ai = () => providerOf(state.settings);

// ---------- views & navigation ----------
export const views = {};
export const TABS = ["today", "courses", "practice", "settings"];

export function go(tab, extra = {}) {
  Object.assign(state, extra);
  state.tab = tab;
  TABS.forEach((t) => {
    const b = $(`#tab-${t}`), on = t === tab;
    b.setAttribute("aria-selected", on); b.tabIndex = on ? 0 : -1;
    $(`#${t}`).hidden = !on;
  });
  rerender();
  window.scrollTo(0, 0);
}
export function rerender() {
  views.banner?.();
  const root = $(`#${state.tab}`);
  Promise.resolve(views[state.tab]?.(root)).catch((e) => toast(e.message, { error: true }));
}
export const openCourse = (id, sub = "overview") => go("courses", { course: id, courseSub: sub });

// ---------- settings / look ----------
export function currentLook() {
  const s = state.settings;
  const look = { ...DEFAULT_LOOK, ...(s.look || {}) };
  if (!s.look && s.darkMode) look.theme = "dark";
  return look;
}
export function applyA11y() {
  const s = state.settings, root = document.documentElement;
  const look = currentLook();
  root.dataset.look = look.theme;
  if (look.accent) root.style.setProperty("--accent", look.accent); else root.style.removeProperty("--accent");
  const f = FONTS[look.font]?.css;
  if (f && !s.readableFont) root.style.setProperty("--font", f); else root.style.removeProperty("--font");
  root.classList.toggle("size-large", s.textSize === "large");
  root.classList.toggle("size-xl", s.textSize === "xl");
  root.classList.toggle("readable", !!s.readableFont);
  root.classList.toggle("contrast", !!s.highContrast);
  root.classList.toggle("reduce-motion", !!s.reduceMotion);
}
export const panelIsDark = () => {
  const t = document.documentElement.dataset.look;
  if (["dark", "midnight", "dim", "liquid-dark"].includes(t)) return true;
  if (["paper", "liquid"].includes(t)) return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
};

export async function saveSettings(patch, quiet = true) {
  state.settings = await send("SAVE_SETTINGS", patch);
  applyA11y();
  if (!quiet) toast("Saved", { ms: 1500 });
}

// ---------- Canvas data ----------
export async function sync(btn) {
  const b = btn || $("#syncBtn");
  b.classList.add("spinning");
  try { state.snapshot = await send("SYNC"); state.lectureCache = {}; toast("Canvas is up to date", { ms: 2000 }); }
  catch (e) { toast(e.message, { error: true, ms: 8000 }); }
  finally { b.classList.remove("spinning"); }
  rerender();
}

// Courses the student hid (clubs, trainings, advising pages) stay out of everything.
// "Mark done" button for a to-do row (Undo in the toast).
export function doneButton(a, courseId = a.course_id) {
  return h("button", { class: "ghost done-btn", "aria-label": `Mark “${a.name}” done`, title: "Mark done (hides it from your to-do list)",
    onclick: async (e) => {
      e.currentTarget.disabled = true;
      await send("MARK_DONE", { courseId, assignmentId: a.id, done: true });
      toast(`Marked “${a.name}” done.`, { ms: 7000, action: { label: "Undo", run: () => send("MARK_DONE", { courseId, assignmentId: a.id, done: false }) } });
    } }, icon("check", 16));
}

export function visibleSnapshot() {
  const hidden = new Set(state.settings.hiddenCourses || []);
  return state.snapshot ? { ...state.snapshot, courses: state.snapshot.courses.filter((c) => !hidden.has(c.id)) } : null;
}
export const courseById = (id) => state.snapshot?.courses.find((c) => c.id === id);
export const courseName = (id) => { const c = courseById(id); return c ? (c.code || c.name) : "Course"; };
export function courseColor(id) {
  const own = state.settings.look?.courseColors?.[id];
  return (own && own !== "none" ? own : null) || state.snapshot?.colors?.[id] || "#8a8a8a";
}

export async function lecturesFor(courseId, { fresh = false } = {}) {
  if (!fresh && state.lectureCache[courseId]) return state.lectureCache[courseId];
  return (state.lectureCache[courseId] = await send("LECTURES", { courseId }));
}

// Canvas often serves file contents from a separate storage host; reading (not just downloading) needs access to it.
export async function askFileHostAccess() {
  const origins = ["https://*.amazonaws.com/*", "https://*.instructure-uploads.com/*"];
  if (await chrome.permissions.contains({ origins }).catch(() => false)) return true;
  return chrome.permissions.request({ origins }).catch(() => false);
}

export async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("Open a Canvas page first.");
  if (/\/quizzes(\/|$)|\/assessments?\/|quiz-lti|\/external_tools\//i.test(tab.url)) throw new Error("That's a quiz or external tool page, so StudyPilot won't read it.");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => (document.querySelector("#content, main, [role=main], article") || document.body).innerText.slice(0, 150000),
  }).catch(() => { throw new Error("Can't read this tab. Try a Canvas page."); });
  if (!result || result.trim().length < 50) throw new Error("This page doesn't have much text to send.");
  const kind = /\/assignments\/\d+/.test(tab.url) ? "assignment" : /\/pages\//.test(tab.url) ? "lecture page" : "page";
  return { title: tab.title, url: tab.url, text: result, kind };
}

// ---------- Video speed (applies to lecture videos on Canvas and your video site) ----------
export function speedControl({ compact = false } = {}) {
  const MIN = 0.25, MAX = 16;
  const stepAt = (r) => (r < 2 ? 0.1 : r < 4 ? 0.25 : r < 8 ? 0.5 : 1);
  const toPos = (r) => Math.log(r / MIN) / Math.log(MAX / MIN), fromPos = (x) => MIN * Math.pow(MAX / MIN, x);
  const snap = (r) => (r < 2 ? Math.round(r * 20) / 20 : r < 4 ? Math.round(r * 4) / 4 : Math.round(r * 2) / 2);
  const clamp = (r) => Math.round(Math.min(MAX, Math.max(MIN, Number(r) || 1)) * 100) / 100;
  const num = h("input", { type: "number", min: MIN, max: MAX, step: 0.05, "aria-label": "Video speed", class: "sp-num" });
  const sl = h("input", { type: "range", min: 0, max: 1, step: 0.001, "aria-label": "Video speed slider", class: "grow" });
  let rate = 1;
  const show = (r) => { rate = r; num.value = String(r); sl.value = toPos(r); };
  const set = (r) => { show(clamp(r)); chrome.storage.local.set({ videoSpeed: rate }); };
  chrome.storage.local.get("videoSpeed").then(({ videoSpeed }) => show(clamp(videoSpeed || 1)));
  sl.oninput = (e) => set(snap(fromPos(Number(e.target.value))));
  num.onchange = (e) => set(e.target.value);
  return h("div", { class: "speed" + (compact ? " compact" : "") },
    compact ? h("span", { class: "speed-label" }, "Speed") : null,
    h("button", { class: "btn small soft", "aria-label": "Slower", onclick: () => set(rate - stepAt(rate - 1e-9)) }, "−"),
    num, h("span", { class: "x" }, "×"),
    h("button", { class: "btn small soft", "aria-label": "Faster", onclick: () => set(rate + stepAt(rate) + 1e-9) }, "+"),
    sl,
    h("button", { class: "btn small soft", onclick: () => set(1) }, "1×"));
}

// Big downloads (over 200 MB) ask first and say how big they are.
export const BIG_DOWNLOAD = 200e6;
export function confirmSize(bytes, what = "This download", extra = "") {
  if (!(bytes > BIG_DOWNLOAD)) return true;
  return confirm(`${what} is about ${fmtBytes(bytes)}.${extra ? " " + extra : ""} Download it?`);
}
