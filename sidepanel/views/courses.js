// Courses: one page per course with Overview · Lectures · Grades · Files.
import { h, $, state, views, send, toast, act, ai, plural, relDue, shortDate, visibleSnapshot, openCourse, go, saveSettings, empty, tz, courseById, courseColor,
  lecturesFor, askFileHostAccess, toggle, seg, fmtBytes, panelIsDark, rerender, downloadText, today, safeFile, DAY, speedControl, confirmSize, doneButton } from "../core.js";
import { handToAI } from "../aiflow.js";
import { bank, openSheet, lectureScope, moduleScope, courseScope, scopeStats, attachOfferCard, inScope, quizRow } from "../sheet.js";
import { openWork, exportPack, projectModuleMd, PROJECT_HOWTO } from "../../lib/packs.js";
import { ledgerFromCanvas } from "../../lib/grades.js";
import { weightsPrompt, mistakesPrompt } from "../../lib/ai.js";
import { groupByTopFolder, filesInGroups, NOTEBOOKISH } from "../../lib/jupyter.js";
import { isDue, allQuizzes, quizzesFor } from "../../lib/quiz.js";
import { icon } from "../../lib/icons.js";

const SUBS = [["overview", "Overview"], ["lectures", "Lectures"], ["grades", "Grades"], ["files", "Files"]];
const gradeText = (c) => {
  const graded = (c.assignments || []).some((a) => a.graded) || (c.current_score ?? 0) > 0;
  return c.current_score != null && graded ? `${Math.round(c.current_score * 10) / 10}%${c.current_grade ? " " + c.current_grade : ""}` : null;
};
const chip = (pct) => h("span", { class: "mchip", title: "Mastered" }, h("i", { style: `width:${Math.round(pct * 100)}%` }));

views.courses = async (root) => {
  root.replaceChildren();
  const s = visibleSnapshot();
  if (!s) return root.append(empty("refresh", "Sync Canvas first (the refresh button)."));
  const c = state.course && courseById(state.course);
  if (c) return coursePage(root, c);
  state.course = null;

  const all = await bank();
  root.append(h("h2", { class: "page-title" }, "Your courses"));
  if (!s.courses.length) root.append(empty("school", "No courses found. Star courses in Canvas, or turn off “Only my favorite courses” in Settings."));
  const list = h("div", { class: "course-list" });
  for (const course of s.courses) {
    const qs = all.filter((q) => q.courseId === course.id);
    const due = qs.filter((q) => q.seen && isDue(q)).length;
    const week = (course.assignments || []).filter((a) => a.due_at && !a.submitted && Date.parse(a.due_at) > Date.now() && Date.parse(a.due_at) < Date.now() + 7 * DAY).length;
    const g = gradeText(course);
    list.append(h("button", { class: "course-tile", onclick: () => openCourse(course.id) },
      h("span", { class: "bar", style: `background:${courseColor(course.id)}` }),
      h("span", { class: "grow" }, h("b", {}, course.name), h("small", {}, [course.code !== course.name ? course.code : null, course.term].filter(Boolean).join(" · ")),
        h("span", { class: "chips" },
          g ? h("span", { class: "pill" }, g) : null,
          week ? h("span", { class: "pill week" }, `${week} due this week`) : null,
          due ? h("span", { class: "pill quiz" }, `${due} to review`) : null)),
      icon("chevron", 18)));
  }
  root.append(list);
};

async function coursePage(root, c) {
  const sub = state.courseSub || "overview";
  root.append(h("div", { class: "course-head", style: `--cc:${courseColor(c.id)}` },
    h("button", { class: "ghost", "aria-label": "All courses", onclick: () => go("courses", { course: null }) }, icon("back", 20)),
    h("div", { class: "grow" }, h("b", {}, c.name), h("div", { class: "meta" }, [c.code !== c.name ? c.code : null, gradeText(c)].filter(Boolean).join(" · "))),
    h("a", { class: "ghost", href: `${state.settings.canvasUrl}/courses/${c.id}`, target: "_blank", "aria-label": "Open in Canvas", title: "Open in Canvas" }, icon("link", 18))));
  root.append(h("div", { class: "subtabs", role: "tablist", "aria-label": "Course sections" }, SUBS.map(([v, l]) =>
    h("button", { role: "tab", "aria-selected": sub === v, onclick: () => { state.courseSub = v; rerender(); } }, l))));
  const body = h("div", {});
  root.append(body);
  await ({ overview, lectures, grades, files }[sub] || overview)(body, c);
}

