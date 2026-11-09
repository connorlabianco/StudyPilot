// Settings, grouped: Your AI · Appearance · Canvas pages · Study & quizzes · Connections · Courses · Data & privacy.
import { h, $, state, views, send, toast, act, ai, plural, visibleSnapshot, saveSettings, sync, toggle, seg, currentLook, rerender, relDue,
  shortDate, fmtBytes, downloadText, today, tz, askFileHostAccess, copyText, DAY, speedControl } from "../core.js";
import { handToAI } from "../aiflow.js";
import { makeProjectPack } from "./courses.js";
import { PROVIDERS } from "../../lib/ai.js";
import { DEFAULT_LOOK, SWATCHES, THEMES, FONTS, isDarkTheme } from "../../lib/look.js";
import { openWork, exportPack, exportIsEmpty, PROJECT_INSTRUCTIONS } from "../../lib/packs.js";
import { deadlinesIcs } from "../../lib/ics.js";
import { normalizeFeedUrl } from "../../lib/ical.js";
import { normalizeHubUrl } from "../../lib/jupyter.js";
import { allQuestions, exportBank, importBank, putQuestions, clearPractice, allQuizzes, importQuizzes, putQuizzes } from "../../lib/quiz.js";
import { canFill, requestFillPermission, hasFillPermission } from "../../lib/autofill.js";

function group(id, title, sub, ...kids) {
  const open = state.settingsOpen === id;
  return h("details", { class: "card group", open, ontoggle: (e) => { if (e.target.open) state.settingsOpen = id; } },
    h("summary", {}, h("b", {}, title), h("small", {}, sub)), h("div", { class: "group-body" }, ...kids));
}
const sw = (key, title, sub) => toggle(title, sub, !!state.settings[key], (v) => saveSettings({ [key]: v }));
function field(key, label, type = "text", attrs = {}) {
  const id = `set-${key}`;
  return [h("label", { class: "field", for: id }, label),
    h("input", { id, type, value: state.settings[key] ?? "", ...attrs, onchange: (e) => saveSettings({ [key]: type === "number" ? Number(e.target.value) : e.target.value.trim() }, false) })];
}

