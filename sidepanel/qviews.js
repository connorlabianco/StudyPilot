// Drawing and checking the v2 question formats inside the practice window. Everything is graded here, offline.
import { h } from "./core.js";
import { rich } from "../lib/rich.js";
import { filled, shownNumber, gradeMulti, gradeMatch, gradeOrder, gradeNumeric, gradePoints, gradeSteps } from "../lib/qtypes.js";
import { closeEnough } from "../lib/formula.js";

const LETTERS = "ABCDEFGH";
// Dropdown menus can't draw math, so show LaTeX as readable text: "$\\tau_i$" → "τ_i".
const GREEK = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", nu: "ν", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", chi: "χ", omega: "ω", Sigma: "Σ", Delta: "Δ" };
const plainMath = (s) => String(s).replace(/\$([^$]*)\$/g, (m, x) => x.replace(/\\(\w+)/g, (a, w) => GREEK[w] || w).replace(/[{}]/g, "")).trim();
const shuffled = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Per-question random setup, done once when the session starts.
export function setupV2(q) {
  const d = q.data || {};
  const o = {};
  if (d.options) o.order = shuffled(d.options.map((_, i) => i));
  if (q.type === "tf" && d.reasons?.length) o.reasonOrder = shuffled(d.reasons.map((_, i) => i));
  if (q.type === "match") o.rights = shuffled(d.pairs.map((p) => p[1]));
  if (q.type === "order") { let s = shuffled(d.steps); if (s.every((x, i) => x === d.steps[i])) s = [...s.slice(1), s[0]]; o.start = s; }
  return o;
}

/**
 * ctx: { ui (per-question state object), exam (no feedback until the end), grade(g, extra), next(), redraw(), inst (fresh numbers) }
 */