// ---------- Overview ----------
async function overview(root, c) {
  const qs = (await bank()).filter((q) => q.courseId === c.id);
  const st = scopeStats(qs);
  root.append(h("div", { class: "card" }, h("h3", {}, "Practice"),
    st.total ? h("div", { class: "row" }, h("div", { class: "grow" }, h("b", {}, `${st.level} · ${Math.round(st.mastery * 100)}% mastered`),
      h("div", { class: "meta" }, `${plural(st.total, "question")} · ${st.due} due · ${st.fresh} new`)), chip(st.mastery))
      : h("p", { class: "muted", style: "margin:0" }, "No practice questions yet. Open a lecture and choose Practice."),
    h("div", { class: "actions" },
      act(st.total ? "Practice" : "Lectures", async () => { if (st.total) openSheet(await courseScope(c.id)); else { state.courseSub = "lectures"; rerender(); } }, { ico: "play" }),
      act("Study guide", async () => {
        const { contents } = await send("EXPORT", { courseIds: [c.id], want: { syllabus: true, assignments: true, modules: true, pages: false, discussions: true, announcements: true }, mode: "all" });
        await handToAI(exportPack(contents, { goal: "study", tz, prefs: state.settings, snapshot: { ...state.snapshot, courses: [c] } }), { title: c.name });
      }, { cls: "btn secondary", ico: "book", busyLabel: "Gathering…" }))));

  const cq = quizzesFor(await allQuizzes(c.id).catch(() => []), { courseId: c.id });
  if (cq.length) root.append(h("div", { class: "card" }, h("h3", {}, "Your quizzes"), h("div", { class: "quiz-list" }, cq.slice(0, 4).map((z) => quizRow(z, { showScope: true }))),
    cq.length > 4 ? h("div", { class: "hint" }, `+${cq.length - 4} more on each lecture`) : null));

  const examBox = h("div", {});
  root.append(examBox);
  examsCard(c).then((el) => examBox.replaceWith(el)).catch((e) => examBox.replaceWith(h("div", { class: "card" }, h("h3", {}, "Exams"), h("div", { class: "note" }, e.message))));

  const work = openWork({ courses: [c] }, { daysAhead: 30 });
  // Past-due Gradescope work: quietly ask Gradescope (if connected) whether it was turned in there.
  const gsMapped = (state.settings.gradescopeMap || {})[c.id];
  const usesGs = gsMapped ? gsMapped !== "none" : c.assignments.some((a) => /gradescope/i.test(a.kind_label || ""));
  if (usesGs && work.some((a) => a.elsewhere) && !(state.gsChecked ||= {})[c.id]) {
    state.gsChecked[c.id] = true;
    send("GS_COURSE", { courseId: c.id }).then((r) => { if (r?.state === "ok" && r.gsId && state.course === c.id) rerender(); }).catch(() => {});
  }
  const due = h("div", { class: "card" }, h("h3", {}, "Coming up"));
  if (!work.length) due.append(h("div", { class: "muted" }, "Nothing due in the next 30 days."));
  work.slice(0, 8).forEach((a) => { const d = relDue(a.due_at, a); due.append(h("div", { class: "item" },
    h("div", { class: "main" }, h("a", { class: "name", href: a.url, target: "_blank" }, a.name), h("div", { class: "meta" }, [a.points ? `${a.points} pts` : null, a.kind_label].filter(Boolean).join(" · "))),
    h("span", { class: `pill ${d.tone}`, title: d.title || null }, d.text), doneButton(a, c.id))); });
  root.append(due);

  const ann = (state.snapshot.announcements || []).filter((a) => a.course_id === c.id).slice(0, 4);
  if (ann.length) root.append(h("div", { class: "card" }, h("h3", {}, "Announcements"), ann.map((a) => h("div", { class: "item" },
    h("div", { class: "main" }, h("a", { class: "name", href: a.url, target: "_blank" }, a.title), h("div", { class: "meta" }, shortDate(a.posted_at)))))));

  const recent = (c.assignments || []).filter((a) => a.graded && a.score != null).sort((a, b) => Date.parse(b.graded_at || 0) - Date.parse(a.graded_at || 0)).slice(0, 4);
  if (recent.length) root.append(h("div", { class: "card" }, h("h3", {}, "Recent grades"), recent.map((a) => h("div", { class: "item" },
    h("div", { class: "main" }, h("a", { class: "name", href: a.url, target: "_blank" }, a.name), h("div", { class: "meta" }, shortDate(a.graded_at))),
    h("span", { class: "pill" }, `${a.score}${a.points ? ` / ${a.points}` : ""}`))),
    h("button", { class: "btn small soft block", style: "margin-top:8px", onclick: () => { state.courseSub = "grades"; rerender(); } }, "What-if calculator")));
}

// ---------- Lectures ----------
async function lectures(root, c) {
  const s = state.settings;
  const on = (s.libraryCourses || []).includes(c.id);
  root.append(h("div", { class: "card tight" },
    seg([["new", "New for me"], ["all", "Lectures"], ["everything", "Everything"]], state.lectureFilter, (v) => { state.lectureFilter = v; rerender(); }, "Show"),
    toggle("Prepare lectures in the background", on ? "New slides are read as they're posted, so practice is instant." : "Off: lectures are read when you use them.", on, async (want, e) => {
      if (want) {
        await askFileHostAccess();
        if (!confirm("Reading a file through Canvas can mark it as “viewed”, the same as opening it yourself. Prepare this course's lectures in the background?")) { e.target.checked = false; return; }
      }
      const set = new Set(s.libraryCourses || []); want ? set.add(c.id) : set.delete(c.id);
      await saveSettings({ libraryCourses: [...set] });
      if (want) { toast("Reading lectures… you can keep using StudyPilot."); send("LIBRARY_SYNC", { courseIds: [c.id] }).then(() => { delete state.lectureCache[c.id]; rerender(); }).catch((err) => toast(err.message, { error: true })); }
    })));
  const offer = attachOfferCard();
  if (offer) root.append(offer);

  const vidBox = h("div", {});
  root.append(vidBox);
  videosSection(c).then((el) => el ? vidBox.replaceWith(el) : vidBox.remove()).catch((e) => vidBox.replaceWith(h("div", { class: "note" }, `Lecture videos: ${e.message}`)));

  const box = h("div", {}, empty("clock", "Loading lectures…"));
  root.append(box);
  let list;
  try { list = await lecturesFor(c.id); } catch (e) { box.replaceChildren(empty("alert", e.message)); return; }
  if (state.course !== c.id) return;
  const qs = (await bank()).filter((q) => q.courseId === c.id);
  const quizzes = await allQuizzes(c.id).catch(() => []);
  let shown = list;
  if (state.lectureFilter === "new") shown = list.filter((l) => l.is_new);
  if (state.lectureFilter === "all") shown = list.filter((l) => l.is_lecture);
  box.replaceChildren();
  if (!shown.length) {
    box.append(empty(state.lectureFilter === "new" ? "spark" : "inbox", state.lectureFilter === "new" ? "No new lectures since you last checked." : "No lectures found here. Try “Everything”.",
      state.lectureFilter === "new" ? h("div", { style: "margin-top:8px" }, h("button", { class: "btn small soft", onclick: () => { state.lectureFilter = "all"; rerender(); } }, "Show all lectures")) : null));
    return;
  }
  if (state.lectureFilter === "new") box.append(h("div", { class: "group-title" }, h("span", {}, `${shown.length} new`),
    act("Mark all seen", async () => { await send("MARK_SEEN", { keys: shown.map((l) => l.key) }); list.forEach((l) => (l.is_new = false)); rerender(); }, { cls: "btn small soft" })));

  const groups = new Map();
  shown.forEach((l) => { if (!groups.has(l.module)) groups.set(l.module, { index: l.module_index, items: [] }); groups.get(l.module).items.push(l); });
  for (const [module, g] of [...groups.entries()].sort((a, b) => b[1].index - a[1].index)) {
    const mq = qs.filter((q) => g.items.some((l) => l.key === q.lectureKey));
    box.append(h("div", { class: "group-title" }, h("span", {}, module),
      g.items.length > 1 ? h("button", { class: "btn small soft", onclick: () => openSheet(moduleScope(c.id, module, g.items)) }, mq.length ? `Module · ${Math.round(scopeStats(mq).mastery * 100)}%` : "Whole module") : null));
    g.items.forEach((l) => box.append(lectureRow(c.id, l, qs.filter((q) => q.lectureKey === l.key), quizzesFor(quizzes, { courseId: c.id, lectureKeys: [l.key] }).length)));
  }
}

