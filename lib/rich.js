// Math and code in quiz text: ```code blocks``` (or ~~~), `inline code`, $math$, $$display math$$, \( \) and \[ \].
// Math is drawn with KaTeX (bundled in vendor/katex, loaded by the side panel as window.katex).
// Everything else stays plain text (never parsed as HTML), so a question can't inject anything into the page.

// Split text into pieces: { t: "text" | "code" | "icode" | "math" | "dmath", v, lang }
export function tokenize(src) {
  const s = String(src ?? "");
  const out = [];
  const re = /(?:```|~~~)([\w+#.-]*)[ \t]*\n?([\s\S]*?)(?:```|~~~)|`([^`\n]+)`|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$((?:\\\$|[^$\n])+?)\$/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    // "$5 and $10" is money, not math: inline $…$ must not start or end with a space, and not be followed by a digit.
    if (m[7] != null && (/^\s|\s$/.test(m[7]) || /\d/.test(s[re.lastIndex] || ""))) { re.lastIndex = m.index + 1; continue; }
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[2] != null) out.push({ t: "code", v: m[2].replace(/\n$/, ""), lang: m[1] || "" });
    else if (m[3] != null) out.push({ t: "icode", v: m[3] });
    else if (m[4] != null || m[5] != null) out.push({ t: "dmath", v: (m[4] ?? m[5]).trim() });
    else out.push({ t: "math", v: (m[6] ?? m[7]).trim() });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

export const hasRich = (s) => tokenize(s).some((p) => p.t !== "text");

// Builds DOM nodes (a <span class="rich">) for the text.
export function rich(src, doc = document) {
  const box = doc.createElement("span");
  box.className = "rich";
  const parts = tokenize(src);
  const block = (p) => p && (p.t === "code" || p.t === "dmath");
  parts.forEach((p, i) => {
    if (p.t === "text") {
      // No stray blank line or space next to a code block or display math (they already sit on their own line).
      let v = p.v;
      if (block(parts[i - 1])) v = v.replace(/^[ \t]*\n?[ \t]*/, "");
      if (block(parts[i + 1])) v = v.replace(/[ \t]*\n?[ \t]*$/, "");
      v.split("\n").forEach((line, i) => { if (i) box.append(doc.createElement("br")); if (line) box.append(doc.createTextNode(line)); });
    } else if (p.t === "code") {
      const pre = doc.createElement("pre"), code = doc.createElement("code");
      pre.className = "code"; if (p.lang) code.dataset.lang = p.lang;
      code.textContent = p.v;
      pre.append(code); box.append(pre);
    } else if (p.t === "icode") {
      const c = doc.createElement("code"); c.textContent = p.v; box.append(c);
    } else {
      const el = doc.createElement(p.t === "dmath" ? "div" : "span");
      el.className = p.t === "dmath" ? "math display" : "math";
      const k = globalThis.katex;
      try {
        if (!k) throw new Error("no katex");
        k.render(p.v, el, { displayMode: p.t === "dmath", throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml" });
      } catch { el.textContent = p.t === "dmath" ? `$$${p.v}$$` : `$${p.v}$`; }
      box.append(el);
    }
  });
  return box;
}

// AIs often write LaTeX inside JSON with single backslashes ("$\frac{a}{b}$"). In JSON, \f \b \n \t \r are real escapes,
// so "\frac" would silently become a form feed + "rac". Before parsing, double any lone backslash inside string values
// that isn't one of JSON's own escapes used on purpose (\" \\ \/ \uXXXX) or a plain \n line break between words.
export function repairLatexJson(text) {
  return String(text).replace(/"(?:[^"\\]|\\.)*"/gs, (str) =>
    str.replace(/\\(\\|"|\/|u[0-9a-fA-F]{4}|[a-zA-Z]+|.)/g, (all, x) => {
      if (x === "\\" || x === '"' || x === "/" || /^u[0-9a-fA-F]{4}$/.test(x)) return all;
      // \n, \t, \r alone (not starting a longer word like \nu, \theta, \rho) are real line breaks/tabs
      if (/^[ntr]$/.test(x)) return all;
      if (/^[a-zA-Z]+$/.test(x)) {
        if (/^[ntr]$/.test(x[0]) && !LATEX_N.test(x)) return all; // "\nNext line" → keep as newline
        return "\\\\" + x;
      }
      return "\\\\" + x; // \{ \, \; \! \$ \( and friends
    }));
}
// LaTeX commands that start with n, t or r (so "\nu" isn't read as a newline followed by "u").
const LATEX_N = /^(n(u|eq|abla|ot|i|e|eg|exists|ewline|leq|geq|mid|parallel|subseteq|supseteq|rightarrow|leftarrow|cdot|vdash|ormalsize)?|t(heta|au|imes|ext\w*|frac|ilde|o|op|riangle\w*|herefore|extbf|extit|extrm|t|binom|ag|an|anh|h)|r(ho|ightarrow|ight|angle|ceil|floor|m|Rightarrow|ightleftharpoons|ad|oot|e|vert|Vert))$/;