export function drawV2(body, q, ctx) {
  const d = q.data || {}, ui = ctx.ui, inst = ctx.inst, setup = ctx.setup || {};
  const txt = (s) => rich(filled(s, inst));
  body.append(h("div", { class: "rn-q" }, txt(q.prompt)));
  // One hint per question: a nudge, never the answer. Using it counts as help (like "Stuck?").
  const hintBox = (text, key) => {
    if (!text || ctx.exam) return null;
    if (ui.hints?.[key]) return h("div", { class: "rn-hint", role: "note" }, h("b", {}, "Hint: "), txt(text));
    if (ui.done) return null;
    return h("button", { class: "hint-btn", title: "A nudge toward the idea, not the answer. Practice still counts; mastery needs a later answer without hints.",
      onclick: () => { (ui.hints ||= {})[key] = true; ctx.markHelp?.(); ctx.redraw(); } }, "Hint");
  };
  if (q.type !== "steps") { const hb = hintBox(q.hint, "q"); if (hb) body.append(hb); }

  const done = (g, extra = {}) => {
    ui.grade = g; ui.done = true;
    ctx.grade(g, extra);
    if (ctx.exam) return ctx.next();
    ctx.redraw();
  };
  const fb = (extra = null) => {
    if (!ui.done || ctx.exam) return;
    const g = ui.grade;
    body.append(h("div", { class: "rn-fb " + (g === "right" ? "good" : g === "partial" ? "part" : "bad"), role: "status" },
      h("b", {}, g === "right" ? "Correct" : g === "partial" ? "Partly right" : "Not quite"),
      extra, q.explanation ? h("div", {}, txt(q.explanation)) : null));
    body.append(h("button", { class: "btn block", "data-autofocus": true, onclick: ctx.next }, ctx.last ? "See results" : "Next", h("kbd", {}, "Enter")));
  };
  const check = (label, fn, disabled = false) => h("button", { class: "btn block", disabled, "data-check": true, onclick: fn }, label, h("kbd", {}, "Enter"));

  if (q.type === "mcq") {
    const list = h("div", { class: "rn-opts" });
    setup.order.forEach((orig, n) => {
      let cls = "rn-opt";
      if (ui.done) { if (orig === d.answer) cls += " right"; else if (orig === ui.picked) cls += " wrong"; }
      list.append(h("button", { class: cls, disabled: ui.done, "data-key": LETTERS[n], onclick: () => { ui.picked = orig; done(orig === d.answer ? "right" : "wrong", { given: d.options[orig] }); } },
        h("span", { class: "key" }, LETTERS[n]), h("span", { class: "grow" }, txt(d.options[orig]),
          ui.done && d.why?.[orig] && (orig === ui.picked || orig === d.answer) ? h("small", { class: "why" }, txt(d.why[orig])) : null)));
    });
    body.append(list);
    fb();
  }

  else if (q.type === "multi") {
    ui.sel ||= new Set();
    const list = h("div", { class: "rn-opts" });
    setup.order.forEach((orig, n) => {
      const isAns = d.answers.includes(orig), picked = ui.sel.has(orig);
      let cls = "rn-opt check" + (picked ? " picked" : "");
      if (ui.done) cls += isAns ? (picked ? " right" : " missed") : picked ? " wrong" : "";
      list.append(h("button", { class: cls, role: "checkbox", "aria-checked": picked, disabled: ui.done, "data-key": LETTERS[n],
        onclick: () => { picked ? ui.sel.delete(orig) : ui.sel.add(orig); ctx.redraw(); } },
        h("span", { class: "key box" }, picked ? "✓" : LETTERS[n]), h("span", { class: "grow" }, txt(d.options[orig]))));
    });
    body.append(h("div", { class: "hint" }, "Select all that apply."), list);
    if (!ui.done) body.append(check("Check", () => done(gradeMulti([...ui.sel], d.answers), { given: [...ui.sel].map((i) => d.options[i]).join("; ") }), !ui.sel.size));
    fb(ui.done && ui.grade !== "right" ? h("div", {}, "Green: correct ones. Dashed: correct ones you missed.") : null);
  }

  else if (q.type === "tf") {
    const row = h("div", { class: "rn-opts two" });
    [[true, "True", "T"], [false, "False", "F"]].forEach(([v, l, k]) => {
      let cls = "rn-opt";
      if (ui.tf === v) cls += " chosen";
      if (ui.done) { if (v === d.answer) cls += " right"; else if (v === ui.tf) cls += " wrong"; }
      row.append(h("button", { class: cls, disabled: ui.done || ui.tf != null, "data-key": k, onclick: () => {
        ui.tf = v;
        if (!d.reasons?.length) done(v === d.answer ? "right" : "wrong", { given: l }); else ctx.redraw();
      } }, h("span", { class: "key" }, k), h("span", {}, l)));
    });
    body.append(row);
    if (ui.tf != null && d.reasons?.length) {
      body.append(h("div", { class: "field" }, "Why?"));
      const list = h("div", { class: "rn-opts" });
      setup.reasonOrder.forEach((orig, n) => {
        let cls = "rn-opt";
        if (ui.done) { if (orig === d.reason) cls += " right"; else if (orig === ui.reason) cls += " wrong"; }
        list.append(h("button", { class: cls, disabled: ui.done, "data-key": LETTERS[n], onclick: () => {
          ui.reason = orig;
          const g = ui.tf === d.answer ? (orig === d.reason ? "right" : "partial") : "wrong";
          done(g, { given: `${ui.tf ? "True" : "False"}: ${d.reasons[orig]}` });
        } }, h("span", { class: "key" }, LETTERS[n]), h("span", {}, txt(d.reasons[orig]))));
      });
      body.append(list);
    }
    fb(ui.done && ui.tf !== d.answer ? h("div", {}, `It's ${d.answer ? "true" : "false"}.`) : null);
  }

  else if (q.type === "match") {
    ui.chosen ||= d.pairs.map(() => "");
    const grid = h("div", { class: "rn-match" });
    d.pairs.forEach(([left, right], i) => {
      const sel = h("select", { "aria-label": `Match for: ${left}`, disabled: ui.done, onchange: (e) => { ui.chosen[i] = e.target.value; ctx.redraw(); } },
        h("option", { value: "" }, "Choose…"), setup.rights.map((r) => h("option", { value: r, selected: ui.chosen[i] === r }, plainMath(r))));
      const mark = ui.done ? (ui.chosen[i] === right ? "right" : "wrong") : "";
      grid.append(h("div", { class: `rn-mrow ${mark}` }, h("div", { class: "rn-mleft" }, txt(left)), sel,
        ui.done && ui.chosen[i] !== right ? h("div", { class: "rn-mfix" }, "Answer: ", txt(right)) : null));
    });
    body.append(grid);
    if (!ui.done) body.append(check("Check", () => done(gradeMatch(ui.chosen, d.pairs), { given: ui.chosen.join("; ") }), ui.chosen.some((c) => !c)));
    fb();
  }

  else if (q.type === "order") {
    ui.cur ||= [...setup.start];
    const list = h("ol", { class: "rn-order" });
    ui.cur.forEach((step, i) => {
      const ok = ui.done ? step === d.steps[i] : null;
      list.append(h("li", { class: ok === true ? "right" : ok === false ? "wrong" : "" },
        h("span", { class: "grow" }, txt(step)),
        ui.done ? null : h("span", { class: "rn-move" },
          h("button", { class: "ghost", "aria-label": `Move "${step}" up`, disabled: i === 0, onclick: () => { [ui.cur[i - 1], ui.cur[i]] = [ui.cur[i], ui.cur[i - 1]]; ctx.redraw(); } }, "↑"),
          h("button", { class: "ghost", "aria-label": `Move "${step}" down`, disabled: i === ui.cur.length - 1, onclick: () => { [ui.cur[i + 1], ui.cur[i]] = [ui.cur[i], ui.cur[i + 1]]; ctx.redraw(); } }, "↓"))));
    });
    body.append(h("div", { class: "hint" }, "Use the arrows to put these in the right order."), list);
    if (!ui.done) body.append(check("Check", () => done(gradeOrder(ui.cur, d.steps), { given: ui.cur.join(" → ") })));
    fb(ui.done && ui.grade !== "right" ? h("ol", { class: "rn-order key" }, d.steps.map((s) => h("li", {}, txt(s)))) : null);
  }

  else if (q.type === "numeric") {
    const answer = inst ? inst.answer : d.answer;
    const input = h("input", { type: "text", inputmode: "decimal", class: "rn-num", "aria-label": "Your answer", placeholder: "Your answer", value: ui.typed || "", disabled: ui.done,
      oninput: (e) => (ui.typed = e.target.value), onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } } });
    const submit = () => { if (!String(ui.typed || "").trim()) return; done(gradeNumeric(ui.typed, answer, d.tolerance), { given: ui.typed }); };
    body.append(h("div", { class: "rn-numrow" }, input, d.unit ? h("span", { class: "muted" }, d.unit) : null));
    if (!ui.done) { body.append(check("Check", submit)); queueMicrotask(() => input.focus()); }
    fb(ui.done ? h("div", {}, "Answer: ", h("b", {}, String(shownNumber(answer, q))), d.unit ? ` ${d.unit}` : "") : null);
  }

  else if (q.type === "error") {
    const list = h("div", { class: "rn-opts lines" });
    d.lines.forEach((line, n) => {
      let cls = "rn-opt line";
      if (ui.done) { if (n === d.wrong) cls += " wrong-line"; else if (n === ui.picked) cls += " wrong"; }
      list.append(h("button", { class: cls, disabled: ui.done, "data-key": LETTERS[n], onclick: () => { ui.picked = n; done(n === d.wrong ? "right" : "wrong", { given: `line ${n + 1}` }); } },
        h("span", { class: "key" }, String(n + 1)), h("span", { class: "grow" }, txt(line))));
    });
    body.append(h("div", { class: "hint" }, "Click the line with the mistake."), list);
    fb(ui.done && d.fix ? h("div", {}, `Line ${d.wrong + 1} should be: `, txt(d.fix)) : null);
  }

  else if (q.type === "steps") {
    ui.step ??= 0; ui.res ||= [];
    if (d.example) body.append(h("details", { class: "rn-example", open: ui.step === 0 && !ctx.exam },
      h("summary", {}, "Worked example (study it, then try yours)"), h("div", {}, txt(d.example))));
    d.steps.forEach((st, i) => {
      if (i > ui.step) return;
      const box = h("div", { class: "rn-step" + (i < ui.step ? " past" : "") }, h("div", { class: "rn-step-q" }, h("b", {}, `Step ${i + 1}. `), txt(st.question)));
      const ans = st.formula ? inst?.stepAnswers?.[i] : st.answer;
      const finishStep = (ok) => {
        ui.res[i] = ok;
        if (i + 1 < d.steps.length) { ui.step = i + 1; ctx.redraw(); }
        else done(gradeSteps(ui.res), { given: ui.res.map((r) => (r ? "✓" : "✗")).join(" ") });
      };
      if (i < ui.step || ui.done) {
        box.append(h("div", { class: `rn-step-a ${ui.res[i] ? "right" : "wrong"}` }, ui.res[i] ? "✓ " : "✗ Answer: ",
          st.options ? txt(st.options[st.answer]) : String(shownNumber(ans, q))));
      } else if (st.options) {
        const list = h("div", { class: "rn-opts" });
        st.options.forEach((o, n) => list.append(h("button", { class: "rn-opt", "data-key": LETTERS[n], onclick: () => finishStep(n === st.answer) }, h("span", { class: "key" }, LETTERS[n]), h("span", {}, txt(o)))));
        box.append(list);
      } else {
        const input = h("input", { type: "text", inputmode: "decimal", class: "rn-num", "aria-label": `Step ${i + 1} answer`, placeholder: "Your answer",
          onkeydown: (e) => { if (e.key === "Enter" && e.target.value.trim()) { e.preventDefault(); finishStep(closeEnough(e.target.value, ans, st.tolerance)); } } });
        box.append(h("div", { class: "rn-numrow" }, input,
          h("button", { class: "btn small", onclick: () => input.value.trim() && finishStep(closeEnough(input.value, ans, st.tolerance)) }, "Check")));
        queueMicrotask(() => input.focus());
      }
      if (i === ui.step && !ui.done && !ctx.exam) {
        const hb = hintBox(st.hint, `s${i}`);
        box.append(h("div", { class: "rn-stephelp" }, hb, h("button", { class: "linkish", onclick: () => { ctx.markHelp?.(); finishStep(false); } }, "Show me this step")));
      }
      body.append(box);
    });
    fb();
  }

  else if (q.type === "explain") {
    if (!ui.checked) {
      const ta = h("textarea", { rows: 5, placeholder: "Explain it in your own words…", "aria-label": "Your explanation", oninput: (e) => (ui.typed = e.target.value) });
      ta.value = ui.typed || "";
      body.append(ta, check(ctx.exam ? "Next" : "Compare with the key points", () => {
        if (ctx.exam) { ctx.grade(null, { given: ui.typed || "" }); return ctx.next(); }
        ui.checked = true; ctx.redraw();
      }));
      queueMicrotask(() => ta.focus());
    } else {
      ui.ticks ||= d.points.map(() => false);
      body.append(
        ui.typed?.trim() ? h("div", { class: "rn-yours" }, h("div", { class: "meta" }, "Yours"), ui.typed) : null,
        h("div", { class: "field" }, "Tick each key point your answer covered (in any words):"),
        h("div", { class: "rn-points" }, d.points.map((p, i) => h("label", { class: "rn-point" },
          h("input", { type: "checkbox", checked: ui.ticks[i], disabled: ui.done, onchange: (e) => { ui.ticks[i] = e.target.checked; } }), h("span", {}, txt(p))))),
        h("details", { class: "rn-model" }, h("summary", {}, "Model answer"), h("div", {}, txt(d.answer))));
      if (!ui.done) body.append(check("Done", () => done(gradePoints(ui.ticks.filter(Boolean).length, d.points.length), { given: ui.typed || "" })));
      fb();
    }
  }
}