function lectureRow(courseId, l, qs, nQuizzes = 0) {
  const isSlides = l.type === "File";
  const st = scopeStats(qs);
  const badge = l.scanned ? "Handwritten" : l.no_text ? "Some handwriting" : l.visual ? "Diagrams" : null;
  return h("div", { class: "lec" + (l.is_new ? " new" : "") },
    h("button", { class: "lec-main", onclick: () => openSheet(lectureScope(courseId, l)), "aria-label": `${l.title}: practice, flashcards, study guide or download` },
      h("span", { class: "icon", "aria-hidden": "true" }, icon(isSlides ? "slides" : "file", 20)),
      h("span", { class: "grow" }, h("b", {}, l.title),
        h("small", {}, [isSlides ? (l.pages ? `${l.pages} ${String(l.unit || "page").toLowerCase()}s` : "Slides / file") : "Page", l.date ? shortDate(l.date) : null, badge, nQuizzes ? plural(nQuizzes, "quiz", "quizzes") : null].filter(Boolean).join(" · "))),
      st.total ? h("span", { class: "lec-prog" }, chip(st.mastery), h("small", { title: `${Math.round(st.mastery * 100)}% mastered` }, st.due ? `${st.due} due` : st.level)) : null,
      l.is_new ? h("span", { class: "pill new" }, "New") : null),
    h("a", { class: "ghost small", href: l.url, target: "_blank", "aria-label": "Open in Canvas", title: "Open in Canvas" }, icon("link", 16)));
}

// ---------- Grades (Grade Ledger) ----------
let glListener = null;
async function grades(root, c) {
  const { ledger = {} } = await chrome.storage.local.get("ledger");
  let rec = ledger[c.id];
  const note = h("div", { class: "hint" });
  async function reload() {
    const data = await send("GRADE_DATA", { courseId: c.id });
    const built = ledgerFromCanvas(data, { target: rec?.state?.target || 90 });
    rec = { ...built, v: 3, at: Date.now(), canvasScore: data.current_score, checked: data.checked || [], needsFileAccess: !!data.needsFileAccess && built.source !== "syllabus" && built.source !== "canvas-weights" };
    const { ledger: l2 = {} } = await chrome.storage.local.get("ledger");
    l2[c.id] = rec;
    await chrome.storage.local.set({ ledger: l2 });
  }
  // Rebuild ledgers made before syllabus files were read (unless the student has edited them).
  if (!rec?.state || (!rec.edited && rec.v !== 3)) {
    root.append(empty("grades", "Reading your grades and looking for the weights in your syllabus…"));
    try { await reload(); } catch (e) { root.replaceChildren(empty("alert", e.message)); return; }
    root.replaceChildren();
  }
  note.textContent = rec.note || "";
  const frame = h("iframe", { class: "ledger-frame", title: "Grade calculator",
    src: chrome.runtime.getURL(`grades/ledger.html?course=${c.id}&theme=${panelIsDark() ? "dark" : "light"}&compact=1&name=${encodeURIComponent(c.code || c.name)}${c.current_score != null ? `&cur=${c.current_score}` : ""}`) });
  if (glListener) window.removeEventListener("message", glListener);
  glListener = (e) => { if (e.data?.type === "gl-height" && String(e.data.courseId) === String(c.id)) frame.style.height = `${e.data.height + 4}px`; };
  window.addEventListener("message", glListener);
  root.append(h("div", { class: "card tight" },
    h("b", {}, { "canvas-weights": "Weights from Canvas", syllabus: "Weights from your syllabus", points: "No weights found" }[rec.source] || "Your grade calculator"),
    note, rec.edited ? h("div", { class: "hint" }, "Includes your edits and what-ifs.") : null,
    h("div", { class: "actions" }, act("Reload from Canvas", async () => {
      if (rec.edited && !confirm("Replace your edits with fresh numbers from Canvas?")) return;
      await reload(); frame.contentWindow?.postMessage({ type: "gl-reload" }, "*"); rerender();
    }, { cls: "btn small secondary", ico: "refresh", busyLabel: "Reading…" })),
    rec.source === "points" ? noWeightsHelp(c, rec) : null,
    rec.needsFileAccess ? h("div", { class: "note" }, "Your syllabus file couldn't be read yet. ",
      act("Allow and try again", async () => { if (!(await askFileHostAccess())) throw new Error("StudyPilot needs access to Canvas's file storage to read the syllabus."); await reload(); rerender(); }, { cls: "btn small", busyLabel: "Reading…" })) : null,
    c.current_score != null ? h("div", { class: "hint" }, `Canvas shows ${Math.round(c.current_score * 100) / 100}% for graded work.`) : null),
    frame);
}