views.settings = async (root) => {
  root.replaceChildren();
  const s = state.settings;
  root.append(h("h2", { class: "page-title" }, "Settings"));

  // ---- Account & sync ----
  if (state.sync?.ready !== false) root.append(syncGroup()); // hidden in copies without Google sign-in set up

  // ---- Your AI ----
  const p = ai();
  root.append(group("ai", "Your AI", p.id === "none" ? "Copy only" : p.name,
    h("p", { class: "muted", style: "margin-top:0" }, "StudyPilot opens your AI in a new tab with the request ready. You press Send; quizzes and plans come back here when you copy the reply."),
    h("div", { class: "ai-grid" }, Object.entries(PROVIDERS).map(([id, x]) =>
      h("button", { class: "btn secondary" + (p.id === id ? " on" : ""), "aria-pressed": p.id === id, onclick: async () => {
        const perm = state.settings.aiAutofill !== false && canFill(id) ? requestFillPermission(id) : null; // must start inside the click
        await saveSettings({ aiProvider: id }); await perm; rerender();
      } }, id === "other" ? "Other" : id === "none" ? "Just copy" : x.name))),
    p.id === "other" ? h("div", {}, ...field("aiName", "Name"), ...field("aiUrl", "Address to open", "url", { placeholder: "https://…" })) : null,
    canFill(p.id) ? fillToggle(p) : null,
    toggle("Pick up replies automatically", "When you come back after copying a reply, StudyPilot reads it from the clipboard. Only while it's waiting for one.", s.aiClipboard !== false, (v) => saveSettings({ aiClipboard: v }))));

  // ---- Appearance ----
  root.append(group("look", "Appearance", "Theme, colors, text size",
    h("div", { class: "field" }, "Text size"),
    seg([["normal", "Normal"], ["large", "Large"], ["xl", "Extra large"]], s.textSize || "normal", async (v) => { await saveSettings({ textSize: v }); rerender(); }, "Text size"),
    h("div", { style: "height:6px" }),
    sw("readableFont", "Easy-to-read font", "Atkinson Hyperlegible with extra spacing, helpful for dyslexia"),
    sw("highContrast", "High contrast", "Stronger colors and borders"),
    sw("reduceMotion", "Reduce motion", "Turn off animations"),
    lookCard()));

  // ---- Canvas pages ----
  root.append(group("canvas", "Canvas pages", "What StudyPilot adds to Canvas",
    sw("dashTodo", "Due-soon list on the dashboard", "What's due today and this week"),
    sw("replaceTodo", "Announcements instead of Canvas's To Do", "Recent announcements, unread first"),
    sw("replaceFeedback", "Recent grades instead of Recent Feedback", "New grades with scores; click to see your submission"),
    sw("hideDone", "Hide items I check off", "Only affects StudyPilot, not Canvas"),
    sw("cardBadges", "Badges on course cards", "Your grade and what's due this week"),
    sw("lectureButtons", "Practice buttons on lectures", "On lecture pages, slides and each module"),
    h("div", { class: "subhead" }, "Lecture video speed"),
    toggle("Speed control on videos and audio", "A small control on each lecture video or audio player, 0.25x to 16x. Keys: S slower, D faster, R reset. Changes playback speed only; nothing is skipped.", s.videoSpeedOn !== false, (v) => saveSettings({ videoSpeedOn: v })),
    speedControl(),
    toggle("Also on YouTube and Kaltura videos", "For lecture videos hosted there (asks for access to those sites)", !!s.videoSpeedMore, async (v, e) => {
      if (v && !(await chrome.permissions.request({ origins: ["https://www.youtube.com/*", "https://www.youtube-nocookie.com/*", "https://*.kaltura.com/*"] }).catch(() => false))) { e.target.checked = false; return; }
      await saveSettings({ videoSpeedMore: v });
    }),
    toggle("On every website", "Any video or audio anywhere, including mp3 files opened in a tab (asks for access to all sites; StudyPilot only adds the speed control there)", !!s.videoSpeedEverywhere, async (v, e) => {
      if (v && !(await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] }).catch(() => false))) { e.target.checked = false; return; }
      await saveSettings({ videoSpeedEverywhere: v });
    }),
    h("p", { class: "hint" }, s.videoSpeedEverywhere ? "Works on every website. For audio or video files on your computer, also turn on “Allow access to file URLs” for StudyPilot in chrome://extensions." : s.videoHost ? `Works on Canvas and ${s.videoHost}.` : "Works on Canvas. Connect your lecture video site (Connections) to use it there too."),
    h("p", { class: "hint" }, "Above about 4x, Chrome mutes the sound; 16x is the most Chrome allows.")));

  // ---- Study & quizzes ----
  root.append(group("study", "Study & quizzes", "Question count, difficulty, study hours",
    h("div", { class: "row" },
      h("div", { class: "grow" }, h("label", { class: "field", for: "set-qc" }, "Questions per request"),
        h("select", { id: "set-qc", onchange: (e) => saveSettings({ quizCount: Number(e.target.value) }) }, [5, 10, 15, 20, 30].map((n) => h("option", { value: n, selected: (s.quizCount || 10) === n }, String(n))))),
      h("div", { class: "grow" }, h("label", { class: "field", for: "set-qd" }, "Difficulty"),
        h("select", { id: "set-qd", onchange: (e) => saveSettings({ quizDifficulty: e.target.value }) },
          [["introductory", "Easier"], ["mixed", "Mixed"], ["exam-level", "Exam-level"]].map(([v, l]) => h("option", { value: v, selected: (s.quizDifficulty || "mixed") === v }, l))))),
    h("div", { class: "field" }, "For Plan my week"),
    h("div", { class: "row" }, h("div", { class: "grow" }, field("studyStart", "Start after", "time")), h("div", { class: "grow" }, field("studyEnd", "Stop by", "time"))),
    h("div", { class: "row" }, h("div", { class: "grow" }, field("maxHoursPerDay", "Max hours/day", "number", { min: 1, max: 12 })),
      h("div", { class: "grow" }, field("sessionMinutes", "Session (min)", "number", { min: 15, max: 180, step: 15 })),
      h("div", { class: "grow" }, field("daysAhead", "Plan days", "number", { min: 3, max: 30 }))),
    h("label", { class: "field", for: "set-notes" }, "Anything your AI should know"),
    h("textarea", { id: "set-notes", rows: 3, placeholder: "e.g. I work Tue/Thu evenings. My next midterm is on the 18th.", onchange: (e) => saveSettings({ notes: e.target.value }, false) }, s.notes || "")));

  // ---- Alerts & focus ----
  root.append(group("alerts", "Alerts & focus", "Change notifications, focus timer", ...(await alertsSection())));

  // ---- Connections ----
  root.append(group("connections", "Connections", "Canvas, calendar, Gradescope, videos, JupyterHub",
    h("div", { class: "subhead" }, "Canvas"),
    ...field("canvasUrl", "Canvas address", "url", { placeholder: "https://yourschool.instructure.com" }),
    h("details", { class: "adv" }, h("summary", {}, "Advanced: access token"),
      h("p", { class: "hint" }, "Only needed if syncing fails while you're logged in. Canvas › Account › Settings › + New Access Token. Stored only in this browser. Never share it."),
      ...field("canvasToken", "Access token", "password")),
    h("button", { class: "btn small soft block", style: "margin-top:8px", onclick: (e) => sync(e.currentTarget) }, "Sync now"),
    calendarSection(),
    jupyterSection(),
    gradescopeSection(),
    videoSection()));

  // ---- Courses ----
  if (state.snapshot) {
    const hidden = new Set(s.hiddenCourses || []);
    root.append(group("courses", "Courses", `${state.snapshot.courses.length - hidden.size} shown`,
      toggle("Only my favorite courses", "The courses you starred in Canvas. If you haven't starred any, your dashboard courses are used.", s.onlyFavorites !== false, async (v) => { await saveSettings({ onlyFavorites: v }); await sync(); }),
      h("p", { class: "muted" }, "Turn off anything that isn't a class (trainings, advising pages, clubs)."),
      h("div", { class: "checks" }, state.snapshot.courses.map((c) => h("label", {},
        h("input", { type: "checkbox", checked: !hidden.has(c.id), onchange: async (e) => {
          const set = new Set(state.settings.hiddenCourses || []); e.target.checked ? set.delete(c.id) : set.add(c.id);
          await saveSettings({ hiddenCourses: [...set] });
        } }),
        h("span", { class: "grow" }, c.name), h("small", {}, plural(c.assignments.length, "assignment")))))));
  }

  // ---- Data & privacy ----
  root.append(group("data", "Data & privacy", "Backups, background prep, clearing data", ...dataSection()));
};

async function alertsSection() {
  const s = state.settings;
  const can = await chrome.permissions.contains({ permissions: ["notifications"] }).catch(() => false);
  return [
    h("p", { class: "muted", style: "margin-top:0" }, "Today shows what changed since you last looked: due dates that moved, new work, new grades and exam dates."),
    toggle("Notify me about important changes", "A due date moved earlier, new work due within a week, or an exam date changed", can && s.alertsNotify !== false, async (v, e) => {
      if (v && !(await chrome.permissions.request({ permissions: ["notifications"] }).catch(() => false))) { e.target.checked = false; return; }
      await saveSettings({ alertsNotify: v, alertsAsked: true }); rerender();
    }),
    can && s.alertsNotify !== false ? toggle("Also when a grade is posted", "", !!s.alertsGrades, (v) => saveSettings({ alertsGrades: v })) : null,
    ...focusSettings(can),
  ].filter(Boolean);
}
function focusSettings(can) {
  const s = state.settings;
  return [
    h("div", { class: "subhead" }, "Focus timer"),
    h("p", { class: "hint", style: "margin-top:0" }, "Start it from the timer button at the top. Focus time is saved per course and shown in Practice."),
    toggle("Chime when time's up", "Plays while this panel is open", s.focusSound !== false, (v) => saveSettings({ focusSound: v })),
    can ? toggle("Notification when time's up", "Even with the panel closed", s.focusNotify !== false, (v) => saveSettings({ focusNotify: v })) : null,
  ];
}

// Typing the request into the AI's chat box (needs permission for that one site).
function fillToggle(p) {
  const status = h("small", { class: "hint" });
  const t = toggle("Fill it in for me", `Puts the request and any slides straight into ${p.name}'s chat box. You still check it and press Send.`, state.settings.aiAutofill !== false, async (v, e) => {
    if (v) {
      const ok = await requestFillPermission(p.id);
      if (!ok) { e.target.checked = false; toast(`Without access to ${p.name}, StudyPilot will copy instead.`); return; }
    }
    await saveSettings({ aiAutofill: v }); rerender();
  });
  if (state.settings.aiAutofill !== false) hasFillPermission(p.id).then((ok) => { status.textContent = ok ? "" : `Turn this off and on again to allow access to ${p.name}.`; });
  return h("div", {}, t, status);
}

