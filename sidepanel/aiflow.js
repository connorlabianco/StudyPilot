// Hand-off to the student's own AI (copy, open, paste) and reading its reply back.
import { h, $, send, toast, copyText, state, ai, views, rerender, go, safeFile, plural, act } from "./core.js";
import { download, waitForDownload } from "../lib/dl.js";
import { parseQuizReply, findReplyBlock, parseWeightsReply } from "../lib/ai.js";
import { ledgerFromCanvas } from "../lib/grades.js";
import { toRecords, addQuestions, addQuiz } from "../lib/quiz.js";
import { assignTopics, mergeTopics } from "../lib/topics.js";
import { hasFillPermission, loadFiles, fillTab } from "../lib/autofill.js";
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
 */
export async function handToAI(text, { expect = null, meta = {}, title = "", files = [] } = {}) {
  await copyText(text);
  const p = ai();
  const tab = p.url ? await chrome.tabs.create({ url: p.url, active: true }) : null;
  if (expect) {
    state.pending = { expect, meta, title, at: Date.now() };
    state.imported = null;
    await chrome.storage.local.set({ [PENDING_KEY]: state.pending });
  }

  // "Fill it in for me": type the request (and attach files) in the AI tab. Never presses Send.
  let fill = null;
  if (tab && state.settings.aiAutofill !== false && (await hasFillPermission(p.id))) {
    try { fill = await fillTab(tab.id, { text, files: files.length ? await loadFiles(files) : [] }); }
    catch (e) { fill = { filled: false, attached: 0, reason: e.message }; }
  }
  const filesDone = !files.length || fill?.attached === files.length;
  if (files.length && !filesDone) {
    state.handoff = await makeBundle(title || "StudyPilot", text, files);
    chrome.downloads.show(state.handoff.mdId);
  } else state.handoff = null;

  const where = p.url ? p.name : "your AI";
  const after = expect ? " When it answers, copy the whole reply and come back here." : "";
  if (fill?.filled && filesDone) toast(`Ready in ${where}: check it and press Send.${after}`, { ms: 10000 });
  else if (fill?.filled) toast(`Text is in ${where}. Drag the ${plural(files.length, "file")} from the folder that opened into the chat, then press Send.${after}`, { ms: 12000 });
  else if (files.length) toast(`Copied. Drag the ${plural(files.length, "file")} from the folder into ${where}, paste (Ctrl/⌘ + V) and press Enter.${after}`, { ms: 12000 });
  else toast(`Copied. Paste it into ${where} (Ctrl/⌘ + V) and press Enter.${after}`, { ms: 10000 });
  rerender();
}

export async function cancelPending() {
  state.pending = null;
  await chrome.storage.local.remove(PENDING_KEY);
  rerender();
}

// ---------- reading the reply ----------
let lastClip = "";
export async function importReply(text, { quiet = false } = {}) {
  const kind = findReplyBlock(text);
  const p = state.pending;
  if (!kind) { if (!quiet) throw new Error("That doesn't look like the reply. Copy the AI's whole answer, including the code block at the end."); return false; }
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
  if (p && Date.now() - p.at < 3 * 3600e3) state.pending = p; else if (p) chrome.storage.local.remove(PENDING_KEY);
}

// "Paste reply": clicking counts as a user gesture, so the clipboard can be read even without the permission.
export async function pasteFromClipboard(fallbackBox) {
  try {
    const text = await navigator.clipboard.readText();
    if (text && findReplyBlock(text)) return importReply(text);
  } catch { /* show the box */ }
  fallbackBox.hidden = false;
  fallbackBox.querySelector("textarea").focus();
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
    box.append(h("div", { class: "card banner wait" },
      h("div", { class: "row" }, h("span", { class: "pulse", "aria-hidden": "true" }),
        h("div", { class: "grow" }, h("b", {}, q.expect === "quiz" ? `Waiting for questions: ${q.title}` : q.expect === "weights" ? `Waiting for grade weights: ${q.title}` : "Waiting for your plan"),
          h("div", { class: "meta" }, `When ${p.url ? p.name : "your AI"} answers, copy its whole reply and come back here.`))),
      h("div", { class: "actions" },
        act("Paste reply", () => pasteFromClipboard(manual), { cls: "btn small", ico: "inbox", busyLabel: "Reading…" }),
        h("button", { class: "btn small soft", onclick: cancelPending }, "Cancel")),
      manual));
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
