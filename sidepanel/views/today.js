// Today: what's due, what to review, and planning the week.
import { lecturesFor, doneButton } from "../core.js";
import { h, state, views, send, toast, act, ai, plural, relDue, shortDate, visibleSnapshot, openCourse, go, sync, saveSettings, empty, tz, readActiveTab, downloadText, today, courseColor, DAY, rerender } from "../core.js";
import { handToAI } from "../aiflow.js";
import { bank, makeQuiz, makeStudyGuide, lectureScope } from "../sheet.js";
import { examPlan } from "../../lib/examplan.js";
import { openFocusSheet } from "../focus.js";
import { startSession } from "../runner.js";
import { openWork, planPack, studyPagePack } from "../../lib/packs.js";
import { sessionsIcs, deadlinesIcs } from "../../lib/ics.js";
import { buildSession, isDue } from "../../lib/quiz.js";
import { PROVIDERS } from "../../lib/ai.js";
import { canFill, requestFillPermission } from "../../lib/autofill.js";
import { icon } from "../../lib/icons.js";

// ---------- exam countdown ----------
async function countdownCard(exam, allExams, bankAll) {
  const [lectures, { lectureTopics = {} }] = await Promise.all([lecturesFor(exam.courseId).catch(() => []), chrome.storage.local.get("lectureTopics")]);
  const topicsByLecture = Object.fromEntries(Object.entries(lectureTopics).map(([k, v]) => [k, v.topics || []]));
  const P = examPlan({ exam, allExams, lectures, questions: bankAll, topicsByLecture });
  const when = P.days <= 0 ? "today" : P.days === 1 ? "tomorrow" : `in ${P.days} days`;
  const examScope = { kind: "module", courseId: exam.courseId, title: `${exam.title} prep`, lectures: P.lectures };
  const qsFor = () => P.questions;
  const run = async (st) => {
    if (st.kind === "quiz") return makeQuiz(lectureScope(exam.courseId, st.lecture));
    if (st.kind === "guide") return makeStudyGuide(lectureScope(exam.courseId, st.lecture));
    if (st.kind === "missing") return makeQuiz(examScope, { focus: st.topics });
    if (st.kind === "weak") return views.startScope({ kind: "topics", courseId: exam.courseId, topics: st.topics, title: `${exam.title}: weak topics` }, "weak");
    const mode = st.kind === "exam" ? "exam" : st.kind === "review" ? "review" : "practice";
    const picked = buildSession(qsFor(), { mode, count: st.count || 15 });
    if (!picked.length) return toast(mode === "review" ? "Nothing due right now." : "No questions for this exam yet. Make a quiz from a lecture first.", { ms: 6000 });
    startSession(picked, { mode, title: `${exam.title} · ${st.title}`, timed: mode === "exam" });
  };
  const STEP_ICON = { quiz: "spark", guide: "book", missing: "spark", weak: "target", exam: "timer", review: "review", practice: "play" };
  return h("div", { class: "card countdown" },
    h("div", { class: "row" },
      h("div", { class: "grow" }, h("h3", { style: "margin:0" }, `${exam.course}: ${exam.title}`),
        h("div", { class: "meta" }, `${new Date(exam.date).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })} · ${when}`)),
      h("span", { class: "cd-days", "aria-hidden": "true" }, h("b", {}, String(Math.max(0, P.days))), h("small", {}, P.days === 1 ? "day" : "days"))),
    h("div", { class: "cd-ready" }, h("span", { class: "meter wide" }, h("i", { style: `width:${P.ready}%` })), h("small", {}, `About ${P.ready}% ready`)),
    h("div", { class: "meta" }, [P.lectures.length ? plural(P.lectures.length, "lecture") : null,
      P.coverage.total ? `${P.coverage.covered} of ${P.coverage.total} topics practiced` : P.lectures.length ? `${P.lectures.length - P.noQuestions.length} of ${P.lectures.length} lectures practiced` : null,
      P.questions.length ? `${Math.round(P.mastery * 100)}% mastered` : "no questions yet"].filter(Boolean).join(" · ")),
    P.steps.length ? h("div", { class: "field" }, "Today") : null,
    P.steps.map((st) => h("button", { class: "sheet-tile", onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await run(st); } catch (err) { toast(err.message, { error: true, ms: 8000 }); } finally { b.disabled = false; } } },
      h("span", { class: "ico-wrap" }, icon(STEP_ICON[st.kind] || "play", 18)), h("span", { class: "grow" }, h("b", {}, st.title), h("small", {}, st.sub)), icon("chevron", 16))),
    h("div", { class: "actions" },
      h("button", { class: "btn small soft", onclick: () => openFocusSheet({ courseId: exam.courseId }) }, icon("timer", 14), " Focus session"),
      h("button", { class: "btn small soft", onclick: () => { state.exam = { courseId: exam.courseId, modules: null, count: 20, timed: true }; go("practice"); } }, "More exam prep")),
    P.days > 2 ? h("div", { class: "hint" }, "Each day: fill gaps first, then review. The last two days switch to timed practice exams.") : null);
}

