// Hand-off to the student's own AI (copy, open, paste) and reading its reply back.
import { h, $, send, toast, copyText, state, ai, views, rerender, go, safeFile, plural, act } from "./core.js";
import { download, waitForDownload } from "../lib/dl.js";
import { parseQuizReply, findReplyBlock, parseWeightsReply } from "../lib/ai.js";
import { ledgerFromCanvas } from "../lib/grades.js";
import { toRecords, addQuestions, addQuiz } from "../lib/quiz.js";
import { assignTopics, mergeTopics } from "../lib/topics.js";
import { hasFillPermission, loadFiles, fillTab, pageGrab } from "../lib/autofill.js";
import { replyProgress, redoPrompt } from "../lib/finished.js";
import { icon } from "../lib/icons.js";

const PENDING_KEY = "aiPending";
export const MAX_ATTACH_BYTES = 30e6; // conservative; AI upload limits vary

async function openAI() {
  const p = ai();
  if (p.url) await chrome.tabs.create({ url: p.url, active: true });
  return p;
}

// Writes "StudyPilot/For your AI/<date> <title>/" with the message and files.
async function makeBundle(title, message, files) {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
  const folder = `StudyPilot/For your AI/${stamp} ${safeFile(title).slice(0, 60)}`;
  const mdUrl = URL.createObjectURL(new Blob([message], { type: "text/markdown" }));
  const mdId = await download(mdUrl, `${folder}/Message for your AI.md`);
  setTimeout(() => URL.revokeObjectURL(mdUrl), 60000);
  let failed = 0;
  for (const f of files) { try { await download(f.url, `${folder}/${safeFile(f.name)}`); } catch { failed++; } }
  await waitForDownload(mdId);
  return { folder, mdId, files: files.map((f) => f.name), failed, message };
}

/**
 * Copies `text`, opens the student's AI, and (when `expect` is set) waits for the reply.
 * files: originals the AI should see (slides with handwriting, figures); they're saved to one folder to drag in.
 * chat: { url, fallback } to continue an earlier chat (the one a lecture's checklist came from). `text` is then the
 *   short follow-up; if that chat no longer exists, a new chat is opened with fallback() = { text, files } instead.
 */
export async function handToAI(text, { expect = null, meta = {}, title = "", files = [], chat = null } = {}) {
  await copyText(text); // first, while the panel still has focus
  lastClip = text;
  const p = ai();
  const canFillHere = !!p.url && (await hasFillPermission(p.id));
  let tab = null, reused = false, skip = 0;
  if (chat?.url && p.url) {
    tab = await openChat(chat.url);
    // Only checkable on sites StudyPilot may fill; elsewhere the saved chat is opened and trusted.
    const alive = canFillHere ? await chatAlive(tab.id, chat.url) : { alive: true, blocks: 0 };
    if (alive.alive) { reused = true; skip = alive.blocks; if (!chat.keepFiles) files = []; }
    else {
      const f = await chat.fallback();
      text = f.text; files = f.files || [];
      await copyText(text).catch(() => {}); lastClip = text;
      await chrome.tabs.update(tab.id, { url: p.url, active: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 800)); // let the new-chat page start loading before filling it
      await tabLoaded(tab.id);
    }
  } else if (p.url) tab = await chrome.tabs.create({ url: p.url, active: true });
  if (expect) {
    state.pending = { expect, meta, title, at: Date.now(), tabId: tab?.id ?? null, provider: p.id, skip };
    state.imported = null;
    state.watch = { phase: "send", got: 0, total: 0 };
    await chrome.storage.local.set({ [PENDING_KEY]: state.pending });
    views.banner?.(); // show the waiting bar right away
    const sheet = $("#sheet"); if (sheet?.open) sheet.close();
  }
  // Start watching the AI tab for the reply right away (only on AI sites StudyPilot is allowed to fill).
  const watching = !!(expect && tab && canFillHere);
  if (watching) startWatching();

  // "Fill it in for me": type the request (and attach files) in the AI tab. Never presses Send.
  let fill = null;
  if (tab && state.settings.aiAutofill !== false && canFillHere) {
    try { fill = await fillTab(tab.id, { text, files: files.length ? await loadFiles(files) : [] }); }
    catch (e) { fill = { filled: false, attached: 0, reason: e.message }; }
  }
  const filesDone = !files.length || fill?.attached === files.length;
  if (files.length && !filesDone) {
    state.handoff = await makeBundle(title || "StudyPilot", text, files);
    chrome.downloads.show(state.handoff.mdId);
  } else state.handoff = null;

  const where = !p.url ? "your AI" : reused ? `the same ${p.name} chat as before` : chat ? `a new ${p.name} chat (the earlier one is gone)` : p.name;
  const after = !expect ? "" : watching ? ` StudyPilot will pick up the answer by itself when ${p.name} finishes (or copy it and come back here).` : " When it answers, copy the whole reply and come back here.";
  if (fill?.filled && filesDone) toast(`Ready in ${where}: check it and press Send.${after}`, { ms: 10000 });
  else if (fill?.filled) toast(`Text is in ${where}. Drag the ${plural(files.length, "file")} from the folder that opened into the chat, then press Send.${after}`, { ms: 12000 });
  else if (files.length) toast(`Copied. Drag the ${plural(files.length, "file")} from the folder into ${where}, paste (Ctrl/⌘ + V) and press Enter.${after}`, { ms: 12000 });
  else toast(`Copied. Paste it into ${where} (Ctrl/⌘ + V) and press Enter.${after}`, { ms: 10000 });
  rerender();
}