// When no weights were found: say what was checked, and offer the AI or the syllabus itself.
function noWeightsHelp(c, rec) {
  const why = (x) => x.error ? (x.error === "locked" ? "locked" : x.file ? "couldn't open it" : x.error) : x.readable === false ? "no typed text (scanned?)" : "no percentages found";
  return h("div", { class: "card tight", style: "margin:8px 0 0" },
    rec.checked?.length ? h("div", { class: "hint" }, "Checked: ", rec.checked.map((x) => `${x.name} (${why(x)})`).join(" · ")) : null,
    h("div", { class: "actions" },
      act("Read the weights with my AI", async () => {
        const r = await send("SYLLABUS_FOR_AI", { courseId: c.id });
        if (!r.texts.length && !r.files.length) throw new Error("No syllabus found in this course. Type the weights into the calculator instead.");
        await handToAI(weightsPrompt({ course: c.name, texts: r.texts, attached: r.files.map((f) => f.name) }), { expect: "weights", meta: { courseId: c.id }, title: c.code || c.name, files: r.files });
      }, { cls: "btn small", ico: "spark", busyLabel: "Gathering…" }),
      h("a", { class: "btn small secondary", href: `${state.settings.canvasUrl}/courses/${c.id}/assignments/syllabus`, target: "_blank" }, "Open syllabus")));
}
views.openGrades = (courseId) => openCourse(courseId, "grades");

// ---------- Files ----------
async function files(root, c) {
  const s = state.settings;
  const name = c.code || c.name;
  const zipMsg = (r) => r.empty ? "Nothing found to download." : r.zips.length ? `Saved ${plural(r.done, "file")} as ${plural(r.zips.length, "zip")} in Downloads › StudyPilot${r.skipped ? ` (${r.skipped} unchanged skipped)` : ""}` : "Everything is already downloaded.";
  root.append(h("div", { class: "card" }, h("h3", {}, "Course files"),
    h("p", { class: "muted", style: "margin-top:0" }, "Slides, PDFs and readings as one zip, keeping the course's folders. Next time only new or changed files are included."),
    h("div", { class: "actions" },
      act("Download", async () => {
        await askFileHostAccess();
        const est = await send("COURSE_FILES_ZIP", { courseId: c.id, onlyNew: true, estimate: true });
        if (!confirmSize(est.bytes, `${plural(est.count || 0, "new file")}`)) return;
        toast(zipMsg(await send("COURSE_FILES_ZIP", { courseId: c.id, onlyNew: true })), { ms: 8000 });
      }, { ico: "download", busyLabel: "Zipping…" }),
      act("Everything again", async () => {
        const est = await send("COURSE_FILES_ZIP", { courseId: c.id, onlyNew: false, estimate: true });
        if (!confirmSize(est.bytes, `All ${plural(est.count || 0, "file")}`)) return;
        toast(zipMsg(await send("COURSE_FILES_ZIP", { courseId: c.id, onlyNew: false })), { ms: 8000 });
      }, { cls: "btn secondary", busyLabel: "Zipping…" })),
    toggle("Keep lecture slides in Downloads", "Copies of this course's lecture files in Downloads › StudyPilot › " + name + " › Lectures, updated when they change", (s.libraryMirror || []).includes(c.id), async (v) => {
      const set = new Set(s.libraryMirror || []); v ? set.add(c.id) : set.delete(c.id);
      const lib = new Set(s.libraryCourses || []); if (v) lib.add(c.id);
      await saveSettings({ libraryMirror: [...set], libraryCourses: [...lib] });
      if (v) send("LIBRARY_SYNC", { courseIds: [c.id] }).catch((e) => toast(e.message, { error: true }));
    })));

  root.append(h("div", { class: "card" }, h("h3", {}, "My submissions"),
    h("p", { class: "muted", style: "margin-top:0" }, "Everything you've turned in for this course, one folder per assignment."),
    act("Download my submissions", async () => toast(zipMsg(await send("COURSE_FILES_ZIP", { courseId: c.id, courseFiles: false, mine: true, onlyNew: false })), { ms: 8000 }), { cls: "btn block secondary", ico: "download", busyLabel: "Zipping…" })));

  const gsBox = h("div", {});
  root.append(gsBox);
  gradescopeCard(c).then((el) => el && gsBox.replaceWith(el)).catch((e) => gsBox.replaceWith(h("div", { class: "card" }, h("h3", {}, "Gradescope"), h("div", { class: "note" }, e.message))));
  root.append(await notebooksCard(c));

  root.append(h("div", { class: "card" }, h("h3", {}, "Pack for an AI project"),
    h("p", { class: "muted", style: "margin-top:0" }, "A zip with a course overview, one file per module and the original slides. Add it once to a Project, Gem or similar in your AI to use it from any device."),
    act("Make course pack", () => makeProjectPack([c.id]), { cls: "btn block soft", ico: "export", busyLabel: "Building…" })));
}