// "What changed": due dates moved, new work, new grades, exam dates (since you last cleared it).
const CHANGE_ICON = { new: "spark", moved: "clock", earlier: "clock", grade: "check", regrade: "check", "course-grade": "chart", exam: "calendar", "exam-new": "calendar" };
async function changesCard() {
  const { changes = [], changesClearedAt = 0 } = await chrome.storage.local.get(["changes", "changesClearedAt"]);
  const hidden = new Set(state.settings.hiddenCourses || []);
  const list = changes.filter((c) => c.at > changesClearedAt && !hidden.has(c.courseId));
  if (!list.length) return "";
  const canNotify = await chrome.permissions.contains({ permissions: ["notifications"] }).catch(() => false);
  const shown = state.changesAll ? list : list.slice(0, 5);
  return h("div", { class: "card changes" },
    h("h3", {}, "What changed"),
    shown.map((c) => h("div", { class: "item" + (c.important ? " important" : "") },
      h("span", { class: "dot", style: `background:${courseColor(c.courseId)}` }),
      h("div", { class: "main" },
        c.url ? h("a", { class: "name", href: c.url, target: "_blank" }, c.title) : h("div", { class: "name" }, c.title),
        h("div", { class: "meta" }, h("button", { class: "linkish", onclick: () => openCourse(c.courseId) }, c.course), ` · ${c.detail}`)),
      h("span", { class: "ico-sm", "aria-hidden": "true" }, icon(CHANGE_ICON[c.kind] || "info", 16)))),
    h("div", { class: "actions" },
      h("button", { class: "btn small soft", onclick: async () => { await chrome.storage.local.set({ changesClearedAt: Date.now() }); state.changesAll = false; rerender(); } }, "Got it, clear these"),
      list.length > 5 && !state.changesAll ? h("button", { class: "btn small soft", onclick: () => { state.changesAll = true; rerender(); } }, `Show all ${list.length}`) : null),
    !canNotify && !state.settings.alertsAsked ? h("div", { class: "hint" }, "Want a heads-up when a due date moves earlier, new work is due soon, or an exam date changes? ",
      h("button", { class: "linkish", onclick: async () => {
        const ok = await chrome.permissions.request({ permissions: ["notifications"] }).catch(() => false);
        await saveSettings({ alertsAsked: true, alertsNotify: ok });
        toast(ok ? "You'll get a notification for important changes." : "No notifications. You can turn them on in Settings.");
        rerender();
      } }, "Turn on notifications"), " · ", h("button", { class: "linkish", onclick: async () => { await saveSettings({ alertsAsked: true }); rerender(); } }, "No thanks")) : null);
}

export async function planMyWeek() {
  if (!state.snapshot) state.snapshot = await send("SYNC");
  let busyTimes = [];
  if (state.gcal.connected) busyTimes = await send("GCAL_BUSY").catch(() => []);
  else if (state.settings.icalUrl) {
    try { busyTimes = await send("CAL_FEED_BUSY"); }
    catch (e) { toast(`Couldn't read your calendar link: ${e.message} The plan will ask about your schedule instead.`, { error: true, ms: 9000 }); }
  }
  const exams = (await send("ALL_EXAMS").catch(() => [])).filter((e) => Date.parse(e.date) < Date.now() + ((state.settings.daysAhead || 14) + 21) * 864e5);
  await handToAI(planPack(visibleSnapshot(), state.settings, { tz, busy: busyTimes, exams }), { expect: "plan", title: "Study plan" });
}

async function pushDeadlines() {
  if (state.gcal.connected) { const r = await send("GCAL_PUSH_DEADLINES"); toast(`Added ${r.count} deadlines to Google Calendar`); }
  else { await downloadText(`canvas-deadlines-${today()}.ics`, deadlinesIcs(state.snapshot), "text/calendar"); toast("Open the downloaded file to add deadlines to your calendar.", { ms: 7000 }); }
}

