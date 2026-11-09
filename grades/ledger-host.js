// Connects the (unchanged) Grade Ledger to a StudyPilot course page.
// ledger.html?course=<id>&theme=dark|light&cur=<current score>
(() => {
  const q = new URLSearchParams(location.search);
  const courseId = q.get("course");
  const theme = q.get("theme");
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
  if (q.get("compact")) document.documentElement.classList.add("compact");

  const GL = window.GradeLedger;
  let ready = false, timer = null;

  async function load() {
    const { ledger = {} } = await chrome.storage.local.get("ledger");
    const rec = ledger[courseId];
    if (rec?.state) GL.restore(rec.state);
    const name = document.getElementById("gl-save-name");
    if (name && q.get("name")) name.value = q.get("name");
    // Final-exam helper starts from this course's numbers.
    const cur = q.get("cur");
    if (cur) document.getElementById("gl-f-cur").value = cur;
    if (rec?.state?.target) document.getElementById("gl-f-tgt").value = rec.state.target;
    ready = true;
  }

  // Every edit is kept for this course (what-ifs included) until "Reload from Canvas".
  function autosave() {
    if (!ready) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const { ledger = {} } = await chrome.storage.local.get("ledger");
      ledger[courseId] = { ...(ledger[courseId] || {}), state: GL.snapshot(), edited: Date.now() };
      await chrome.storage.local.set({ ledger });
      parent.postMessage({ type: "gl-edited", courseId }, "*");
    }, 400);
  }
  const root = document.getElementById("grade-ledger");
  ["input", "change"].forEach((ev) => root.addEventListener(ev, autosave));
  root.addEventListener("click", (e) => { if (e.target.closest("button")) setTimeout(autosave, 0); });

  // Keep the panel's frame as tall as the content.
  const post = () => parent.postMessage({ type: "gl-height", courseId, height: document.documentElement.scrollHeight }, "*");
  new ResizeObserver(post).observe(document.body);
  window.addEventListener("message", (e) => { if (e.data?.type === "gl-reload") load(); });
  load().then(post);
})();