// Jupyter notebooks for this course (folders picked once).
async function notebooksCard(c) {
  const s = state.settings, J = state.jup;
  const box = h("div", { class: "card" }, h("h3", {}, "Jupyter notebooks"));
  if (!s.jupyterUrl) {
    box.append(h("p", { class: "muted", style: "margin-top:0" }, "If this class uses JupyterHub (DataHub and similar), connect it once to download notebooks and practice from them."),
      h("button", { class: "btn small secondary", onclick: () => go("settings", { settingsOpen: "connections" }) }, "Connect JupyterHub"));
    return box;
  }
  if (!J.status) { try { J.status = await send("JUPYTER_STATUS"); } catch (e) { J.status = { state: "error", error: e.message }; } }
  const st = J.status;
  const recheck = act("Check again", async () => { J.status = null; rerender(); }, { cls: "btn small soft" });
  if (st.state === "login") { box.append(h("div", { class: "note" }, `Log in to ${new URL(s.jupyterUrl).host} first.`), h("div", { class: "actions" }, h("button", { class: "btn small", onclick: () => send("JUPYTER_LOGIN") }, "Log in"), recheck)); return box; }
  if (st.state === "stopped") { box.append(h("div", { class: "muted" }, "Your server is off."), h("div", { class: "actions" }, act("Start my server", async () => { const r = await send("JUPYTER_START"); if (r.needsUser) toast("Pick your environment and press Start in the Jupyter tab, then press Check again.", { ms: 10000 }); J.status = null; rerender(); }, { cls: "btn small", busyLabel: "Starting…" }), recheck)); return box; }
  if (st.state !== "running" && st.state !== "ok") { box.append(h("div", { class: "note" }, st.error || "Couldn't reach your hub."), h("div", { class: "actions" }, recheck)); return box; }

  const map = s.jupyterCourseFolders || {};
  const mine = map[c.id] || [];
  if (!J.scan) {
    box.append(h("p", { class: "muted", style: "margin-top:0" }, mine.length ? `Folders: ${mine.join(", ")}` : "Pick which of your Jupyter folders belong to this course."),
      act(mine.length ? "Load notebooks" : "Choose folders", async () => { J.scan = await send("JUPYTER_SCAN"); rerender(); }, { cls: "btn small", busyLabel: "Scanning…" }));
    return box;
  }
  const groups = groupByTopFolder(J.scan.files);
  if (!mine.length || J.picking === c.id) {
    const picked = new Set(mine);
    box.append(h("div", { class: "checks" }, groups.map((g) => h("label", {},
      h("input", { type: "checkbox", checked: picked.has(g.name), onchange: (e) => { e.target.checked ? picked.add(g.name) : picked.delete(g.name); } }),
      h("span", { class: "grow" }, h("b", {}, g.name), h("br"), h("small", {}, `${plural(g.notebooks, "notebook")} · ${g.files} files${g.latest ? ` · changed ${shortDate(g.latest)}` : ""}`)),
      h("small", {}, g.bytes ? fmtBytes(g.bytes) : "")))),
      act("Save folders", async () => { await saveSettings({ jupyterCourseFolders: { ...map, [c.id]: [...picked] } }); J.picking = null; rerender(); }, { cls: "btn small block", attrs: { style: "margin-top:8px" } }));
    return box;
  }
  const chosen = filesInGroups(J.scan.files, mine);
  const nbs = chosen.filter((f) => NOTEBOOKISH.test(f.path)).sort((a, b) => (b.last_modified || "").localeCompare(a.last_modified || ""));
  const links = (J.links || []).filter((l) => !l.course || l.course === c.name || l.course === c.code);
  box.append(h("div", { class: "row" }, h("div", { class: "grow meta" }, `${mine.join(", ")} · ${plural(nbs.length, "notebook")}`),
      h("button", { class: "btn small soft", onclick: () => { J.picking = c.id; rerender(); } }, "Change")),
    h("div", { class: "actions" },
      act("Practice", () => openSheet({ kind: "notebooks", courseId: c.id, title: `${c.code || c.name} notebooks`, notebooks: nbs.slice(0, 40).map(({ path, last_modified }) => ({ path, last_modified })), lectures: [{ key: `nb:${c.id}`, title: `${c.code || c.name} notebooks`, module: "Notebooks" }] }), { ico: "play" }),
      act("Download", async () => {
        if (!confirmSize(chosen.reduce((n, f) => n + (f.size || 0), 0), "These notebooks and files", "(Only new or changed files are zipped, so it may be smaller.)")) return;
        const r = await send("JUPYTER_DOWNLOAD", { files: chosen.map(({ path, size, last_modified }) => ({ path, size, last_modified })), onlyNew: true });
        toast(r.zips.length ? `Saved ${plural(r.zips.length, "zip")} (${r.done} files) to Downloads › StudyPilot` : "Everything is already up to date", { ms: 8000 });
      }, { cls: "btn secondary", ico: "download", busyLabel: "Zipping…" })),
    h("div", { class: "row", style: "margin-top:8px" },
      act("Get the latest course files", async () => {
        if (!J.links) J.links = await send("JUPYTER_FIND_LINKS");
        const mineLinks = J.links.filter((l) => !l.course || l.course === c.name || l.course === c.code).map((l) => l.url);
        if (!mineLinks.length) return toast("No “Open in Jupyter” links found in this course.", { ms: 6000 });
        const res = await send("JUPYTER_PULL", { links: mineLinks });
        const bad = res.filter((r) => !r.ok);
        toast(bad.length ? `Updated ${res.length - bad.length}/${res.length}. ${bad[0].error}` : "Course files are up to date", { error: !!bad.length, ms: 6000 });
        J.scan = await send("JUPYTER_SCAN"); rerender();
      }, { cls: "btn small soft block", ico: "refresh", busyLabel: "Updating…" })),
    links.length ? h("div", { class: "hint" }, `${plural(links.length, "course link")} found. Your own edits are kept.`) : h("div", { class: "hint" }, "Save open notebooks first (Ctrl/⌘ + S); StudyPilot gets the last saved version."));
  return box;
}