function planCard() {
  const list = state.planSessions;
  if (!list?.length) return null;
  const fmt = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return h("div", { class: "card" }, h("h3", {}, `Your plan: ${plural(list.length, "session")}`),
    h("div", { class: "planlist" }, list.slice(0, 8).map((x) => h("div", { class: "item" }, h("div", { class: "main" },
      h("div", { class: "name" }, x.title), h("div", { class: "meta" }, `${fmt(x.start)} – ${new Date(x.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`), x.goal ? h("div", { class: "meta" }, x.goal) : null)))),
    list.length > 8 ? h("div", { class: "muted" }, `+${list.length - 8} more`) : null,
    h("div", { class: "actions" },
      state.gcal.connected
        ? act("Add to Google Calendar", async () => {
          const r = await send("GCAL_IMPORT_PLAN", { text: JSON.stringify({ sessions: list }) });
          toast(`Added ${r.count} study sessions (earlier StudyPilot sessions were replaced)`); state.planSessions = null; rerender();
        }, { busyLabel: "Adding…", ico: "calendar" })
        : act("Add to calendar", async () => {
          await downloadText(`study-plan-${today()}.ics`, sessionsIcs(list), "text/calendar");
          toast("Open the downloaded file to add the sessions to any calendar app.", { ms: 8000 });
        }, { ico: "calendar" }),
      h("button", { class: "btn soft", onclick: () => { state.planSessions = null; rerender(); } }, "Dismiss")));
}

// Canvas sites StudyPilot can spot in your open tabs (custom school domains are typed in instead).
const NOT_CANVAS = /^(www|community|status|help|guides|canvas-docs|developerdocs|sso)\./i;
async function findCanvasTabs() {
  const tabs = await chrome.tabs.query({ url: "https://*.instructure.com/*" }).catch(() => []);
  const origins = [...new Set(tabs.map((t) => { try { return new URL(t.url).origin; } catch { return null; } }).filter((o) => o && !NOT_CANVAS.test(new URL(o).host)))];
  return origins;
}
async function connectCanvas(url) {
  if (!url.endsWith(".instructure.com")) {
    const ok = await chrome.permissions.request({ origins: [url + "/*"] });
    if (!ok) throw new Error("StudyPilot needs permission to read your Canvas site.");
  }
  await saveSettings({ canvasUrl: url });
  try { state.snapshot = await send("SYNC"); }
  catch (e) { await saveSettings({ canvasUrl: "" }); throw new Error(`Couldn't read your courses from ${new URL(url).host}. Make sure you're logged in to Canvas in a tab, then try again.`); }
  toast(`Connected. Found ${plural(state.snapshot.courses.length, "course")}.`);
  rerender();
}
let watchingTabs = false;
const autoTried = new Set();
let autoError = "";