// ---------- continuing an earlier chat ----------
// The address of a saved conversation (not a new-chat page), per AI site.
const CHAT_RE = {
  chatgpt: /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/(g\/[^/]+\/)?c\/[\w-]+/,
  claude: /^https:\/\/claude\.ai\/chat\/[\w-]+/,
  gemini: /^https:\/\/gemini\.google\.com\/(u\/\d+\/)?app\/\w+/,
  copilot: /^https:\/\/copilot\.microsoft\.com\/chats\/[\w-]+/,
};
/** The chat a reply came from, so later requests for the same lecture can go there too. */
export async function chatOf(pending) {
  if (!pending?.tabId || !CHAT_RE[pending.provider]) return null;
  const t = await chrome.tabs.get(pending.tabId).catch(() => null);
  const m = t?.url && t.url.match(CHAT_RE[pending.provider]);
  return m ? { url: m[0], provider: pending.provider, at: Date.now() } : null;
}
async function openChat(url) {
  const open = (await chrome.tabs.query({}).catch(() => [])).find((t) => (t.url || "").startsWith(url));
  if (open) { await chrome.tabs.update(open.id, { active: true }).catch(() => {}); if (open.windowId != null) chrome.windows?.update(open.windowId, { focused: true }).catch(() => {}); return open; }
  return chrome.tabs.create({ url, active: true });
}
// Loads the chat and checks it's really there (deleted chats redirect to a new chat or show "not found").
// Also counts StudyPilot blocks already in it, so the watcher only picks up the new reply.
const tabLoaded = (tabId) => new Promise((r) => {
  const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(t); r(); };
  const on = (id, info) => { if (id === tabId && info.status === "complete") done(); };
  const t = setTimeout(done, 20000);
  chrome.tabs.onUpdated.addListener(on);
  chrome.tabs.get(tabId).then((x) => { if (x.status === "complete") done(); }).catch(done);
});
async function chatAlive(tabId, url) {
  await tabLoaded(tabId);
  let last = { alive: true, blocks: 0 };
  // Chat sites load the conversation after the page itself: look a few times.
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try { [{ result: last } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: pageChatAlive, args: [url] }); }
    catch { return { alive: false, blocks: 0 }; }
    if (!last?.alive || last.blocks > 0 || last.loaded) break;
  }
  return last || { alive: false, blocks: 0 };
}
// Runs in the AI's page.
function pageChatAlive(saved) {
  const path = (u) => { try { return new URL(u).pathname.replace(/\/+$/, ""); } catch { return ""; } };
  if (path(location.href) !== path(saved)) return { alive: false, blocks: 0 }; // sent somewhere else: the chat is gone
  const text = document.body?.innerText || "";
  const gone = /(conversation|chat) (not found|doesn.t exist|does not exist|could not be found|was deleted|has been deleted)|unable to load (the )?conversation|couldn.t (find|load) (this|that) (chat|conversation)/i.test(text);
  const blocks = [...document.querySelectorAll("pre")].filter((el) => /"(sections|type|sessions|weights)"\s*:/.test(el.textContent || "")).length;
  return { alive: !gone, blocks, loaded: text.length > 400 };
}

export async function cancelPending() {
  state.pending = null;
  state.watch = null;
  stopWatching();
  await chrome.storage.local.remove(PENDING_KEY);
  rerender();
}