// ---------- Calendar ----------
function calendarSection() {
  const s = state.settings;
  const oauthReady = !chrome.runtime.getManifest().oauth2?.client_id?.startsWith("YOUR_");
  const feed = h("input", { type: "url", id: "icalUrl", placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics", value: s.icalUrl || "", "aria-label": "Private calendar link" });
  const status = h("div", { class: "hint" }, s.icalUrl ? "Plans work around your busy times from this calendar." : "");
  return h("div", {},
    h("div", { class: "subhead" }, "Calendar"),
    h("p", { class: "muted", style: "margin-top:0" }, "So Plan my week works around your classes and work. Paste your calendar's private link once."),
    h("details", { class: "adv" }, h("summary", {}, "Where do I find it?"),
      h("ol", { class: "steps-list" },
        h("li", {}, "Google Calendar on a computer: Settings › click your calendar under “Settings for my calendars”."),
        h("li", {}, "Scroll to “Integrate calendar” and copy “Secret address in iCal format”."),
        h("li", {}, "Outlook: Settings › Calendar › Shared calendars › Publish a calendar › ICS link. Apple iCloud: share the calendar publicly and copy the link.")),
      h("p", { class: "hint" }, "Keep this link private. StudyPilot stores it only in this browser and only reads start and end times, not event names.")),
    h("label", { class: "field", for: "icalUrl" }, "Private calendar link"), feed,
    h("div", { class: "actions" },
      act(s.icalUrl ? "Update" : "Save and test", async () => {
        let url;
        try { url = normalizeFeedUrl(feed.value); } catch (err) { throw new Error(err.message || "That doesn't look like a calendar link."); }
        if (!(await chrome.permissions.request({ origins: [new URL(url).origin + "/*"] }))) throw new Error("StudyPilot needs permission to read that calendar link.");
        const b = await send("CAL_FEED_BUSY", { url });
        await saveSettings({ icalUrl: url });
        status.textContent = `Connected: ${plural(b.length, "busy block")} in the next ${state.settings.daysAhead} days.`;
      }, { cls: "btn small", busyLabel: "Checking…" }),
      s.icalUrl ? h("button", { class: "btn small secondary", onclick: async () => { await saveSettings({ icalUrl: "" }); rerender(); } }, "Remove") : null),
    status,
    h("div", { class: "field" }, "Google Calendar (adds events for you)"),
    !oauthReady ? h("p", { class: "hint" }, "Not set up in this copy of StudyPilot. You don't need it: Plan my week and deadlines can give you a calendar file for any app.")
      : state.gcal.connected
        ? h("div", {}, h("div", { class: "row" }, h("div", { class: "grow" }, "Connected", state.gcal.email ? h("div", { class: "meta" }, state.gcal.email) : null),
            act("Disconnect", async () => { await send("GCAL_DISCONNECT"); state.gcal = { connected: false }; rerender(); }, { cls: "btn small secondary" })),
          h("div", { class: "actions" },
            act("Add deadlines", async () => { const r = await send("GCAL_PUSH_DEADLINES"); toast(`Added ${r.count} deadlines`); }, { cls: "btn small soft", busyLabel: "Adding…" }),
            act("Remove deadlines", async () => { const r = await send("GCAL_REMOVE", { kind: "deadline" }); toast(`Removed ${r.count} deadline events`); }, { cls: "btn small soft" }),
            act("Remove sessions", async () => { const r = await send("GCAL_REMOVE", { kind: "session" }); toast(`Removed ${r.count} study sessions`); }, { cls: "btn small soft" })))
        : act("Connect Google Calendar", async () => { await send("GCAL_CONNECT"); state.gcal = await send("GCAL_STATUS"); toast("Google Calendar connected"); rerender(); }, { cls: "btn small block", busyLabel: "Opening Google…" }),
    h("button", { class: "btn small soft block", style: "margin-top:8px", onclick: () => {
      if (!state.snapshot) return toast("Sync Canvas first.", { error: true });
      downloadText(`canvas-deadlines-${today()}.ics`, deadlinesIcs(state.snapshot), "text/calendar"); toast("Open the file to import into any calendar app.");
    } }, "Download deadlines as a calendar file"));
}

// ---------- JupyterHub ----------
function jupyterSection() {
  const s = state.settings;
  const box = h("div", {}, h("div", { class: "subhead" }, "JupyterHub"));
  if (!s.jupyterUrl) {
    const input = h("input", { type: "url", id: "hubUrl", placeholder: "https://datahub.yourschool.edu", "aria-label": "JupyterHub address" });
    chrome.tabs.query({}).then((tabs) => { const t = tabs.find((x) => /\/(hub|user)\/[^/]*\/?/.test(x.url || "") && /^https:/.test(x.url || "")); if (t && !input.value) input.value = normalizeHubUrl(t.url); });
    box.append(h("p", { class: "muted", style: "margin-top:0" }, "For classes with notebooks. No password or token needed; StudyPilot uses your normal login."), input,
      act("Connect", async () => {
        let base;
        try { base = normalizeHubUrl(input.value.startsWith("http") ? input.value : "https://" + input.value); } catch { throw new Error("That doesn't look like a web address."); }
        if (!(await chrome.permissions.request({ origins: [new URL(base).origin + "/*"] }))) throw new Error("StudyPilot needs permission for that site to read your files.");
        await saveSettings({ jupyterUrl: base });
        state.jup = { status: null, links: null, scan: null };
        toast("Connected. Pick folders on each course's Files page.", { ms: 6000 }); rerender();
      }, { cls: "btn small block", busyLabel: "Connecting…", attrs: { style: "margin-top:8px" } }));
    return box;
  }
  const extra = h("input", { type: "url", placeholder: "Paste a course “git-pull” link", "aria-label": "Add a course link" });
  box.append(h("div", { class: "row" }, h("div", { class: "grow" }, new URL(s.jupyterUrl).host, h("div", { class: "meta" }, "Notebooks appear on each course's Files page.")),
      h("button", { class: "btn small secondary", onclick: async () => { await saveSettings({ jupyterUrl: "", jupyterCourseFolders: {} }); state.jup = { status: null, links: null, scan: null }; rerender(); } }, "Disconnect")),
    toggle("Get the latest course files first", "Runs your classes' “Open in Jupyter” links before downloading or practicing. Your own edits are kept.", s.jupyterPullFirst !== false, (v) => saveSettings({ jupyterPullFirst: v })),
    h("div", { class: "row" }, h("div", { class: "grow" }, extra), h("button", { class: "btn small secondary", onclick: async () => {
      const url = extra.value.trim();
      if (!/git-pull/.test(url) || new URL(url).host !== new URL(s.jupyterUrl).host) return toast("That isn't a git-pull link for your hub.", { error: true });
      await saveSettings({ jupyterPullLinks: [...new Set([...(s.jupyterPullLinks || []), url])] }); state.jup.links = null; extra.value = ""; toast("Link added");
    } }, "Add")),
    (s.jupyterPullLinks || []).length ? h("div", { class: "hint" }, `${plural(s.jupyterPullLinks.length, "link")} you added`) : null);
  return box;
}

// ---------- Account & sync ----------
function syncGroup() {
  const st = state.sync || {};
  const ago = (t) => { const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const body = [];
  if (st.ready === false) body.push(h("p", { class: "muted", style: "margin-top:0" }, "Google sign-in isn't set up in this copy of StudyPilot yet. Whoever installed it needs to add a Google sign-in ID (see SETUP-GOOGLE.md)."));
  else if (!st.account) body.push(
    h("p", { class: "muted", style: "margin-top:0" }, "Sign in to keep your quizzes, progress, grade calculators, exam dates and settings the same on every computer where you use Chrome."),
    act("Sign in with Google", async () => { const r = await send("SYNC_SIGN_IN"); state.sync = await send("SYNC_STATUS"); state.bank = null; toast(`Signed in. Synced ${plural(r.state?.questions || 0, "question")}.`); rerender(); }, { cls: "btn block", busyLabel: "Signing in…" }),
    h("p", { class: "hint" }, "Your data goes to a private StudyPilot folder in your own Google Drive. It doesn't appear in your files, and only StudyPilot can open it. Nothing goes to any other server."));
  else body.push(
    h("div", { class: "row" }, h("div", { class: "grow" }, h("b", {}, st.account.email || "Signed in"),
      h("div", { class: "meta" }, st.state?.at ? `Synced ${ago(st.state.at)} · ${plural(st.state.questions || 0, "question")}, ${plural(st.state.quizzes || 0, "quiz", "quizzes")}` : "Not synced yet"))),
    h("div", { class: "actions" },
      act("Sync now", async () => { await send("SYNC_NOW"); state.sync = await send("SYNC_STATUS"); state.bank = null; toast("Synced"); rerender(); }, { cls: "btn small", ico: "refresh", busyLabel: "Syncing…" }),
      act("Sign out", async () => { if (!confirm("Sign out? Your data stays on this computer and in your Drive.")) return; await send("SYNC_SIGN_OUT"); state.sync = await send("SYNC_STATUS"); rerender(); }, { cls: "btn small secondary" })),
    h("p", { class: "hint" }, "Syncs every 30 minutes, after practice, and when you change settings. Your Canvas access token (if you added one) stays on this computer."));
  return group("sync", "Account & sync", st.account ? st.account.email : "Sign in to sync between computers", ...body);
}

// ---------- Lecture videos (Panopto) ----------
function videoSection() {
  const s = state.settings;
  const box = h("div", {}, h("div", { class: "subhead" }, "Lecture videos"));
  const input = h("input", { type: "text", placeholder: "e.g. yourschool.hosted.panopto.com", value: s.videoHost || "", "aria-label": "Panopto address" });
  box.append(h("p", { class: "muted", style: "margin-top:0" }, "If your classes are recorded in Panopto (sometimes under a school name), StudyPilot can read the captions so recorded lectures work like slides."),
    h("div", { class: "row" }, h("div", { class: "grow" }, input),
      act("Find it", async () => { const r = await send("VIDEO_DETECT"); if (r.host) { input.value = r.host; toast(`Found ${r.host}`); } else toast("No Panopto links found in your courses. Type the address from a recording's link.", { ms: 7000 }); }, { cls: "btn small soft", busyLabel: "Looking…" })),
    h("div", { class: "actions" },
      h("button", { class: "btn small", onclick: async () => {
        let host;
        try { host = new URL(/^https?:/.test(input.value.trim()) ? input.value.trim() : `https://${input.value.trim()}`).host.toLowerCase(); } catch { return toast("That doesn't look like an address.", { error: true }); }
        if (!/panopto/.test(host) && !confirm(`${host} doesn't look like a Panopto site. Use it anyway?`)) return;
        if (!(await chrome.permissions.request({ origins: [`https://${host}/*`] }).catch(() => false))) return toast("StudyPilot needs access to that site to read captions.", { error: true });
        await saveSettings({ videoHost: host }); state.videoCache = {}; toast("Connected. Recordings show on each course's Lectures page."); rerender();
      } }, s.videoHost ? "Update" : "Connect"),
      s.videoHost ? h("button", { class: "btn small secondary", onclick: async () => { await chrome.permissions.remove({ origins: [`https://${s.videoHost}/*`] }).catch(() => {}); await saveSettings({ videoHost: "" }); state.videoCache = {}; rerender(); } }, "Disconnect") : null));
  return box;
}

// ---------- Gradescope ----------
function gradescopeSection() {
  const GS_ORIGINS = ["https://www.gradescope.com/*"];
  const box = h("div", {}, h("div", { class: "subhead" }, "Gradescope"));
  chrome.permissions.contains({ origins: GS_ORIGINS }).then((ok) => {
    if (!ok) {
      box.append(h("p", { class: "muted", style: "margin-top:0" }, "Download your submitted work with graded copies. StudyPilot only reads, using your own Gradescope login."),
        h("button", { class: "btn small block", onclick: async () => { if (await chrome.permissions.request({ origins: GS_ORIGINS }).catch(() => false)) { state.gsCache = {}; rerender(); } } }, "Connect Gradescope"));
      return;
    }
    const all = state.gsAll;
    box.append(h("div", { class: "row" }, h("div", { class: "grow" }, "Connected", h("div", { class: "meta" }, "Each course's Files page has its Gradescope work. Work you turned in there no longer shows as overdue.")),
      h("button", { class: "btn small secondary", onclick: async () => { await chrome.permissions.remove({ origins: GS_ORIGINS }); state.gsCache = {}; state.gsAll = null; rerender(); } }, "Disconnect")));
    if (!all) {
      box.append(act("Download everything from Gradescope…", async () => { state.gsAll = await send("GS_ALL_COURSES"); state.gsPick = new Set((state.gsAll.courses || []).map((g) => g.id)); rerender(); },
        { cls: "btn small soft block", ico: "download", busyLabel: "Loading your courses…", attrs: { style: "margin-top:8px" } }));
      return;
    }
    if (all.state === "login") {
      box.append(h("div", { class: "note" }, "Log in to Gradescope first. ", h("button", { class: "linkish", onclick: () => send("GS_LOGIN") }, "Open Gradescope"), " then try again."),
        h("button", { class: "btn small soft", onclick: () => { state.gsAll = null; rerender(); } }, "Try again"));
      return;
    }
    const terms = new Map();
    for (const g of all.courses || []) { const t = g.term || "Other"; if (!terms.has(t)) terms.set(t, []); terms.get(t).push(g); }
    const P = state.gsPick;
    box.append(h("p", { class: "muted" }, "Every course you pick goes into one zip, by term, course and assignment: graded copies when ready, otherwise what you turned in. Chrome asks where to save it."),
      ...[...terms].map(([term, list]) => h("div", {}, h("div", { class: "field" }, term),
        h("div", { class: "checks" }, list.map((g) => h("label", {},
          h("input", { type: "checkbox", checked: P.has(g.id), onchange: (e) => { e.target.checked ? P.add(g.id) : P.delete(g.id); } }),
          h("span", { class: "grow" }, h("b", {}, g.short), h("br"), h("small", {}, g.name))))))),
      h("div", { class: "actions" },
        act("Download selected…", async () => {
          await askFileHostAccess();
          const r = await send("GS_EXPORT_ALL", { gsIds: [...P] });
          toast(`Saved ${r.zip}: ${plural(r.added, "file")} from ${plural(r.courses, "course")}${r.failed ? `. ${plural(r.failed, "item")} couldn't be added; see “_Not included.txt”.` : "."}`, { ms: 10000 });
        }, { ico: "download", busyLabel: "Zipping…" }),
        h("button", { class: "btn small soft", onclick: () => { state.gsAll = null; rerender(); } }, "Cancel")));
  });
  return box;
}

// ---------- Data ----------
const WANT_LABELS = {
  syllabus: ["Syllabus", "Grading, schedule, policies"], assignments: ["Assignments & rubrics", "Instructions, due dates, scores"],
  modules: ["Module outline", "How each course is organized"], pages: ["Pages & lecture notes", "Full text of course pages"],
  discussions: ["Discussion prompts", "Topics to respond to"], announcements: ["Announcements", "Everything instructors posted"],
  files: ["Course files", "Slides, PDFs, readings (one zip per course)"], myFiles: ["My submissions", "Everything you've turned in"],
};

function dataSection() {
  const s = state.settings;
  const snap = visibleSnapshot();
  const out = [];

  // Background prep
  if (snap) out.push(h("div", { class: "subhead" }, "Prepare lectures in the background"),
    h("p", { class: "muted", style: "margin-top:0" }, "Reads new slides every couple of hours so practice and flashcards are instant. Reading a file can mark it “viewed” in Canvas."),
    h("div", { class: "checks" }, snap.courses.map((c) => h("label", {},
      h("input", { type: "checkbox", checked: (s.libraryCourses || []).includes(c.id), onchange: async (e) => {
        if (e.target.checked) await askFileHostAccess();
        const set = new Set(state.settings.libraryCourses || []); e.target.checked ? set.add(c.id) : set.delete(c.id);
        await saveSettings({ libraryCourses: [...set] });
        if (e.target.checked) send("LIBRARY_SYNC", { courseIds: [c.id] }).catch((err) => toast(err.message, { error: true }));
      } }), h("span", { class: "grow" }, c.name)))));

  // Full backup: one zip with everything, laid out like Canvas
  if (snap) {
    state.backup ??= { courses: new Set(snap.courses.map((c) => c.id)), want: { syllabus: true, assignments: true, modules: true, pages: true, discussions: false, announcements: true, files: false, myFiles: false }, mode: "new" };
    const B = state.backup;
    const courseChecks = () => h("div", { class: "checks" }, snap.courses.map((c) => h("label", {},
      h("input", { type: "checkbox", checked: B.courses.has(c.id), onchange: (e) => { e.target.checked ? B.courses.add(c.id) : B.courses.delete(c.id); rerender(); } }), h("span", { class: "grow" }, c.name))));
    out.push(h("div", { class: "subhead" }, "Back up everything"),
      h("p", { class: "muted", style: "margin-top:0" }, "One zip with every file, page and assignment, organized the way Canvas shows them: a folder per course, then modules and their sections, other files in their Canvas folders, and your own submissions and grades. Chrome asks where to save it."),
      h("details", { class: "adv" }, h("summary", {}, `Courses (${B.courses.size} of ${snap.courses.length})`), courseChecks()),
      state.settings.videoHost ? h("div", { class: "checks" },
        h("label", {}, h("input", { type: "checkbox", checked: B.transcripts !== false, onchange: (e) => { B.transcripts = e.target.checked; } }),
          h("span", { class: "grow" }, h("b", {}, "Lecture video transcripts"), h("br"), h("small", {}, "The captions of each recording, as text files (small)"))),
        h("label", {}, h("input", { type: "checkbox", checked: !!B.videoFiles, onchange: (e) => { B.videoFiles = e.target.checked; } }),
          h("span", { class: "grow" }, h("b", {}, "Lecture video files"), h("br"), h("small", {}, "Very large. Saved next to the zip, only for recordings your instructor allows to be downloaded"))))
        : "",
      act(`Back up ${plural(B.courses.size, "course")}…`, async () => {
        if (!B.courses.size) throw new Error("Pick at least one course.");
        await askFileHostAccess();
        const opts = { courseIds: [...B.courses], transcripts: B.transcripts !== false, videoFiles: !!B.videoFiles };
        const est = await send("FULL_BACKUP", { ...opts, estimate: true });
        const total = est.bytes + (opts.videoFiles ? est.videoBytes : 0);
        const parts = [`${plural(est.items, "item")} (${fmtBytes(est.bytes)})`];
        if (opts.videoFiles && est.videoCount) parts.push(`${plural(est.videoCount, "recording")} (about ${fmtBytes(est.videoBytes)})`);
        if (total > 200e6 && !confirm(`This backup is about ${fmtBytes(total)}: ${parts.join(" and ")}. Continue?`)) return;
        const r = await send("FULL_BACKUP", opts);
        const failed = r.zips.reduce((n, z) => n + z.failed, 0);
        const v = r.videos ? ` Videos: ${r.videos.done} saved${r.videos.notAllowed ? `, ${r.videos.notAllowed} not downloadable` : ""}.` : "";
        toast(`Saved ${r.zips.map((z) => z.name).join(", ")} (${plural(r.items, "item")})${failed ? `. ${plural(failed, "item")} couldn't be added; see “_Not included.txt” inside.` : "."}${v}`, { ms: 12000 });
      }, { cls: "btn block", ico: "download", busyLabel: "Backing up…" }),
      h("p", { class: "hint" }, "Quizzes, tests and outside tools are never opened; locked items are skipped. Both are listed in “_Not included.txt” inside the zip."));

    // Text for an AI (the old export): smaller, and can include only what changed
    out.push(h("div", { class: "subhead" }, "Course text for your AI"),
      h("p", { class: "muted", style: "margin-top:0" }, "The same courses as one readable document (syllabus, assignments, modules, pages, announcements) to paste into any AI, or project packs to add to an AI project."),
      h("details", { class: "adv" }, h("summary", {}, "What to include"),
        h("div", { class: "checks" }, Object.entries(WANT_LABELS).filter(([k]) => k !== "files" && k !== "myFiles").map(([k, [label, sub]]) => h("label", {},
          h("input", { type: "checkbox", checked: !!B.want[k], onchange: (e) => { B.want[k] = e.target.checked; } }),
          h("span", { class: "grow" }, h("b", {}, label), h("br"), h("small", {}, sub)))))),
      seg([["new", "Only what's new"], ["all", "Everything"]], B.mode, (v) => { B.mode = v; rerender(); }, "What to include"),
      h("div", { class: "actions" },
        act("Copy for my AI", () => doBackup("ai"), { cls: "btn small", busyLabel: "Gathering…" }),
        act("Download text", () => doBackup("download"), { cls: "btn small secondary", busyLabel: "Gathering…" })),
      act("Make AI project packs", () => makeProjectPack([...B.courses], { onlyNew: B.mode === "new" }), { cls: "btn small soft block", ico: "export", busyLabel: "Building…", attrs: { style: "margin-top:8px" } }),
      h("details", { class: "adv" }, h("summary", {}, "Instructions for an AI project"),
        h("p", { class: "hint" }, "Paste these into your Project, Gem or custom instructions after adding the files."),
        h("button", { class: "btn small secondary", onclick: async () => { await copyText(PROJECT_INSTRUCTIONS); toast("Instructions copied"); } }, "Copy instructions")));
  }

  // Question bank
  const file = h("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try { const text = await f.text(); const list = importBank(text); await putQuestions(list); await putQuizzes(importQuizzes(text)); state.bank = null; toast(`Imported ${plural(list.length, "question")} with their progress`); }
    catch (err) { toast(err.message || "Couldn't read that file.", { error: true }); }
  } });
  out.push(h("div", { class: "subhead" }, "Practice questions"),
    h("p", { class: "muted", style: "margin-top:0" }, "Your quizzes, questions and progress live in this browser. Save a backup to move them to another computer."),
    h("div", { class: "actions" },
      act("Save backup", async () => { const list = await allQuestions(); await downloadText(`studypilot-questions-${today()}.json`, exportBank(list, await allQuizzes()), "application/json"); toast(`Saved ${plural(list.length, "question")}`); }, { cls: "btn small secondary" }),
      h("button", { class: "btn small secondary", onclick: () => file.click() }, "Restore backup"), file),
    act("Clear all practice progress", async () => { if (!confirm("Delete every practice question and your progress? This can't be undone.")) return; await clearPractice(); state.bank = null; toast("Practice data cleared"); }, { cls: "btn small soft block", attrs: { style: "margin-top:8px" } }));

  // Privacy
  out.push(h("div", { class: "subhead" }, "Privacy"),
    h("p", { class: "muted", style: "margin-top:0" }, "Everything stays in your browser. Nothing leaves it until you paste it into your AI or add events to your own calendar."),
    act("Forget backup and download history", async () => { await send("RESET_HISTORY"); toast("History cleared. The next backup includes everything."); }, { cls: "btn small soft block" }),
    act("Clear lecture library", async () => {
      if (!confirm("Forget everything StudyPilot has read from your lectures? It re-reads them when needed.")) return;
      await send("LIBRARY_CLEAR"); state.libraryStats = null; state.lectureCache = {}; toast("Library cleared.");
    }, { cls: "btn small soft block", attrs: { style: "margin-top:6px" } }),
    h("button", { class: "btn small secondary block", style: "margin-top:6px", onclick: async () => {
      if (!confirm("Remove all StudyPilot data from this browser, including practice progress? Canvas and your calendar aren't affected.")) return;
      await send("LIBRARY_CLEAR").catch(() => {}); await clearPractice().catch(() => {}); await chrome.storage.local.clear(); location.reload();
    } }, "Clear all StudyPilot data"));
  return out;
}

async function doBackup(where) {
  const B = state.backup;
  const courseIds = [...B.courses];
  if (!courseIds.length) throw new Error("Pick at least one course.");
  if (!Object.values(B.want).some(Boolean)) throw new Error("Pick at least one thing to include.");
  const { contents, downloads } = await send("EXPORT", { courseIds, want: { ...B.want, files: false, myFiles: false }, mode: B.mode });
  const filesMsg = downloads ? (downloads.zips?.length ? ` Files saved as ${plural(downloads.zips.length, "zip")} in Downloads › StudyPilot.` : downloads.skipped ? " Files already up to date." : "") : "";
  if (B.mode === "new" && contents.some((c) => c.since) && exportIsEmpty(contents)) return toast("Nothing new since your last backup." + filesMsg, { ms: 7000 });
  const text = exportPack(contents, { goal: "study", tz, prefs: state.settings, snapshot: state.snapshot, downloadedFiles: downloads?.done || 0 });
  if (where === "download" || text.length > 500000) {
    await downloadText(`canvas-${contents.some((c) => c.since) ? "update" : "backup"}-${today()}.md`, text);
    toast((where === "download" ? "Downloaded to Downloads › StudyPilot." : "That's a lot, so it was saved as a file. Attach it in your AI or add it to a project.") + filesMsg, { ms: 10000 });
  } else await handToAI(text, { title: "Course backup" });
}

// ---------- Canvas look ----------
async function setLook(patch) {
  await saveSettings({ look: { ...currentLook(), ...patch } });
  document.getElementById("look-card")?.replaceWith(lookCard());
}

function lookPreview(look) {
  const dark = isDarkTheme(look.theme);
  const r = { square: 4, rounded: 12, extra: 20 }[look.radius] ?? 12;
  const snap = visibleSnapshot();
  const course = snap?.courses[0] || { id: 0, name: "Your course", code: "Sync Canvas to see your courses", assignments: [] };
  const work = snap ? openWork(snap, { daysAhead: 14 }) : [];
  const dueThisWeek = (course.assignments || []).filter((a) => a.due_at && !a.submitted && Date.parse(a.due_at) > Date.now() && Date.parse(a.due_at) < Date.now() + 7 * DAY).length;
  const graded = (course.assignments || []).some((a) => a.graded) || (course.current_score ?? 0) > 0;
  const accent = look.accent || (dark ? "#7ab8ff" : "#0770a3");
  const own = look.courseColors?.[course.id];
  const none = look.cardColor === "none" || own === "none";
  const color = (own && own !== "none" ? own : null) || state.snapshot?.colors?.[course.id] || "#2d7d6e";
  const liquidDark = look.theme === "liquid-dark", liquid = look.theme === "liquid" || liquidDark;
  const minimal = look.cardMinimal || look.cardStyle === "minimal";
  const scale = Math.min(140, Math.max(70, look.cardSize || 100)) / 100;
  const heroH = minimal ? 6 : Math.round(54 * scale);
  const overlay = { gradient: "linear-gradient(135deg, rgba(255,255,255,.28), rgba(255,255,255,0) 45%, rgba(0,0,0,.28))",
    glass: "radial-gradient(120% 90% at 0% 0%, rgba(255,255,255,.45), rgba(255,255,255,0) 55%), radial-gradient(90% 80% at 100% 100%, rgba(0,0,0,.25), rgba(0,0,0,0) 60%)" }[look.cardStyle] || "none";
  const bg = liquidDark ? "radial-gradient(160px 110px at 10% 0%, #14244a, transparent 70%), radial-gradient(160px 120px at 100% 0%, #3a1840, transparent 65%), radial-gradient(200px 120px at 55% 120%, #0e3a34, transparent 70%), #0b0f1a"
    : liquid ? "radial-gradient(160px 110px at 10% 0%, #bfe0ff, transparent 70%), radial-gradient(160px 120px at 100% 0%, #ffd6ea, transparent 65%), radial-gradient(200px 120px at 55% 120%, #d3fbe6, transparent 70%), #eef3fa"
    : { dark: "#1b1c1e", midnight: "#08090a", dim: "#2e2f31", paper: "#f7f1e6" }[look.theme] || "#f5f6f8";
  const cardBg = liquidDark ? "rgba(20,24,38,.6)" : liquid ? "rgba(255,255,255,.45)" : dark ? "#232427" : look.theme === "paper" ? "#fffaf0" : "#fff";
  const ink = dark ? "#e8eaed" : "#2d3b45";
  const font = FONTS[look.font]?.css || "Lato, system-ui, sans-serif";
  const dotColor = (id) => { const c = state.settings.look?.courseColors?.[id]; return c && c !== "none" ? c : snap?.colors?.[id] || "#8a8a8a"; };
  return h("div", { class: "look-preview", style: `background:${bg};font-family:${font}`, "aria-label": "Preview" },
    h("div", { class: "lp-nav", style: `background:${liquidDark ? "rgba(12,16,28,.78)" : liquid ? "rgba(28,36,58,.62)" : look.nav || (dark ? "#2a2b2e" : "#394b58")}` }, h("span"), h("span"), h("span")),
    h("div", { class: "lp-main" },
      h("div", { class: "lp-card" + (liquid ? " liquid" : "") + (liquidDark ? " dark" : ""), style: `border-radius:${r}px;background:${cardBg};${liquid ? "" : look.cardStyle === "glass" ? "box-shadow:0 10px 24px -10px rgba(0,0,0,.45)" : minimal ? "box-shadow:none;border:1px solid rgba(127,127,127,.3)" : ""};width:${Math.round(100 * Math.min(1.15, scale))}%;flex:none` },
        h("div", { class: "lp-hero", style: none
          ? `background:${liquid ? "transparent" : "linear-gradient(135deg, rgba(127,127,127,.12), rgba(127,127,127,.03))"};height:${heroH}px;border-radius:${r}px ${r}px 0 0`
          : `background-color:${color};background-image:${minimal ? "none" : liquid ? "linear-gradient(165deg, rgba(255,255,255,.6), rgba(255,255,255,.08) 42%, transparent 60%)" : overlay};opacity:${liquid && !minimal ? .62 : 1};height:${heroH}px;border-radius:${r}px ${r}px 0 0` }),
        h("div", { class: "lp-body" },
          h("div", { class: "lp-title", style: `color:${none ? ink : color}` }, (course.name || "Course").toUpperCase().slice(0, 22)),
          h("div", { class: "lp-sub", style: `color:${ink}` }, course.code || ""),
          h("div", { class: "lp-chips" },
            look.showGrade && course.current_score != null && graded ? h("span", { class: "lp-chip", style: dark ? "background:#2c2f35;color:#e8eaed" : "" }, h("i", { style: `background:${color}` }),
              `${Math.round(course.current_score * 10) / 10}%${course.current_grade ? " " + course.current_grade : ""}`) : null,
            look.showDue && dueThisWeek ? h("span", { class: "lp-chip due", style: dark ? "background:#3e2e14;color:#ffc46b" : "" }, `${dueThisWeek} due this week`) : null))),
      h("div", { class: "lp-due" + (liquid ? " liquid" : "") + (liquidDark ? " dark" : ""), style: `border-radius:${Math.min(r, 14)}px;background:${cardBg};color:${ink}` },
        h("div", { class: "lp-due-head", style: `background:${dark || liquidDark ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.035)"}` }, "Due soon"),
        h("div", { class: "lp-due-tabs" }, h("span", { class: "on", style: `color:${ink}` }, "This week"), h("span", {}, "All")),
        work.length ? work.slice(0, 2).map((a) => h("div", { class: "lp-due-row" }, h("i", { style: `background:${dotColor(a.course_id)}` }),
          h("span", { class: "lp-due-name" }, a.name), h("span", { class: "lp-due-when" }, relDue(a.due_at).text)))
          : h("div", { class: "lp-due-row muted" }, snap ? "Nothing due" : "Sync Canvas first"),
        h("div", { class: "lp-due-foot", style: `color:${accent}` }, "See all →"))));
}

function swatchRow(current, onPick, label) {
  const custom = h("input", { type: "color", value: current || "#e0603d", "aria-label": `Custom ${label} color`, onchange: (e) => onPick(e.target.value) });
  return h("div", { class: "swatches", role: "group", "aria-label": label },
    h("button", { class: "sw-btn none" + (!current ? " on" : ""), title: "Canvas default", "aria-pressed": !current, onclick: () => onPick("") }, "↺"),
    SWATCHES.map(([name, hex]) => h("button", { class: "sw-btn" + (current?.toLowerCase() === hex ? " on" : ""), title: name, "aria-label": name, "aria-pressed": current?.toLowerCase() === hex, style: `background:${hex}`, onclick: () => onPick(hex) })),
    h("label", { class: "sw-btn custom", title: "Custom color" }, "＋", custom));
}

function lookCard() {
  const look = currentLook();
  if (look.cardStyle === "minimal") { look.cardStyle = "classic"; look.cardMinimal = true; }
  const segL = (key, options) => seg(options, look[key], (v) => setLook({ [key]: v }));
  const tog = (key, title, sub) => toggle(title, sub, !!look[key], (v) => setLook({ [key]: v }));
  const courses = (state.snapshot?.courses || []).filter((c) => !(state.settings.hiddenCourses || []).includes(c.id));
  const courseRows = courses.map((c) => {
    const own = look.courseColors?.[c.id];
    const cur = (own && own !== "none" ? own : null) || state.snapshot?.colors?.[c.id] || "#8a8a8a";
    return h("label", { class: "course-color" + (own === "none" ? " is-none" : "") },
      h("input", { type: "color", value: cur, "aria-label": `${c.name} color`, onchange: (e) => setLook({ courseColors: { ...(look.courseColors || {}), [c.id]: e.target.value } }) }),
      h("span", { class: "grow" }, c.name, own === "none" ? h("small", { class: "muted" }, " · no color") : null),
      own !== "none" ? h("button", { class: "btn small secondary", title: "No color for this course", onclick: (e) => { e.preventDefault(); setLook({ courseColors: { ...(look.courseColors || {}), [c.id]: "none" } }); } }, "No color") : null,
      look.courseColors?.[c.id] ? h("button", { class: "btn small soft", onclick: (e) => { e.preventDefault(); const cc = { ...look.courseColors }; delete cc[c.id]; setLook({ courseColors: cc }); } }, "Reset") : null);
  });
  return h("div", { id: "look-card" },
    h("div", { class: "subhead" }, "Theme for Canvas and StudyPilot"),
    h("p", { class: "muted", style: "margin-top:0" }, "Changes show on your open Canvas tabs right away. Pictures keep their real colors."),
    isDarkTheme(look.theme) ? h("div", { class: "note" }, "The title bar and light border around this panel belong to Chrome, so StudyPilot can't color them. To make them dark too, set Chrome to Dark mode. ",
      h("button", { class: "linkish", onclick: () => chrome.tabs.create({ url: "chrome://settings/appearance" }) }, "Open Chrome's appearance settings")) : null,
    lookPreview(look),
    h("div", { class: "seg wrap", role: "group", "aria-label": "Theme" }, THEMES.map(([v, l]) => h("button", { "aria-pressed": look.theme === v, onclick: () => setLook({ theme: v }) }, l))),
    h("div", { class: "field" }, "Accent color (links, buttons)"),
    swatchRow(look.accent, (c) => setLook({ accent: c }), "Accent"),
    h("div", { class: "field" }, "Navigation bar"),
    swatchRow(look.nav, (c) => setLook({ nav: c }), "Navigation bar"),
    h("div", { class: "field" }, "Course cards"),
    segL("cardStyle", [["classic", "Classic"], ["gradient", "Gradient"], ["glass", "Glass"]]),
    h("div", { class: "slider-row" },
      h("label", { for: "cardSize" }, "Size"),
      h("input", { type: "range", id: "cardSize", min: 70, max: 140, step: 5, value: look.cardSize || 100, "aria-valuetext": `${look.cardSize || 100}%`,
        oninput: (e) => { e.target.nextSibling.textContent = `${e.target.value}%`; },
        onchange: (e) => setLook({ cardSize: Number(e.target.value) }) }),
      h("output", { for: "cardSize" }, `${look.cardSize || 100}%`)),
    tog("cardMinimal", "Minimal cards", "No picture area: a thin color strip, the course name and its buttons"),
    h("div", { style: "height:6px" }),
    segL("radius", [["square", "Square"], ["rounded", "Rounded"], ["extra", "Extra round"]]),
    h("div", { style: "height:6px" }),
    segL("cardColor", [["course", "Course colors"], ["none", "No color"]]),
    tog("hideCardImages", "Hide course images", "Show just the course color"),
    tog("showGrade", "Show my grade on cards"),
    tog("showDue", "Show what's due this week on cards"),
    tog("scrollbars", "Styled scrollbars", "Slim, rounded scrollbars that match your theme"),
    h("div", { class: "field" }, "Font"),
    h("select", { "aria-label": "Font", onchange: (e) => setLook({ font: e.target.value }) }, Object.entries(FONTS).map(([k, f]) => h("option", { value: k, selected: look.font === k }, f.label))),
    courseRows.length ? h("details", { class: "adv", style: "margin-top:10px" }, h("summary", {}, "Course colors"), h("div", { class: "checks" }, courseRows),
      h("p", { class: "hint" }, "Only changes how cards look in your browser; your Canvas colors aren't changed.")) : null,
    h("button", { class: "btn small soft block", style: "margin-top:12px", onclick: () => setLook({ ...DEFAULT_LOOK, courseColors: {} }) }, "Reset to Canvas defaults"));
}