function welcome(root) {
  const step = state.settings.canvasUrl ? 2 : 1;
  if (step === 1) {
    // Notice Canvas being opened in another tab while this screen is showing.
    if (!watchingTabs) {
      watchingTabs = true;
      chrome.tabs.onUpdated.addListener((id, info, tab) => {
        if (info.status === "complete" && /^https:\/\/[^/]+\.instructure\.com\//.test(tab.url || "") && !state.settings.canvasUrl && state.tab === "today") { autoTried.clear(); rerender(); } // e.g. just logged in: try again
      });
    }
    const box = h("div", { class: "card", style: "text-align:left" },
      h("div", { class: "step" }, h("span", { class: "num" }, "1"), h("h3", { style: "margin:0" }, "Connect Canvas")),
      h("p", { class: "muted", style: "margin:0" }, "Looking for Canvas in your open tabs…"));
    const manual = (open = false) => {
      const input = h("input", { type: "url", id: "welcomeUrl", placeholder: "https://canvas.yourschool.edu", "aria-label": "Canvas address" });
      return h("details", { class: "adv", open },
        h("summary", {}, "Type your Canvas address instead"),
        h("p", { class: "hint", style: "margin-top:4px" }, "Use the address you see when you're logged in to Canvas, like yourschool.instructure.com or canvas.yourschool.edu."),
        input, h("div", { style: "height:8px" }),
        act("Connect", async () => {
          let url;
          try { url = new URL(/^https?:/.test(input.value.trim()) ? input.value.trim() : `https://${input.value.trim()}`).origin; } catch { throw new Error("That doesn't look like a web address."); }
          await connectCanvas(url);
        }, { cls: "btn block", busyLabel: "Connecting…" }));
    };
    findCanvasTabs().then((found) => {
      const body = [];
      // Exactly one Canvas open: connect right away (once; if it fails, show why and let them retry or type it).
      if (found.length === 1 && !autoTried.has(found[0])) {
        autoTried.add(found[0]);
        box.replaceChildren(box.firstChild, h("p", { class: "muted", style: "margin:0" }, `Found ${new URL(found[0]).host}. Connecting…`));
        connectCanvas(found[0]).catch((e) => { autoError = e.message; rerender(); });
        return;
      }
      if (autoError) body.push(h("p", { class: "hint", style: "margin:0 0 8px;color:var(--bad)" }, autoError));
      if (found.length) {
        body.push(h("p", { class: "muted", style: "margin:0 0 10px" }, found.length === 1 ? "Found Canvas in one of your tabs:" : "Found these Canvas sites in your tabs. Pick yours:"),
          ...found.map((o) => act(`Connect ${new URL(o).host}`, () => connectCanvas(o), { cls: "btn block", busyLabel: "Connecting…", attrs: { style: "margin-bottom:6px" } })),
          manual(false));
      } else {
        body.push(h("p", { class: "muted", style: "margin:0 0 6px" }, "Open Canvas in a tab and log in like you normally do. StudyPilot will spot it here automatically."),
          h("div", { class: "hint", style: "margin:0 0 10px" }, "Waiting for Canvas…"),
          manual(false));
      }
      box.replaceChildren(box.firstChild, ...body);
    });
    root.append(h("div", { class: "welcome" },
      h("div", { class: "big", "aria-hidden": "true" }, h("img", { src: "../icons/icon128.png", alt: "", width: 64, height: 64 })),
      h("h2", {}, "Welcome to StudyPilot"),
      h("p", { class: "muted" }, "Your courses, practice quizzes and grades in one place. Works with any AI you like."),
      box));
    return;
  }
  const pick = async (id) => {
    const perm = canFill(id) ? requestFillPermission(id) : null; // permission prompts need the click
    await saveSettings({ aiProvider: id, onboarded: true }); await perm; rerender();
  };
  root.append(h("div", { class: "welcome" },
    h("h2", {}, "Which AI do you use?"),
    h("p", { class: "muted" }, "StudyPilot opens your AI with the request already filled in. You press Send, and quizzes come back here. No account or API key."),
    h("div", { class: "card", style: "text-align:left" },
      h("div", { class: "step" }, h("span", { class: "num" }, "2"), h("h3", { style: "margin:0" }, "Your AI")),
      h("div", { class: "ai-grid" }, ["chatgpt", "claude", "gemini", "copilot"].map((id) =>
        h("button", { class: "btn secondary", onclick: () => pick(id) }, PROVIDERS[id].name))),
      h("button", { class: "btn soft block", style: "margin-top:8px", onclick: () => pick("other") }, "Another AI (set it in Settings)"),
      h("p", { class: "hint" }, "You can change this any time in Settings › Your AI."))));
}

views.today = async (root) => {
  root.replaceChildren();
  if (!state.settings.canvasUrl || (!state.settings.aiProvider && !state.settings.onboarded)) return welcome(root);
  const s = state.snapshot;
  const hour = new Date().getHours();
  root.append(h("div", { class: "hello" }, hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"));
  if (!s) { root.append(empty("refresh", "Getting your courses from Canvas…")); sync(); return; }

  const snap = visibleSnapshot();
  const work = openWork(snap, { daysAhead: 30 });
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const overdue = work.filter((a) => a.overdue).length;
  const dueToday = work.filter((a) => !a.overdue && Date.parse(a.due_at) <= endToday).length;
  const week = work.filter((a) => !a.overdue && Date.parse(a.due_at) <= Date.now() + 7 * DAY).length;
  root.append(h("div", { class: "muted" }, week ? `You have ${plural(week, "thing")} due this week.` : "Nothing due this week. Nice work!"));
  root.append(h("div", { class: "stats", role: "group", "aria-label": "Summary" },
    h("div", { class: "stat red" }, h("b", {}, overdue), h("span", {}, "Overdue")),
    h("div", { class: "stat amber" }, h("b", {}, dueToday), h("span", {}, "Due today")),
    h("div", { class: "stat green" }, h("b", {}, week), h("span", {}, "This week"))));

  root.append(await changesCard());

  // Review due + plan (the two things to do every day)
  const all = await bank();
  const hidden = new Set(state.settings.hiddenCourses || []);
  const due = all.filter((q) => !hidden.has(q.courseId) && q.seen && isDue(q));
  const qa = (ico, title, sub, fn, cls = "") => h("button", { class: "qa " + cls, onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await fn(); } catch (err) { toast(err.message, { error: true, ms: 8000 }); } finally { b.disabled = false; }
  } }, h("div", { class: "ico", "aria-hidden": "true" }, icon(ico, 22)), h("b", {}, title), h("small", {}, sub));
  const p = ai();
  root.append(h("div", { class: "quick" },
    qa("review", due.length ? `Review ${due.length}` : "Review", due.length ? "Questions due today" : all.length ? "All caught up" : "Add questions from a lecture",
      async () => { if (due.length) startSession(buildSession(due, { mode: "review", count: 20 }), { mode: "review", title: "Today's review" }); else go("practice"); }, due.length ? "hot" : ""),
    qa("calendar", "Plan my week", `${p.url ? p.name : "Your AI"} builds a schedule`, planMyWeek),
    qa("pen", "Explain this page", "The Canvas tab you're on", async () => handToAI(studyPagePack(await readActiveTab()), { title: "This page" })),
    qa("clock", "Deadlines → calendar", state.gcal.connected ? "Add to Google Calendar" : "Calendar file for any app", pushDeadlines)));

  const allExams = await send("ALL_EXAMS").catch(() => []);
  const exams = allExams.filter((e) => Date.parse(e.date) < Date.now() + 21 * DAY);
  // Countdown plan for the next exam within two weeks
  const soon = exams.find((e) => Date.parse(e.date) < Date.now() + 15 * DAY);
  if (soon) root.append(await countdownCard(soon, allExams, all).catch(() => ""));
  if (exams.length) root.append(h("div", { class: "card" }, h("h3", {}, "Exams coming up"),
    exams.slice(0, 5).map((e) => {
      const n = Math.round((new Date(new Date(e.date).toDateString()) - new Date(new Date().toDateString())) / DAY);
      return h("div", { class: "item" }, h("span", { class: "dot", style: `background:${courseColor(e.courseId)}` }),
        h("div", { class: "main" }, h("div", { class: "name" }, `${e.course}: ${e.title}`), h("div", { class: "meta" }, new Date(e.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }))),
        h("span", { class: `pill ${n <= 3 ? "now" : n <= 10 ? "soon" : ""}` }, n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`),
        h("button", { class: "btn small soft", onclick: () => { state.exam = { courseId: e.courseId, modules: null, count: 20, timed: true }; go("practice"); } }, "Prep"));
    })));

  const plan = planCard();
  if (plan) root.append(plan);

  const next = h("div", { class: "card" }, h("h3", {}, "Next up"));
  const upcoming = work.slice(0, 7);
  if (!upcoming.length) next.append(h("div", { class: "empty" }, h("span", { class: "big" }, icon("check", 28)), "You're all caught up."));
  upcoming.forEach((a) => {
    const d = relDue(a.due_at, a);
    next.append(h("div", { class: "item" },
      h("span", { class: "dot", style: `background:${courseColor(a.course_id)}` }),
      h("div", { class: "main" },
        h("a", { class: "name", href: a.url, target: "_blank" }, a.name),
        h("div", { class: "meta" }, h("button", { class: "linkish", onclick: () => openCourse(a.course_id) }, a.course), a.points ? ` · ${a.points} pts` : "", " ",
          a.is_quiz ? h("span", { class: "pill quiz" }, "Quiz") : a.kind === "tool" ? h("span", { class: "pill" }, a.kind_label.replace("submitted on ", "")) : null)),
      h("span", { class: `pill ${d.tone}`, title: d.title || null }, d.text), doneButton(a)));
  });
  if (work.length > 7) next.append(h("div", { class: "muted" }, `+${work.length - 7} more`));
  root.append(next);

  if (s.announcements?.length) {
    const names = Object.fromEntries(s.courses.map((c) => [c.id, c.code || c.name]));
    const ann = h("div", { class: "card" }, h("h3", {}, "Recent announcements"));
    s.announcements.filter((a) => !hidden.has(a.course_id)).slice(0, 3).forEach((a) => ann.append(h("div", { class: "item" },
      h("div", { class: "main" }, h("a", { class: "name", href: a.url, target: "_blank" }, a.title),
        h("div", { class: "meta" }, `${names[a.course_id] || ""} · ${shortDate(a.posted_at)}`)))));
    root.append(ann);
  }
  root.append(h("div", { class: "muted", style: "text-align:center" }, `Updated ${new Date(s.fetched_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`));
};
