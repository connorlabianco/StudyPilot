// Canvas calendar page: draws StudyPilot's study time, planned work and class times onto Canvas's week and day
// views, lined up with Canvas's own hours. Only drawn on screen: nothing is added to Canvas, and clicks pass
// through to Canvas. A switch in the corner turns it off (the original calendar, untouched).
(() => {
  if (window.__spCal) return;
  window.__spCal = true;
  const send = (type, payload = {}) => new Promise((res) => { try { chrome.runtime.sendMessage({ type, payload }, (r) => res(r?.ok ? r.data : null)); } catch { res(null); } });
  let on = true, data = null, timer = null, lastKey = "";

  const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
  const nice = (min) => { const h = Math.floor(min / 60) % 24, m = min % 60; return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`; };

  // The time grid of Canvas's week/day view (older and newer calendar versions).
  function findGrid() {
    const grid = document.querySelector(".fc-time-grid, .fc-timegrid-body, .fc-timegrid");
    if (!grid || !grid.offsetParent) return null;
    const rows = [...grid.querySelectorAll("[data-time]")].map((el) => ({ el, min: toMin(el.getAttribute("data-time")) }))
      .filter((r) => Number.isFinite(r.min) && r.el.getBoundingClientRect().height > 0);
    const seen = new Map();
    for (const el of grid.querySelectorAll("[data-date]")) {
      const r = el.getBoundingClientRect(), d = el.getAttribute("data-date").slice(0, 10);
      if (r.width < 10 || r.height < 50) continue;
      if (!seen.has(d) || r.height > seen.get(d).getBoundingClientRect().height) seen.set(d, el);
    }
    if (!rows.length || !seen.size) return null;
    return { grid, rows: rows.sort((a, b) => a.min - b.min), cols: [...seen].map(([date, el]) => ({ date, el })).sort((a, b) => a.date.localeCompare(b.date)) };
  }
  // Pixel offset (inside the grid) for a time of day, from Canvas's own hour rows.
  function yFor(rows, gridTop, min) {
    let i = rows.findIndex((r, k) => r.min <= min && (k === rows.length - 1 || rows[k + 1].min > min));
    if (i < 0) i = min < rows[0].min ? 0 : rows.length - 1;
    const r = rows[i], rect = r.el.getBoundingClientRect();
    const step = rows[i + 1] ? rows[i + 1].min - r.min : 30;
    const pxPer = (rows[i + 1] ? rows[i + 1].el.getBoundingClientRect().top - rect.top : rect.height) / step;
    return rect.top - gridTop + (min - r.min) * pxPer;
  }

  function clear() { document.querySelectorAll(".sp-cal-layer").forEach((x) => x.remove()); }
  async function draw() {
    const G = findGrid();
    if (!G) { clear(); return; }
    const from = G.cols[0].date, to = G.cols[G.cols.length - 1].date;
    const key = `${from}|${to}`;
    if (!data || key !== lastKey) { data = await send("CAL_OVERLAY", { from, to }); lastKey = key; if (data) on = data.on; }
    toggle();
    clear();
    if (!on || !data) return;
    if (getComputedStyle(G.grid).position === "static") G.grid.style.position = "relative";
    const layer = document.createElement("div");
    layer.className = "sp-cal-layer";
    layer.setAttribute("aria-hidden", "true");
    const gRect = G.grid.getBoundingClientRect();
    for (const e of data.events) {
      const col = G.cols.find((c) => c.date === e.date);
      if (!col) continue;
      const cRect = col.el.getBoundingClientRect();
      const top = yFor(G.rows, gRect.top, toMin(e.start)), bottom = yFor(G.rows, gRect.top, toMin(e.end));
      const div = document.createElement("div");
      div.className = `sp-cal-ev sp-${e.kind}${e.done ? " sp-done" : ""}`;
      const inset = e.kind === "plan" ? 10 : e.kind === "study" ? 0 : 2;
      Object.assign(div.style, { top: `${top}px`, height: `${Math.max(14, bottom - top - 1)}px`, left: `${cRect.left - gRect.left + inset}px`, width: `${Math.max(10, cRect.width - inset - 2)}px` });
      if (e.color) div.style.setProperty("--sp-c", e.color);
      if (e.kind !== "study") {
        const b = document.createElement("b"); b.textContent = e.title; div.append(b);
        const s = document.createElement("span"); s.textContent = `${nice(toMin(e.start))}\u2013${nice(toMin(e.end))}${e.sub ? ` \u00b7 ${e.sub}` : ""}`; div.append(s);
      } else { const b = document.createElement("span"); b.textContent = "Study time"; div.append(b); }
      div.title = `${e.kind === "study" ? "Study time" : e.title} (StudyPilot) ${nice(toMin(e.start))}\u2013${nice(toMin(e.end))}`;
      layer.append(div);
    }
    G.grid.append(layer);
  }

  // The switch: StudyPilot's times on top, or Canvas's calendar exactly as it was.
  function toggle() {
    let btn = document.querySelector(".sp-cal-toggle");
    const G = findGrid();
    if (!G) { btn?.remove(); return; }
    if (!btn) {
      btn = document.createElement("button");
      btn.className = "sp-cal-toggle";
      btn.type = "button";
      btn.addEventListener("click", async () => { on = !on; await send("CAL_OVERLAY_SET", { on }); draw(); });
      document.body.append(btn);
    }
    btn.textContent = on ? "StudyPilot: showing your study time \u00b7 Show Canvas only" : "Show StudyPilot study time";
    btn.setAttribute("aria-pressed", String(on));
  }

  const soon = () => { clearTimeout(timer); timer = setTimeout(() => draw().catch(() => {}), 250); };
  new MutationObserver((muts) => { if (muts.some((m) => ![...m.addedNodes, ...m.removedNodes].every((n) => n.nodeType === 1 && (n.classList?.contains("sp-cal-layer") || n.classList?.contains("sp-cal-toggle"))))) soon(); })
    .observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", soon);
  chrome.storage.onChanged?.addListener?.((ch, area) => { if (area === "local" && (ch.week || ch.plan || ch.planDay || ch.planDone)) { data = null; soon(); } });
  soon();
})();
