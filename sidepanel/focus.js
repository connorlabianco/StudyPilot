// Focus timer in the side panel: a timer button in the header, a bar while it runs, and the start sheet.
// The timer itself runs in the background (lib/focus.js), so closing the panel doesn't stop it.
import { h, $, send, toast, state, plural, visibleSnapshot, courseName, saveSettings, rerender } from "./core.js";
import { PRESETS, leftMs, fmtMin } from "../lib/focus.js";
import { openWork } from "../lib/packs.js";
import { icon } from "../lib/icons.js";

let F = { phase: "idle" };
let tick = null;

const mmss = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// A soft two-note chime (no sound files), only while the panel is open.
function chime(up = true) {
  if (state.settings.focusSound === false) return;
  try {
    const ctx = new AudioContext();
    (up ? [660, 880] : [880, 660]).forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.22);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + i * 0.22 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.22 + 0.5);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + i * 0.22); o.stop(ctx.currentTime + i * 0.22 + 0.55);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch { /* no audio */ }
}

export async function initFocus() {
  F = (await chrome.storage.local.get("focus")).focus || { phase: "idle" };
  const btn = $("#focusBtn");
  btn?.addEventListener("click", () => (F.phase === "idle" ? openFocusSheet() : $("#focusbar")?.scrollIntoView({ block: "nearest" })));
  chrome.storage.local.onChanged.addListener((ch) => {
    if (!ch.focus) return;
    const prev = F; F = ch.focus.newValue || { phase: "idle" };
    if (prev.phase !== F.phase && (F.phase === "break" || F.phase === "done") && prev.phase !== "idle") chime(F.phase === "done");
    draw();
  });
  draw();
}

function draw() {
  const bar = $("#focusbar"), btn = $("#focusBtn");
  if (!bar) return;
  clearInterval(tick); tick = null;
  btn?.classList.toggle("on", F.phase === "focus" || F.phase === "break");
  if (F.phase === "idle") { bar.hidden = true; bar.replaceChildren(); return; }
  bar.hidden = false;
  bar.className = `focusbar ${F.phase}${F.pausedLeft != null ? " paused" : ""}`;
  const what = [F.label, F.courseId ? courseName(F.courseId) : null].filter(Boolean).join(" · ");
  if (F.phase === "done") {
    const starter = F.preset === "starter";
    bar.replaceChildren(
      h("div", { class: "fb-row" }, h("span", { class: "fb-ico" }, icon("check", 18)),
        h("div", { class: "grow" }, h("b", {}, starter ? `${F.focus} minutes done. Keep going?` : "Round done. Another one?"), what ? h("small", {}, what) : null)),
      h("div", { class: "fb-actions" },
        starter ? h("button", { class: "btn small", onclick: () => send("FOCUS_START", { focus: 20, brk: 5, label: F.label, courseId: F.courseId, task: F.task, preset: "classic" }) }, "20 more minutes") : null,
        h("button", { class: "btn small" + (starter ? " soft" : ""), onclick: () => send("FOCUS_START", { focus: starter ? 5 : F.focus, brk: F.brk, label: F.label, courseId: F.courseId, task: F.task, preset: F.preset }) }, starter ? "5 more" : `Another ${F.focus} min`),
        h("button", { class: "btn small soft", onclick: () => send("FOCUS_STOP") }, "I'm done")));
    return;
  }
  const time = h("b", { class: "fb-time", "aria-live": "off" }, mmss(leftMs(F)));
  const paused = F.pausedLeft != null;
  bar.replaceChildren(
    h("div", { class: "fb-row" },
      h("span", { class: "fb-ico" }, icon(F.phase === "break" ? "coffee" : "timer", 18)),
      h("div", { class: "grow" }, h("small", {}, paused ? "Paused" : F.phase === "break" ? "Break" : `Focus${F.round > 1 ? ` · round ${F.round}` : ""}`), what ? h("div", { class: "fb-what" }, what) : null),
      time),
    h("div", { class: "fb-track" }, h("i", { style: `width:${pct()}%` })),
    h("div", { class: "fb-actions" },
      h("button", { class: "btn small soft", onclick: () => send(paused ? "FOCUS_RESUME" : "FOCUS_PAUSE") }, paused ? "Resume" : "Pause"),
      h("button", { class: "btn small soft", onclick: () => send("FOCUS_EXTEND", { minutes: 5 }) }, "+5 min"),
      h("button", { class: "btn small soft", onclick: () => send("FOCUS_SKIP") }, F.phase === "break" ? "Skip break" : "Break now"),
      h("button", { class: "btn small soft", onclick: () => send("FOCUS_STOP").then(() => toast("Stopped. Your focus time was saved.")) }, "Stop")));
  if (!paused) tick = setInterval(() => {
    time.textContent = mmss(leftMs(F));
    const t = bar.querySelector(".fb-track i"); if (t) t.style.width = `${pct()}%`;
  }, 1000);
}
function pct() {
  const total = (F.phase === "break" ? F.brk : F.focus) * 6e4;
  return total ? Math.min(100, Math.round((1 - leftMs(F) / total) * 100)) : 0;
}