// If the lecture menu is open when a reply arrives, redraw it so it shows the new checklist or part.
async function refreshSheet() {
  const dlg = $("#sheet");
  if (!dlg?.open || !state.sheetScope) return;
  const { openSheet } = await import("./sheet.js");
  await openSheet(state.sheetScope).catch(() => {});
}

// ---------- reading the reply ----------
let lastClip = "";
// StudyPilot's own requests contain example blocks; never mistake one for the AI's answer.
const isOwnRequest = (t) => /^\s*# /.test(t) && /(## Reply format|Reply with ONLY one code block)/.test(t);
export async function importReply(text, { quiet = false } = {}) {
  if (isOwnRequest(text)) { if (!quiet) throw new Error("That's the request StudyPilot copied for your AI, not its reply. Send it to your AI, then copy the AI's answer."); return false; }
  const kind = findReplyBlock(text);
  const p = state.pending;
  if (!kind) { if (!quiet) throw new Error("That doesn't look like the reply. Copy the AI's whole answer, including the code block at the end."); return false; }
  // Never import a reply that stopped part-way (the Stop button, a network error, a length limit).
  if (!replyProgress(kind, text).done) {
    if (state.pending) { state.watch = { ...(state.watch || {}), phase: "cut" }; rerender(); }
    throw new Error(`That reply stopped before it finished, so StudyPilot didn't add any of it. Ask your AI to write it again ("Ask to redo" in the banner), then try again.`);
  }
  if (kind === "sizes" || kind === "priorities") {
    const meta = p?.expect === kind ? p.meta : null;
    if (!meta) throw new Error("Start your study plan from Today first, then copy the reply.");
    const P = await import("./plan.js");
    await (kind === "sizes" ? P.importSizes(text, meta) : P.importPriorities(text, meta));
    const chat = await chatOf(p);
    if (chat) await chrome.storage.local.set({ planChat: chat });
    await cancelPending();
    import("./queue.js").then((q) => q.afterReply());
    rerender();
    return true;
  }
  if (kind === "schedule") {
    const meta = p?.expect === "schedule" ? p.meta : null;
    if (!meta?.courses) throw new Error("Open My week and choose “Find class times” first, then copy the reply.");
    const { importSchedule } = await import("./weekai.js");
    await importSchedule(text, meta);
    await cancelPending();
    import("./queue.js").then((q) => q.afterReply());
    rerender();
    return true;
  }
  if (kind === "weights") {
    const meta = p?.expect === "weights" ? p.meta : null;
    if (!meta?.courseId) throw new Error("Open the course's Grades page and choose “Read the weights with my AI” first.");
    const { weights, note } = parseWeightsReply(text);
    const data = await send("GRADE_DATA", { courseId: meta.courseId, skipSyllabus: true });
    data.syllabusWeights = weights;
    data.weightSource = { kind: "ai", name: "your syllabus (read by your AI)" };
    const built = ledgerFromCanvas(data);
    const { ledger = {} } = await chrome.storage.local.get("ledger");
    ledger[meta.courseId] = { ...built, note: built.note + (note ? ` Note: ${note}` : ""), v: 3, at: Date.now(), canvasScore: data.current_score };
    await chrome.storage.local.set({ ledger });
    await cancelPending();
    toast(`Weights added: ${weights.map((w) => `${w.name} ${w.weight}%`).join(", ")}`, { ms: 8000 });
    views.openGrades?.(meta.courseId);
    return true;
  }
  if (kind === "checklist") {
    const meta = p?.expect === "checklist" ? p.meta : null;
    if (!meta?.lecture) throw new Error("Open the lecture and choose “Build the lecture checklist” first, then copy the reply.");
    const { importChecklist } = await import("./mastery.js");
    await importChecklist(text, { ...meta, chat: await chatOf(p) });
    await cancelPending();
    import("./queue.js").then((q) => q.afterReply());
    await refreshSheet();
    rerender();
    return true;
  }
  if (kind === "quiz" && p?.expect === "quiz" && p.meta?.v2) {
    const { importV2, rememberChat } = await import("./mastery.js");
    const records = await importV2(text, p.meta);
    if (!p.meta.letters && p.meta.lecture?.key) await rememberChat(p.meta.lecture.key, await chatOf(p));
    await cancelPending();
    import("./queue.js").then((q) => q.afterReply());
    await refreshSheet();
    if (p.meta.startAfter) {
      const { startSession } = await import("./runner.js");
      await startSession(records, { mode: "assessment", title: `${p.meta.scopeTitle || "Lecture"}: fresh assessment` });
    }
    rerender();
    return true;
  }
  if (kind === "quiz") {
    const meta = p?.expect === "quiz" ? p.meta : state.pasteTarget;
    if (!meta?.courseId) throw new Error("Pick a course for these questions first (Practice › Add questions).");
    const qs = parseQuizReply(text);
    const records = toRecords(qs, { courseId: meta.courseId, lectures: meta.lectures || [] });
    const added = await addQuestions(records);
    // Remember every topic the material covers (per lecture), for coverage and mastery.
    if (qs.topics?.length) {
      const { lectureTopics = {} } = await chrome.storage.local.get("lectureTopics");
      await chrome.storage.local.set({ lectureTopics: mergeTopics(lectureTopics, assignTopics(qs.topics, { lectures: meta.lectures || [], records })) });
    }
    // Every reply becomes a named quiz you can retake ("Quiz 1", "Quiz 2", …).
    const quiz = await addQuiz({ courseId: meta.courseId, lectureKeys: (meta.lectures || []).map((l) => l.key).filter(Boolean), scopeTitle: meta.title || p?.title || "", questionIds: records.map((r) => r.id) });
    state.bank = null;
    state.imported = { count: qs.length, added, meta, quiz, title: `${meta.title || p?.title || ""} · ${quiz.name}` };
    if (p?.expect === "quiz") await cancelPending();
    toast(`${quiz.name} saved: ${plural(records.length, "question")}`, { ms: 5000 });
  } else {
    state.planSessions = await send("PARSE_PLAN", { text });
    if (p?.expect === "plan") await cancelPending();
    toast(`Found ${plural(state.planSessions.length, "study session")} in the plan`);
    go("today");
  }
  rerender();
  return true;
}