// Recorded lectures (Panopto): transcripts make them work like slides.
async function videosSection(c, { refresh = false } = {}) {
  state.videoCache ??= {};
  if (!state.settings.videoHost) return h("div", { class: "hint", style: "margin:0 4px 8px" }, "Recorded lectures? ",
    h("button", { class: "linkish", onclick: () => go("settings", { settingsOpen: "connections" }) }, "Connect your lecture video site"), " to practice from them too.");
  let info = !refresh && state.videoCache[c.id];
  if (!info) info = state.videoCache[c.id] = await send("VIDEOS", { courseId: c.id, refresh });
  const again = () => { delete state.videoCache[c.id]; rerender(); };
  const box = h("details", { class: "card videos", open: state.videosOpen !== false, ontoggle: (e) => { state.videosOpen = e.target.open; } },
    h("summary", {}, h("b", {}, "Lecture videos"), info.videos?.length ? h("small", {}, ` ${info.videos.length}`) : null));
  if (info.state === "permission") {
    box.append(h("p", { class: "muted" }, `Allow StudyPilot to read your recordings on ${info.host}.`),
      h("button", { class: "btn small", onclick: async () => { if (await chrome.permissions.request({ origins: [`https://${info.host}/*`] }).catch(() => false)) again(); } }, "Allow"));
    return box;
  }
  if (info.state === "login") {
    box.append(h("p", { class: "muted" }, `Log in to ${info.host} once in the tab that opens (pick your school or Canvas), then check again.`),
      h("div", { class: "actions" }, h("button", { class: "btn small", onclick: () => send("VIDEO_LOGIN") }, "Log in"),
        act("Check again", async () => { state.videoCache[c.id] = await send("VIDEOS", { courseId: c.id, refresh: true }); rerender(); }, { cls: "btn small secondary", busyLabel: "Checking…" })));
    return box;
  }
  const map = state.settings.videoFolderMap || {};
  const picker = h("select", { "aria-label": "Video folder", onchange: async (e) => { state.pickVideoFolder = null; await saveSettings({ videoFolderMap: { ...map, [c.id]: e.target.value } }); again(); } },
    h("option", { value: "" }, "Choose this course's recordings folder…"),
    (info.folders || []).map((f) => h("option", { value: f.id, selected: f.id === info.folderId }, `${f.name} (${f.count})`)),
    h("option", { value: "none" }, "No recordings for this course"));
  if (!info.folderId) { box.append(h("p", { class: "muted" }, "Which folder has this course's recordings?"), picker); return box; }
  const vids = info.videos || [];
  state.videoShow ??= 8;
  if (state.settings.videoSpeedOn !== false) box.append(speedControl({ compact: true }));
  box.append(h("div", { class: "row" }, h("small", { class: "grow muted" }, info.folderName),
      h("button", { class: "btn small soft", onclick: () => { state.pickVideoFolder = c.id; rerender(); } }, "Change")),
    state.pickVideoFolder === c.id ? picker : "",
    vids.length ? "" : h("p", { class: "muted" }, "No recordings in this folder yet."),
    ...vids.slice(0, state.videoShow).map((v) => h("div", { class: "lec" },
      h("button", { class: "lec-main", onclick: () => openSheet(lectureScope(c.id, v)), "aria-label": `${v.title}: practice, flashcards or study guide` },
        h("span", { class: "icon", "aria-hidden": "true" }, icon("play", 18)),
        h("span", { class: "grow" }, h("b", {}, v.title), h("small", {}, [v.date ? shortDate(v.date) : null, v.minutes ? `${v.minutes} min` : null].filter(Boolean).join(" · ")))),
      h("a", { class: "ghost small", href: v.url, target: "_blank", "aria-label": "Watch", title: "Watch" }, icon("link", 16)))),
    vids.length > state.videoShow ? h("button", { class: "btn small soft block", onclick: () => { state.videoShow += 20; rerender(); } }, `Show more (${vids.length - state.videoShow})`) : "",
    vids.length ? h("div", { class: "actions" },
      act("Transcripts (zip)", async () => {
        const r = await send("VIDEO_TRANSCRIPTS_ZIP", { courseId: c.id });
        toast(`Saved ${r.zip}: ${plural(r.added, "transcript")}${r.noCaptions ? ` (${r.noCaptions} without captions)` : ""}`, { ms: 8000 });
      }, { cls: "btn small secondary", ico: "file", busyLabel: "Reading captions…" }),
      act("Video files…", async () => {
        const est = await send("VIDEO_FILES", { courseId: c.id, estimate: true });
        if (!confirm(`Download ${plural(est.count, "recording")} (about ${fmtBytes(est.bytes)}, ${Math.round(est.minutes / 60)} hours)? They're saved as video files in Downloads › StudyPilot › ${c.code || c.name} › Lecture videos. Recordings your instructor hasn't allowed to be downloaded are skipped.`)) return;
        const r = await send("VIDEO_FILES", { courseId: c.id });
        toast(`Saved ${plural(r.done, "video")}${r.notAllowed ? `. ${r.notAllowed} can't be downloaded (the instructor turned downloads off)` : ""}${r.failed ? `. ${r.failed} failed` : ""}.`, { ms: 10000 });
      }, { cls: "btn small soft", ico: "download", busyLabel: "Downloading…" })) : "",
    h("p", { class: "hint" }, "StudyPilot reads the captions. Recordings without captions can't be used yet."));
  return box;
}

// Exam dates found in Canvas, announcements and the syllabus; the student can fix them.
const examKey = (e) => `${e.title}|${e.date.slice(0, 10)}`;
export const daysUntil = (iso) => { const d = new Date(iso); const t = new Date(); t.setHours(0, 0, 0, 0); d.setHours(0, 0, 0, 0); return Math.round((d - t) / 864e5); };
export const whenText = (n) => n < 0 ? "past" : n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
async function examsCard(c, { refresh = false } = {}) {
  const data = await send("EXAMS", { courseId: c.id, refresh });
  const { examEdits = {} } = await chrome.storage.local.get("examEdits");
  const ed = examEdits[c.id] || { removed: [], added: [] };
  const save = async () => { examEdits[c.id] = { ...ed, at: Date.now() }; await chrome.storage.local.set({ examEdits }); rerender(); };
  const removed = new Set(ed.removed || []);
  const list = [...data.list.filter((e) => !removed.has(examKey(e))), ...(ed.added || []).map((e) => ({ ...e, source: "added by you", mine: true }))]
    .sort((a, b) => a.date.localeCompare(b.date));
  const fmt = (e) => new Date(e.date).toLocaleString([], { weekday: "short", month: "short", day: "numeric", ...(e.hasTime ? { hour: "numeric", minute: "2-digit" } : {}) });
  const title = h("input", { placeholder: "e.g. Midterm 2", "aria-label": "Exam name" });
  const date = h("input", { type: "datetime-local", "aria-label": "Exam date and time" });
  const box = h("div", { class: "card" }, h("h3", {}, "Exams"),
    list.length ? list.map((e) => { const n = daysUntil(e.date); return h("div", { class: "item" + (n < 0 ? " done" : "") },
      h("div", { class: "main" }, h("div", { class: "name" }, e.title), h("div", { class: "meta" }, `${fmt(e)} · from ${e.source}${e.also?.length ? " (changed since the syllabus)" : ""}`)),
      h("span", { class: `pill ${n <= 3 && n >= 0 ? "now" : n <= 10 && n >= 0 ? "soon" : ""}` }, whenText(n)),
      h("button", { class: "ghost small", title: "Not right? Remove it", "aria-label": `Remove ${e.title}`, onclick: async () => {
        if (e.mine) ed.added = (ed.added || []).filter((x) => examKey(x) !== examKey(e)); else ed.removed = [...new Set([...(ed.removed || []), examKey(e)])];
        await save();
      } }, icon("close", 14))); })
      : h("p", { class: "muted", style: "margin:0" }, `No exam dates found${data.checked?.length ? ` (checked ${data.checked.join(", ")}, assignments, calendar and announcements)` : ""}.`),
    h("details", { class: "adv" }, h("summary", {}, "Add an exam"),
      h("div", { class: "row" }, h("div", { class: "grow" }, title), h("div", { class: "grow" }, date)),
      h("button", { class: "btn small block", style: "margin-top:6px", onclick: async () => {
        if (!title.value.trim() || !date.value) return toast("Add a name and a date.", { error: true });
        ed.added = [...(ed.added || []), { title: title.value.trim(), date: new Date(date.value).toISOString(), hasTime: true }];
        await save();
      } }, "Add")),
    h("div", { class: "row", style: "margin-top:6px" }, h("small", { class: "hint grow" }, "Used by Plan my week and exam prep."),
      act("Check again", async () => { box.replaceWith(await examsCard(c, { refresh: true })); }, { cls: "btn small soft", busyLabel: "Checking…" })));
  return box;
}

// Gradescope: the student's submitted work for this course, graded copies when available.
const GS_ORIGINS = ["https://www.gradescope.com/*"];
// "8.5 / 10.0" → lost points? (only graded work with a copy to read)
export function lostPoints(a) {
  const m = String(a.score || "").match(/(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  return !!(a.submissionPath && m && Number(m[1]) < Number(m[2]));
}
const run = (fn) => async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); } catch (err) { toast(err.message, { error: true, ms: 8000 }); } finally { b.disabled = false; } };
async function learnFromGraded(c, items) {
  const files = items.map((a) => ({ name: `${safeFile(a.name).slice(0, 60)} (graded).pdf`, url: `https://www.gradescope.com${a.submissionPath.replace(/\.pdf$/, "")}.pdf` }));
  const text = mistakesPrompt({ course: c.code || c.name, items: items.map((a, i) => ({ name: a.name, score: a.score, attachName: files[i].name })), count: state.settings.quizCount || 10 });
  await handToAI(text, { expect: "quiz", title: `${c.code || c.name}: where I lost points`, files,
    meta: { courseId: c.id, title: items.length === 1 ? `${items[0].name}: mistakes` : "Where I lost points", lectures: [] } });
}