// ---------- start sheet ----------
export async function openFocusSheet(prefill = {}) {
  const dlg = $("#sheet");
  const s = state.settings;
  const last = F.last || {};
  let preset = PRESETS.find((p) => p.id === (prefill.preset || s.focusPreset)) || PRESETS[2];
  let custom = null;
  const work = state.snapshot ? openWork(visibleSnapshot(), { daysAhead: 14 }).slice(0, 8) : [];
  const courses = state.snapshot ? visibleSnapshot().courses : [];
  const sel = h("select", { id: "focus-what", "aria-label": "What are you working on?" },
    h("option", { value: "" }, "Just studying"),
    work.length ? h("optgroup", { label: "Due soon" }, work.map((a) => h("option", { value: `a:${a.course_id}:${a.id}`, selected: prefill.task === a.id }, `${a.name} (${a.course})`))) : null,
    courses.length ? h("optgroup", { label: "A course" }, courses.map((c) => h("option", { value: `c:${c.id}`, selected: !prefill.task && (prefill.courseId ?? last.courseId) === c.id }, c.code || c.name))) : null);
  const presetBtns = h("div", { class: "presets", role: "radiogroup", "aria-label": "Timer length" });
  const drawPresets = () => presetBtns.replaceChildren(...PRESETS.map((p) => h("button", { role: "radio", "aria-checked": !custom && p.id === preset.id, class: "preset" + (!custom && p.id === preset.id ? " on" : ""),
    onclick: () => { preset = p; custom = null; drawPresets(); } }, h("b", {}, p.label), h("small", {}, p.sub))));
  drawPresets();
  const fIn = h("input", { type: "number", min: 1, max: 180, value: s.focusCustom?.focus || 30, "aria-label": "Focus minutes", oninput: () => { custom = { focus: Number(fIn.value), brk: Number(bIn.value) }; drawPresets(); } });
  const bIn = h("input", { type: "number", min: 0, max: 60, value: s.focusCustom?.brk ?? 5, "aria-label": "Break minutes", oninput: () => { custom = { focus: Number(fIn.value), brk: Number(bIn.value) }; drawPresets(); } });
  const begin = async () => {
    const v = sel.value; let label = "", courseId = null, task = null;
    if (v.startsWith("a:")) { const [, cid, aid] = v.split(":"); const a = work.find((x) => String(x.id) === aid); label = a?.name || ""; courseId = Number(cid); task = Number(aid); }
    else if (v.startsWith("c:")) { courseId = Number(v.slice(2)); }
    const p = custom ? { focus: Math.max(1, Math.min(180, custom.focus || 25)), brk: Math.max(0, Math.min(60, custom.brk || 0)), preset: "custom" } : { focus: preset.focus, brk: preset.brk, preset: preset.id };
    await saveSettings(custom ? { focusCustom: custom } : { focusPreset: preset.id });
    await send("FOCUS_START", { ...p, label, courseId, task });
    dlg.close();
    const can = await chrome.permissions.contains({ permissions: ["notifications"] }).catch(() => false);
    if (!can && !state.settings.focusAskedNotify) {
      await saveSettings({ focusAskedNotify: true });
      toast("Tip: turn on notifications (Settings › Alerts & focus) to hear when time's up even with this panel closed.", { ms: 8000 });
    }
  };
  dlg.replaceChildren(h("div", { class: "sheet-in" },
    h("div", { class: "sheet-head" }, h("div", { class: "grow" }, h("b", {}, "Focus timer"), h("div", { class: "meta" }, "Work in short rounds with breaks. It keeps going with this panel closed.")),
      h("button", { class: "ghost", "aria-label": "Close", onclick: () => dlg.close() }, icon("close", 18))),
    h("div", { class: "sheet-sec" }, h("label", { class: "sheet-label", for: "focus-what" }, "What are you working on?"), sel),
    h("div", { class: "sheet-sec" }, h("div", { class: "sheet-label" }, "How long"), presetBtns,
      h("details", { class: "adv" }, h("summary", {}, "Custom"), h("div", { class: "row" },
        h("label", { class: "grow" }, h("small", {}, "Focus (min)"), fIn), h("label", { class: "grow" }, h("small", {}, "Break (min)"), bIn)))),
    h("button", { class: "btn block", onclick: begin }, icon("play", 16), " Start")));
  if (!dlg.open) dlg.showModal();
}

// ---------- weekly summary (Practice tab) ----------
export async function focusSummaryCard() {
  const { studyLog = [] } = await chrome.storage.local.get("studyLog");
  const { summarize } = await import("../lib/focus.js");
  const sum = summarize(studyLog);
  const card = h("div", { class: "card" }, h("h3", {}, "Focus time this week"));
  const startBtn = h("div", { class: "actions" }, h("button", { class: "btn small soft", onclick: () => openFocusSheet() }, icon("timer", 14), " Start a focus session"));
  if (!sum.total) { card.append(h("p", { class: "muted", style: "margin:0" }, "Use the timer to track study time. Even 5 minutes counts."), startBtn); return card; }
  const max = Math.max(...sum.perDay.map((d) => d.minutes), 1);
  card.append(
    h("div", { class: "muted" }, `${fmtMin(sum.total)} in ${plural(sum.sessions, "round")}${sum.today ? ` · ${fmtMin(sum.today)} today` : ""}${sum.streak > 1 ? ` · ${sum.streak}-day streak` : ""}`),
    h("div", { class: "week-bars", role: "img", "aria-label": sum.perDay.map((d) => `${new Date(d.date).toLocaleDateString([], { weekday: "short" })} ${fmtMin(d.minutes)}`).join(", ") },
      sum.perDay.map((d) => h("div", { class: "wb" }, h("i", { style: `height:${Math.round((d.minutes / max) * 100)}%`, title: fmtMin(d.minutes) }), h("small", {}, new Date(d.date).toLocaleDateString([], { weekday: "narrow" }))))),
    Object.keys(sum.perCourse).length > 1 ? h("div", { class: "meta", style: "margin-top:6px" }, Object.entries(sum.perCourse).sort((a, b) => b[1] - a[1])
      .map(([id, m]) => `${id === "other" ? "General" : courseName(Number(id))} ${fmtMin(m)}`).join(" · ")) : null, startBtn);
  return card;
}
