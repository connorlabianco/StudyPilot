// Media speed: one playback speed for videos and audio (Canvas, Canvas Studio, Panopto, Kaltura/YouTube if allowed,
// and every website if the student turns that on). 0.25x to 16x.
// A small control appears on each video (minus / speed / plus, a slider, or type a number). Keys: S slower, D faster, R reset.
// It only changes how fast the video plays, like the player's own speed menu; it never skips or seeks.
(() => {
  if (window.__spSpeed) return;
  window.__spSpeed = true;
  if (/\/quizzes(\/|$)|\/assessments?\//i.test(location.pathname)) return;

  // Chrome's media player accepts 0.0625x to 16x; above 16 it refuses, so 16 is the top. (Above about 4x Chrome mutes the sound.)
  const MIN = 0.25, MAX = 16;
  const stepAt = (r) => (r < 2 ? 0.1 : r < 4 ? 0.25 : r < 8 ? 0.5 : 1);
  const up = (r) => r + stepAt(r) + 1e-9, down = (r) => r - stepAt(r - 1e-9);
  // The slider is logarithmic so 0.5x-2x isn't squeezed into a sliver: position 0..1 maps to 0.25x..16x.
  const toPos = (r) => Math.log(r / MIN) / Math.log(MAX / MIN), fromPos = (x) => MIN * Math.pow(MAX / MIN, x);
  const TOP_LAYER = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;
  let rate = 1, enabled = true, ours = new WeakMap(), lastGesture = 0;
  ["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, () => { lastGesture = Date.now(); }, true));
  const clamp = (r) => Math.round(Math.min(MAX, Math.max(MIN, Number(r) || 1)) * 100) / 100;
  const isMedia = (v) => v.tagName === "VIDEO" || v.tagName === "AUDIO";

  chrome.storage.local.get(["videoSpeed", "settings"]).then(({ videoSpeed, settings }) => {
    rate = clamp(videoSpeed || 1);
    enabled = settings?.videoSpeedOn !== false;
    scan();
    applyAll(false);
  });
  chrome.storage.local.onChanged.addListener((ch) => {
    if (ch.videoSpeed) { rate = clamp(ch.videoSpeed.newValue); applyAll(true); }
    if (ch.settings) { enabled = ch.settings.newValue?.videoSpeedOn !== false; enabled ? scan() : removeAll(); }
  });
  const save = (r) => { rate = clamp(r); chrome.storage.local.set({ videoSpeed: rate }).catch(() => {}); applyAll(true); };

  // Players sometimes reset the speed (on load, or when switching streams); put ours back, without fighting the user's
  // own choice in the player's menu (that becomes the new speed).
  function apply(v, flash) {
    if (!enabled) return;
    ours.set(v, { setAt: Date.now(), value: rate });
    if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate;
    if (flash) show(v, true);
  }
  function applyAll(flash) { document.querySelectorAll("video, audio").forEach((v) => apply(v, flash)); }

  function hook(v) {
    if (v.__spHooked) return;
    v.__spHooked = true;
    ["loadedmetadata", "play", "seeked"].forEach((ev) => v.addEventListener(ev, () => apply(v)));
    v.addEventListener("ratechange", () => {
      const o = ours.get(v);
      if (!enabled || Math.abs(v.playbackRate - rate) < 0.001) return;
      if (o && Date.now() - o.setAt < 1500) { v.playbackRate = rate; return; } // the player reset it right after we set it
      if (Date.now() - lastGesture < 1500) { save(v.playbackRate); return; } // the user picked a speed in the player's own menu
      setTimeout(() => apply(v), 50);
    });
    v.addEventListener("mousemove", () => show(v)); v.addEventListener("mouseenter", () => show(v));
    apply(v);
  }

  // ---------- the on-video control (Shadow DOM so the page's styles can't change it) ----------
  const ui = new Map();
  function control(v) {
    if (ui.has(v)) return ui.get(v);
    // The control lives in the browser's "top layer" (a popover), which draws above everything on the page:
    // invisible click-catching overlays, other z-index tricks, even fullscreen players. Nothing can sit on top of it.
    const host = document.createElement("div");
    if (TOP_LAYER) host.setAttribute("popover", "manual");
    host.style.cssText = "position:fixed;inset:auto;top:0;left:0;margin:0;padding:0;border:0;background:transparent;overflow:visible;" +
      "z-index:2147483647;pointer-events:none;width:auto;height:auto;color:inherit;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      .c{pointer-events:auto;display:flex;align-items:center;gap:6px;font:600 13px/1 system-ui,sans-serif;color:#fff;background:rgba(20,22,28,.82);
        border-radius:10px;padding:5px 7px;opacity:0;transition:opacity .2s;box-shadow:0 2px 10px rgba(0,0,0,.35)}
      .c.on{opacity:1} button{all:unset;cursor:pointer;width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:16px;background:rgba(255,255,255,.14)}
      button:hover{background:rgba(255,255,255,.28)} button:focus-visible,input:focus-visible{outline:2px solid #7aa7ff;outline-offset:1px}
      input[type=number]{all:unset;width:42px;text-align:center;font:700 13px system-ui;background:rgba(255,255,255,.1);border-radius:6px;padding:3px 2px}
      input[type=range]{width:100px;accent-color:#7aa7ff;margin:0}
      .x{width:auto;padding:0 6px;font-size:11px}</style>
      <div class="c" role="group" aria-label="StudyPilot video speed">
        <button class="dn" aria-label="Slower (S)" title="Slower (S)">&minus;</button>
        <input class="num" type="number" min="${MIN}" max="${MAX}" step="0.05" aria-label="Speed">
        <button class="up" aria-label="Faster (D)" title="Faster (D)">+</button>
        <input class="sl" type="range" min="0" max="1" step="0.001" aria-label="Speed slider">
        <button class="x" aria-label="Reset to normal speed (R)" title="Reset (R)">1&times;</button>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const sync = () => { $(".num").value = rate.toFixed(2).replace(/\.?0+$/, ""); $(".sl").value = toPos(rate); };
    $(".dn").onclick = () => save(down(rate));
    $(".up").onclick = () => save(up(rate));
    $(".x").onclick = () => save(1);
    $(".sl").oninput = (e) => { const r = fromPos(Number(e.target.value)); save(r < 2 ? Math.round(r * 20) / 20 : r < 4 ? Math.round(r * 4) / 4 : Math.round(r * 2) / 2); };
    $(".num").onchange = (e) => save(e.target.value);
    $(".num").onkeydown = (e) => e.stopPropagation();
    const box = $(".c");
    box.onmouseenter = () => { clearTimeout(host.__t); box.classList.add("on"); };
    box.onmouseleave = () => hide(host);
    (document.body || document.documentElement).appendChild(host);
    const entry = { host, box, sync };
    ui.set(v, entry);
    return entry;
  }
  function place(v, entry) {
    const r = v.getBoundingClientRect();
    if (v.tagName === "AUDIO") {
      // An audio player is a thin bar: put the control just above it (or below, at the top of the page).
      if (r.width < 100 || r.height < 16) return false;
      const top = r.top >= 44 ? r.top - 40 : r.bottom + 4;
      entry.host.style.transform = `translate(${Math.max(0, r.left)}px, ${Math.max(0, top)}px)`;
      return true;
    }
    if (r.width < 160 || r.height < 90) return false;
    entry.host.style.transform = `translate(${Math.max(0, r.left + 10)}px, ${Math.max(0, r.top + 10)}px)`;
    if (!TOP_LAYER) {
      // Older Chrome: fall back to the highest z-index, inside the fullscreen element when there is one.
      const fs = document.fullscreenElement;
      if (fs && entry.host.parentNode !== fs && fs.contains(v)) fs.appendChild(entry.host);
      if (!fs && entry.host.parentNode !== document.body && document.body) document.body.appendChild(entry.host);
    }
    return true;
  }
  // Bring the control to the very front (re-showing a popover puts it above anything shown since, like fullscreen).
  function toFront(entry, force = false) {
    if (!TOP_LAYER) return;
    try {
      if (force && entry.host.matches(":popover-open")) entry.host.hidePopover();
      if (!entry.host.matches(":popover-open")) entry.host.showPopover();
      // Double-check nothing covers the middle of the control; if something does, re-show it on top.
      const b = entry.box.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (hit && hit !== entry.host && !entry.host.contains(hit)) { entry.host.hidePopover(); entry.host.showPopover(); }
    } catch { /* not connected yet */ }
  }
  function hide(host) { clearTimeout(host.__t); host.__t = setTimeout(() => host.shadowRoot.querySelector(".c").classList.remove("on"), 2200); }
  function show(v, flash = false) {
    if (!enabled || !isMedia(v)) return;
    const e = control(v);
    if (!place(v, e)) return;
    toFront(e);
    e.sync();
    e.box.classList.add("on");
    hide(e.host);
    if (flash) { clearTimeout(e.host.__t); e.host.__t = setTimeout(() => e.box.classList.remove("on"), 1400); }
  }
  function removeAll() { ui.forEach((e) => e.host.remove()); ui.clear(); }
  window.addEventListener("scroll", () => ui.forEach((e, v) => e.box.classList.contains("on") && place(v, e)), true);
  window.addEventListener("resize", () => ui.forEach((e, v) => place(v, e)));
  document.addEventListener("fullscreenchange", () => ui.forEach((e, v) => { place(v, e); toFront(e, true); }));
  // Show the control when the mouse is over a video, even if a see-through layer sits on top of the video
  // (those layers swallow the video's own mouse events, which is how other speed controls get hidden).
  let lastMove = 0;
  document.addEventListener("mousemove", (ev) => {
    if (!enabled || Date.now() - lastMove < 120) return;
    lastMove = Date.now();
    for (const v of document.querySelectorAll("video, audio")) {
      const r = v.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) { show(v); break; }
    }
  }, { capture: true, passive: true });

  // Keyboard: S / D / R while a video is on the page (not while typing).
  document.addEventListener("keydown", (e) => {
    if (!enabled || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    const k = e.key.toLowerCase();
    const playerFrame = () => [...document.querySelectorAll("iframe")].some((f) => /panopto|kaltura|youtube|instructuremedia|media_objects|media_attachments/i.test(f.src || ""));
    if (!["s", "d", "r"].includes(k) || !(document.querySelector("video, audio") || playerFrame())) return;
    e.preventDefault(); e.stopPropagation();
    save(k === "s" ? down(rate) : k === "d" ? up(rate) : 1);
  }, true);

  function scan() { if (enabled) document.querySelectorAll("video, audio").forEach(hook); }
  let queued = false;
  new MutationObserver(() => { if (!queued) { queued = true; setTimeout(() => { queued = false; scan(); }, 400); } }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