// ---------- picking the reply up from the AI's tab ----------
// Every few seconds while a reply is expected: read StudyPilot's code block from the AI tab (only that, read-only),
// and import it once the AI has finished writing (no Stop button, and the text hasn't changed for two checks).
let watchTimer = null, lastSeen = "", sameCount = 0, warned = false;
export function startWatching() {
  clearInterval(watchTimer);
  lastSeen = ""; sameCount = 0; warned = false;
  watchTimer = setInterval(watchOnce, 2500);
  watchOnce();
}
function stopWatching() { clearInterval(watchTimer); watchTimer = null; }
async function watchOnce() {
  const p = state.pending;
  if (!p?.tabId || Date.now() - p.at > 45 * 60e3) return stopWatching();
  let res;
  try { [{ result: res } = {}] = await chrome.scripting.executeScript({ target: { tabId: p.tabId }, func: pageGrab, args: [p.expect, p.skip || 0] }); }
  catch { return; } // tab closed, navigated away, or not allowed: copying still works
  if (!res) return;
  const was = state.watch?.phase;
  if (!res.text) { setWatch({ phase: res.writing ? "thinking" : was === "cut" ? "cut" : "send", got: 0, total: 0 }); return; }
  const prog = replyProgress(p.expect, res.text);
  if (res.writing || res.text !== lastSeen) { lastSeen = res.text; sameCount = 0; setWatch({ phase: "writing", got: prog.got, total: prog.total }); return; }
  if (++sameCount < 2) return; // unchanged for two checks in a row (about 5 seconds)
  // Stopped writing. Only a complete reply counts: interrupted, cut-off or failed replies are left alone.
  if (!prog.done) { setWatch({ phase: "cut", got: prog.got, total: 0, stopped: res.stopped }); return; }
  setWatch({ phase: "reading", got: prog.got, total: prog.total });
  const tag = { quiz: "studypilot-quiz", checklist: "studypilot-checklist", plan: "studypilot-plan", weights: "studypilot-weights", schedule: "studypilot-schedule", sizes: "studypilot-sizes", priorities: "studypilot-priorities" }[p.expect];
  const text = /```/.test(res.text) ? res.text : `\`\`\`${tag}\n${res.text}\n\`\`\``;
  try {
    stopWatching();
    lastClip = text;
    await importReply(text);
  } catch (e) {
    state.watch = { phase: "send", got: 0, total: 0 }; views.banner?.();
    if (!warned) { warned = true; toast(`Found ${ai().name}'s answer but couldn't read it: ${e.message} You can copy it and paste it here instead.`, { error: true, ms: 10000 }); }
  }
}
// Updates the waiting banner in place (no full redraw, so a half-typed paste box isn't lost).
function setWatch(w) {
  const before = state.watch?.phase;
  state.watch = w;
  if (before !== w.phase && (w.phase === "cut" || before === "cut")) return views.banner?.();
  paintWatch();
}
const NOUN = { quiz: "question", checklist: "item", schedule: "class time", sizes: "estimate", priorities: "task" };
function watchText() {
  const p = state.pending, w = state.watch || { phase: "send" }, name = ai().url ? ai().name : "your AI";
  const noun = NOUN[p?.expect];
  const so = noun && w.got ? `${plural(w.got, noun)} so far` : "";
  if (!watchTimer && w.phase !== "cut") return { label: `Waiting for ${name}`, sub: `When it answers, copy its whole reply and come back here.`, pct: null };
  switch (w.phase) {
    case "thinking": return { label: `${name} is thinking…`, sub: "StudyPilot will add the answer by itself when it's done.", pct: null };
    case "writing": return { label: `${name} is writing${so ? `: ${so}` : "…"}`, sub: "Keep this panel open; it's added by itself when it finishes.", pct: w.total ? Math.min(99, (100 * w.got) / w.total) : null };
    case "reading": return { label: `Adding ${so ? plural(w.got, noun) : "the answer"}…`, sub: "", pct: 100 };
    case "cut": return { label: "The reply stopped before it finished", sub: `${w.stopped ? `${name} stopped or hit an error` : "It ended part-way through"}, so nothing was added. Ask it to redo the answer; StudyPilot keeps watching.`, pct: 0, cut: true };
    default: return { label: `Waiting for ${name}`, sub: "Press Send there. StudyPilot picks up the answer by itself when it's done.", pct: null };
  }
}
const measureDock = () => { const el = $(".card.banner.wait"); if (el) document.body.style.setProperty("--dock", `${el.offsetHeight}px`); };
function paintWatch() {
  const box = $("#wait-progress");
  if (!box) return;
  requestAnimationFrame(measureDock);
  const t = watchText();
  box.querySelector(".wait-label").textContent = t.label;
  box.querySelector(".wait-sub").textContent = t.sub;
  const bar = box.querySelector(".loadbar");
  bar.classList.toggle("indeterminate", t.pct == null);
  bar.classList.toggle("cut", !!t.cut);
  bar.firstChild.style.width = t.pct == null ? "" : `${t.pct}%`;
  bar.setAttribute("aria-valuenow", t.pct == null ? "" : String(Math.round(t.pct)));
}
async function askRedo() {
  const p = state.pending;
  const msg = redoPrompt(p?.expect);
  await copyText(msg);
  lastClip = msg;
  let filled = false;
  if (p?.tabId && state.settings.aiAutofill !== false && (await hasFillPermission(p.provider || ai().id))) {
    try { filled = (await fillTab(p.tabId, { text: msg, files: [] })).filled; } catch { /* copied anyway */ }
    chrome.tabs.update(p.tabId, { active: true }).catch(() => {});
  }
  lastSeen = ""; sameCount = 0;
  state.watch = { phase: "send", got: 0, total: 0 };
  resumeWatching();
  views.banner?.();
  toast(filled ? `Ready in ${ai().name}: press Send.` : `Copied. Paste it into ${ai().name} and press Send.`, { ms: 7000 });
}
// The panel was closed while waiting: look again as soon as it opens.
export function resumeWatching() { if (state.pending?.tabId && !watchTimer) startWatching(); }