// Exam mode grades written explanations at the end, by key points.
export function gradeExplainLater(body, q, r, onGraded, inst) {
  const d = q.data, ticks = d.points.map(() => false);
  body.append(h("div", { class: "rn-q" }, rich(filled(q.prompt, inst))),
    r.given?.trim() ? h("div", { class: "rn-yours" }, h("div", { class: "meta" }, "Yours"), r.given) : h("div", { class: "meta" }, "(No answer written)"),
    h("div", { class: "field" }, "Tick each key point your answer covered:"),
    h("div", { class: "rn-points" }, d.points.map((p, i) => h("label", { class: "rn-point" }, h("input", { type: "checkbox", onchange: (e) => (ticks[i] = e.target.checked) }), h("span", {}, rich(p))))),
    h("details", { class: "rn-model" }, h("summary", {}, "Model answer"), h("div", {}, rich(d.answer))),
    h("button", { class: "btn block", onclick: () => onGraded(gradePoints(ticks.filter(Boolean).length, d.points.length)) }, "Done"));
}

// Keyboard for v2: letters pick options/lines, T/F, Enter checks or goes on.
export function keyV2(e, q, ui) {
  if (e.defaultPrevented) return; // an input already handled it (e.g. Enter in a number box)
  const k = e.key;
  const runner = document.querySelector("#runner");
  if (k === "Enter") {
    const btn = ui.done ? runner.querySelector(".rn-fb ~ .btn") : runner.querySelector("[data-check]:not([disabled])");
    if (btn) { e.preventDefault(); btn.click(); }
    return;
  }
  if (ui.done || e.target.matches?.("input, textarea, select")) return;
  const key = k.length === 1 ? k.toUpperCase() : null;
  if (!key) return;
  const btn = [...runner.querySelectorAll(".rn-body [data-key]:not([disabled])")].reverse().find((b) => b.dataset.key === key);
  if (btn) { e.preventDefault(); btn.click(); }
}
