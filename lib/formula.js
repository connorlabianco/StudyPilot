// A small, safe calculator for "fresh numbers" problems. It understands numbers, variables, + - * / ^ %,
// parentheses and a fixed list of math functions. It never runs code: anything else is rejected.
// Pure (tested in Node).

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max, pow: Math.pow,
  // handy for stats courses
  choose: (n, k) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); },
  fact: (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; },
  phi: (z) => 0.5 * (1 + erf(z / Math.SQRT2)), // standard normal CDF
};
const CONSTS = { pi: Math.PI, e: Math.E };

function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

function tokenize(src) {
  const out = [];
  const s = String(src);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = s.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/);
    if (num) { out.push({ t: "n", v: Number(num[0]) }); i += num[0].length; continue; }
    const id = s.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/);
    if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
    if ("+-*/^%(),".includes(c)) { out.push({ t: c }); i++; continue; }
    if (c === "×" || c === "·") { out.push({ t: "*" }); i++; continue; }
    if (c === "÷") { out.push({ t: "/" }); i++; continue; }
    if (c === "−") { out.push({ t: "-" }); i++; continue; }
    throw new Error(`Unexpected "${c}" in formula`);
  }
  return out;
}

// Grammar: expr = term (('+'|'-') term)* ; term = unary (('*'|'/'|'%') unary)* ; unary = '-' unary | power ;
//          power = atom ('^' unary)? ; atom = number | id | id '(' args ')' | '(' expr ')'
export function parseFormula(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p], eat = (t) => (toks[p]?.t === t ? toks[p++] : null);
  const need = (t) => { if (!eat(t)) throw new Error(`Expected "${t}" in formula`); };
  function expr() { let n = term(); for (;;) { if (eat("+")) n = { op: "+", a: n, b: term() }; else if (eat("-")) n = { op: "-", a: n, b: term() }; else return n; } }
  function term() { let n = unary(); for (;;) { if (eat("*")) n = { op: "*", a: n, b: unary() }; else if (eat("/")) n = { op: "/", a: n, b: unary() }; else if (eat("%")) n = { op: "%", a: n, b: unary() }; else return n; } }
  function unary() { if (eat("-")) return { op: "neg", a: unary() }; if (eat("+")) return unary(); return power(); }
  function power() { const base = atom(); if (eat("^")) return { op: "^", a: base, b: unary() }; return base; }
  function atom() {
    const tk = peek();
    if (!tk) throw new Error("Formula ended early");
    if (tk.t === "n") { p++; return { num: tk.v }; }
    if (tk.t === "(") { p++; const n = expr(); need(")"); return n; }
    if (tk.t === "id") {
      p++;
      if (eat("(")) {
        if (!Object.hasOwn(FUNCS, tk.v)) throw new Error(`Unknown function "${tk.v}"`);
        const args = [];
        if (!eat(")")) { do args.push(expr()); while (eat(",")); need(")"); }
        return { fn: tk.v, args };
      }
      return { id: tk.v };
    }
    throw new Error(`Unexpected "${tk.t}" in formula`);
  }
  const tree = expr();
  if (p < toks.length) throw new Error("Extra text at the end of the formula");
  return tree;
}

export function evaluate(tree, vars = {}) {
  const ev = (n) => {
    if ("num" in n) return n.num;
    if ("id" in n) {
      if (Object.prototype.hasOwnProperty.call(vars, n.id)) return Number(vars[n.id]);
      if (Object.hasOwn(CONSTS, n.id)) return CONSTS[n.id];
      throw new Error(`Unknown name "${n.id}"`);
    }
    if ("fn" in n) return FUNCS[n.fn](...n.args.map(ev));
    const a = ev(n.a);
    switch (n.op) {
      case "neg": return -a;
      case "+": return a + ev(n.b);
      case "-": return a - ev(n.b);
      case "*": return a * ev(n.b);
      case "/": return a / ev(n.b);
      case "%": return a % ev(n.b);
      case "^": return Math.pow(a, ev(n.b));
    }
    throw new Error("Bad formula");
  };
  return ev(tree);
}

export const calc = (src, vars) => evaluate(parseFormula(src), vars);

// ---------- recipes: "fresh numbers" problems ----------
// vars: { name: { min, max, step } or [choice, choice, …] }
function pickVar(spec, rand) {
  if (Array.isArray(spec)) return spec[Math.floor(rand() * spec.length)];
  const min = Number(spec.min), max = Number(spec.max), step = Number(spec.step) || (Number.isInteger(min) && Number.isInteger(max) ? 1 : 0.1);
  const n = Math.max(0, Math.floor((max - min) / step));
  const v = min + Math.floor(rand() * (n + 1)) * step;
  const dec = (String(step).split(".")[1] || "").length;
  return Number(v.toFixed(dec));
}

/** Fresh values for a recipe whose answer is a finite number (tries a few times). Returns { vars, answer } or null. */
export function instantiate(recipe, rand = Math.random) {
  const tree = parseFormula(recipe.formula);
  for (let tries = 0; tries < 25; tries++) {
    const vars = {};
    for (const [k, spec] of Object.entries(recipe.vars || {})) vars[k] = pickVar(spec, rand);
    try {
      const answer = evaluate(tree, vars);
      if (Number.isFinite(answer)) return { vars, answer };
    } catch { return null; }
  }
  return null;
}

// Fill {name} placeholders in the question text.
export const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

// Is the student's number close enough? tolerance: number (absolute) or "2%" (relative). Default: 1% or rounding to 2 decimals.
export function closeEnough(given, answer, tolerance) {
  const g = Number(String(given).replace(/,/g, "").replace(/[^\d.eE+-]/g, ""));
  if (!Number.isFinite(g) || String(given).trim() === "") return false;
  const a = Number(answer);
  if (typeof tolerance === "string" && /%$/.test(tolerance)) return Math.abs(g - a) <= Math.abs(a) * (parseFloat(tolerance) / 100) + 1e-12;
  if (tolerance != null && Number.isFinite(Number(tolerance))) return Math.abs(g - a) <= Number(tolerance) + 1e-12;
  return Math.abs(g - a) <= Math.max(Math.abs(a) * 0.01, 0.005) + 1e-12;
}