// When the panel gets focus again and a reply is expected, look at the clipboard (needs the clipboardRead permission).
async function checkClipboard() {
  if (!state.pending || state.settings.aiClipboard === false || !document.hasFocus()) return;
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch { return; }
  if (!text || text === lastClip || text.length < 40) return;
  lastClip = text;
  if (findReplyBlock(text) !== state.pending.expect) return;
  try { await importReply(text, { quiet: true }); } catch (e) { toast(e.message, { error: true, ms: 8000 }); }
}
window.addEventListener("focus", () => setTimeout(checkClipboard, 150));
document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(checkClipboard, 150); });

export async function restorePending() {
  const { [PENDING_KEY]: p } = await chrome.storage.local.get(PENDING_KEY);
  if (p && Date.now() - p.at < 3 * 3600e3) { state.pending = p; resumeWatching(); } else if (p) chrome.storage.local.remove(PENDING_KEY);
}

// "Paste reply": clicking counts as a user gesture, so the clipboard can be read even without the permission.
export async function pasteFromClipboard(fallbackBox) {
  try {
    const text = await navigator.clipboard.readText();
    if (text && findReplyBlock(text)) return importReply(text);
  } catch { /* show the box */ }
  fallbackBox.hidden = false;
  fallbackBox.querySelector("textarea").focus();
  requestAnimationFrame(measureDock);
  toast("Paste the AI's reply into the box.", { ms: 4000 });
}