async function gradescopeCard(c, { refresh = false } = {}) {
  state.gsCache ??= {};
  const allowed = await chrome.permissions.contains({ origins: GS_ORIGINS }).catch(() => false);
  let info = !refresh && state.gsCache[c.id];
  if (!info) {
    if (!allowed) info = { state: "permission", uses: (c.assignments || []).some((a) => /gradescope/i.test(a.kind_label || "")) };
    else info = await send("GS_COURSE", { courseId: c.id, refresh });
    state.gsCache[c.id] = info;
  }
  if (!info.uses && info.state === "permission") return null;
  if (!info.uses && info.state === "ok" && !info.gsId) return null;
  const again = () => { delete state.gsCache[c.id]; rerender(); };
  const box = h("div", { class: "card" }, h("h3", {}, "Gradescope"));
  if (info.state === "permission") {
    box.append(h("p", { class: "muted", style: "margin-top:0" }, "This course uses Gradescope. Connect it once to download your submitted work, with the graded copies (marks and comments) when they're ready."),
      h("button", { class: "btn small", onclick: async () => {
        if (!(await chrome.permissions.request({ origins: GS_ORIGINS }).catch(() => false))) return toast("StudyPilot needs access to gradescope.com to read your work.", { error: true });
        again();
      } }, "Connect Gradescope"),
      h("p", { class: "hint" }, "Uses your own Gradescope login in this browser. StudyPilot only reads; it never submits, and never opens assignments you haven't turned in."));
    return box;
  }
  if (info.state === "login") {
    box.append(h("p", { class: "muted", style: "margin-top:0" }, "Log in to Gradescope once in the tab that opens (choose School Credentials, then your school), then come back."),
      h("div", { class: "actions" },
        h("button", { class: "btn small", onclick: () => send("GS_LOGIN") }, "Log in to Gradescope"),
        act("Check again", async () => { delete state.gsCache[c.id]; state.gsCache[c.id] = await send("GS_COURSE", { courseId: c.id, refresh: true }); rerender(); }, { cls: "btn small secondary", busyLabel: "Checking…" })));
    return box;
  }
  const map = state.settings.gradescopeMap || {};
  const picker = () => h("select", { "aria-label": "Gradescope course", onchange: async (e) => {
    state.gsPicking = null;
    await saveSettings({ gradescopeMap: { ...map, [c.id]: e.target.value } }); again();
  } }, h("option", { value: "" }, "Choose the Gradescope course…"),
    (info.courses || []).map((g) => h("option", { value: g.id, selected: g.id === info.gsId }, `${g.short}${g.term ? ` (${g.term})` : ""}`)),
    h("option", { value: "none" }, "This course doesn't use Gradescope"));
  if (!info.gsId) {
    box.append(h("p", { class: "muted", style: "margin-top:0" }, "Which Gradescope course is this?"), picker());
    return box;
  }
  const list = info.assignments || [];
  const done = list.filter((a) => a.submissionPath);
  const lost = list.filter(lostPoints);
  box.append(
    h("div", { class: "row" }, h("div", { class: "grow" }, h("b", {}, info.gsCourse?.short || "Gradescope course"), h("div", { class: "meta" }, `${plural(done.length, "submission")} of ${plural(list.length, "assignment")}`)),
      h("button", { class: "btn small soft", onclick: () => { state.gsPicking = c.id; rerender(); } }, "Change")),
    state.gsPicking === c.id ? picker() : "",
    h("div", { class: "gs-list" }, list.slice(0, 12).map((a) => h("div", { class: "gs-row" },
      h("span", { class: "grow" }, a.name), h("small", { class: a.submissionPath ? "" : "muted" }, a.score || a.status),
      lostPoints(a) ? h("button", { class: "btn tiny soft", title: "Your AI reads the graded copy and quizzes you on what lost points",
        onclick: run(() => learnFromGraded(c, [a])) }, "Learn from it") : null))),
    lost.length > 1 ? h("button", { class: "sheet-tile", style: "margin-top:8px", onclick: run(() => learnFromGraded(c, lost.slice(0, 4))) },
      h("span", { class: "ico-wrap" }, icon("target", 18)), h("span", { class: "grow" }, h("b", {}, "Practice where I lost points"),
        h("small", {}, `Your AI reads ${lost.length > 4 ? "your 4 most recent" : `all ${lost.length}`} graded copies with deductions and quizzes you on those ideas`)), icon("chevron", 16)) : "",
    list.length > 12 ? h("div", { class: "hint" }, `+${list.length - 12} more`) : "",
    h("div", { class: "actions" },
      act("Download graded work", async () => {
        await askFileHostAccess();
        const r = await send("GS_DOWNLOAD", { courseId: c.id });
        toast(`Saved ${r.zip} (${plural(r.added, "file")})${r.failed ? `. ${plural(r.failed, "item")} couldn't be added; see “_Not included.txt”.` : "."}`, { ms: 9000 });
      }, { ico: "download", busyLabel: "Zipping…" }),
      act("Refresh", async () => { state.gsCache[c.id] = await send("GS_COURSE", { courseId: c.id, refresh: true }); rerender(); }, { cls: "btn small soft", busyLabel: "Checking…" })),
    h("p", { class: "hint" }, "Graded copies (with marks and comments) when they're ready, otherwise what you turned in. Assignments you haven't submitted are never opened."));
  return box;
}

// One zip per course for an AI project: overview, a file per module, originals alongside.
export async function makeProjectPack(courseIds, { onlyNew = true } = {}) {
  if (!courseIds.length) throw new Error("Pick at least one course.");
  if (!(await askFileHostAccess())) toast("Without access to Canvas's file storage, slides can't be read or zipped; they'll be listed instead.", { ms: 7000 });
  const data = await send("PROJECT_DATA", { courseIds });
  const courses = data.map((course) => {
    const files = [{ path: "00 Course overview.md", text: exportPack([course.overview], { goal: "context", tz, prefs: state.settings }) }];
    const mods = new Map();
    for (const x of course.docs) { const m = x.lecture.module; if (!mods.has(m)) mods.set(m, { index: x.lecture.module_index, items: [] }); mods.get(m).items.push(x); }
    for (const [module, g] of [...mods.entries()].sort((a, b) => a[1].index - b[1].index)) {
      const mdir = `${String(g.index + 1).padStart(2, "0")} ${safeFile(module).slice(0, 60)}`;
      const entries = g.items.map((x) => {
        if (x.error) return { title: x.lecture.title, error: x.error };
        const d = x.doc;
        if (d.kind === "file") { files.push({ path: `${mdir}/${safeFile(d.file.name)}`, url: d.file.url, key: `pf:${course.id}:${d.file.id}`, version: d.version }); return { doc: d, attachName: safeFile(d.file.name) }; }
        const imageNames = (d.images || []).map((im) => { files.push({ path: `${mdir}/${safeFile(im.name)}`, url: im.url, key: `pi:${course.id}:${im.id}`, version: String(im.size) }); return safeFile(im.name); });
        return { doc: d, imageNames };
      });
      files.push({ path: `${mdir}/${mdir}.md`, text: projectModuleMd({ course: course.name, module, entries }) });
    }
    return { name: course.name, howto: PROJECT_HOWTO([course.name]), files };
  });
  const results = await send("PROJECT_ZIP", { courses, onlyNew });
  const made = results.filter((r) => r.zip);
  const failed = made.reduce((a, r) => a + r.failed, 0);
  if (made[0]?.downloadId) chrome.downloads.show(made[0].downloadId);
  toast(made.length ? `${plural(made.length, "zip")} saved to Downloads › StudyPilot${failed ? ". Some files couldn't be added; see “_Not included.txt” inside." : "."}` : "Nothing changed since your last pack.", { ms: 9000 });
}