// ---------- the banner under the tabs ----------
views.banner = () => {
  const box = $("#banner");
  box.replaceChildren();
  const p = ai();
  if (state.handoff) {
    const b = state.handoff;
    box.append(h("div", { class: "card banner" },
      h("h3", {}, `Files ready for ${p.url ? p.name : "your AI"}`),
      h("ol", { class: "steps-list", style: "margin:6px 0" },
        h("li", {}, `Drag the ${plural(b.files.length, "file")} from the folder that opened into the chat.`),
        h("li", {}, "Paste the message (Ctrl/⌘ + V) and press Enter.")),
      b.failed ? h("div", { class: "note" }, `${plural(b.failed, "file")} couldn't be downloaded.`) : null,
      h("div", { class: "actions" },
        h("button", { class: "btn small secondary", onclick: () => chrome.downloads.show(b.mdId) }, "Show folder"),
        h("button", { class: "btn small secondary", onclick: async () => { await copyText(b.message); toast("Message copied"); } }, "Copy message"),
        h("button", { class: "btn small soft", onclick: () => { state.handoff = null; rerender(); } }, "Done"))));
  }
  if (state.pending) {
    const q = state.pending;
    const ta = h("textarea", { rows: 4, placeholder: "Paste the AI's whole reply here…", "aria-label": "AI reply" });
    const manual = h("div", { hidden: true, style: "margin-top:8px" }, ta,
      act("Add", () => importReply(ta.value), { cls: "btn small block", busyLabel: "Reading…", attrs: { style: "margin-top:6px" } }));
    const what = { quiz: "questions", checklist: "the checklist", weights: "grade weights", plan: "your plan", schedule: "class times", sizes: "time estimates", priorities: "your study plan" }[q.expect] || "the answer";
    const t = watchText();
    box.append(h("div", { class: "card banner wait" },
      h("div", { class: "meta", style: "margin-bottom:4px" }, q.title || `${what[0].toUpperCase()}${what.slice(1)}`),
      state.queueRun && !state.queueRun.only ? h("div", { class: "meta", style: "margin:-2px 0 4px" }, `From your list: ${state.queueRun.done + 1} of ${state.queueRun.total}. The next one is filled in when this reply comes in. `,
        h("button", { class: "linkish", onclick: () => { import("./queue.js").then((m) => m.stopQueue()); toast("The list stops after this request."); } }, "Stop after this one")) : null,
      h("div", { id: "wait-progress", role: "status", "aria-live": "polite" },
        h("b", { class: "wait-label" }, t.label),
        h("div", { class: `loadbar${t.pct == null ? " indeterminate" : ""}${t.cut ? " cut" : ""}`, role: "progressbar", "aria-label": "Progress" }, h("span", { style: t.pct == null ? "" : `width:${t.pct}%` })),
        h("div", { class: "meta wait-sub" }, t.sub)),
      h("div", { class: "actions" },
        t.cut ? act("Ask to redo", askRedo, { cls: "btn small", busyLabel: "Opening…" }) : null,
        act("Paste reply", () => pasteFromClipboard(manual), { cls: `btn small${t.cut ? " secondary" : ""}`, ico: "inbox", busyLabel: "Reading…" }),
        h("button", { class: "btn small soft", onclick: () => { import("./queue.js").then((m) => m.stopQueue()); cancelPending(); } }, "Cancel")),
      manual));
    requestAnimationFrame(measureDock);
    ta.addEventListener("focus", () => requestAnimationFrame(measureDock));
  }
  if (state.imported) {
    const im = state.imported;
    box.append(h("div", { class: "card banner ok" },
      h("div", { class: "row" }, h("span", { class: "okdot", "aria-hidden": "true" }, icon("check", 16)),
        h("div", { class: "grow" }, h("b", {}, `${im.quiz.name} is ready: ${plural(im.count, "question")}`),
          h("div", { class: "meta" }, im.title || ""))),
      h("div", { class: "actions" },
        h("button", { class: "btn small", onclick: () => { state.imported = null; views.takeQuiz?.(im.quiz); } }, `Take ${im.quiz.name}`),
        h("button", { class: "btn small soft", onclick: () => { state.imported = null; rerender(); } }, "Later"))));
  }
};
