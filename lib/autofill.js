// "Fill it in for me": types the request into the AI's chat box and attaches files. It never presses Send.
// Works by injecting a small function into the AI tab (needs the student's permission for that site).
// If anything fails, the request is still on the clipboard and the files go to a folder, as before.

export const FILL_SITES = {
  claude: ["https://claude.ai/*"],
  chatgpt: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  gemini: ["https://gemini.google.com/*"],
  copilot: ["https://copilot.microsoft.com/*"],
};
export const MAX_FILL_BYTES = 25e6;

export const canFill = (providerId) => !!FILL_SITES[providerId];
export const hasFillPermission = (providerId) =>
  canFill(providerId) ? chrome.permissions.contains({ origins: FILL_SITES[providerId] }).catch(() => false) : Promise.resolve(false);
// Must run directly in a click handler (Chrome only shows permission prompts for a user gesture).
export const requestFillPermission = (providerId) =>
  canFill(providerId) ? chrome.permissions.request({ origins: FILL_SITES[providerId] }).catch(() => false) : Promise.resolve(false);

function waitForLoad(tabId, ms = 20000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(t); resolve(); };
    const on = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const t = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === "complete") done(); }).catch(done);
  });
}

const toBase64 = async (blob) => {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
};

// files: [{ url, name }] (Canvas file URLs or blob: URLs made in the panel)
export async function loadFiles(files) {
  const out = [];
  let total = 0;
  for (const f of files) {
    const r = await fetch(f.url, { credentials: "include" });
    if (!r.ok) throw new Error(`Couldn't load ${f.name}`);
    const blob = await r.blob();
    total += blob.size;
    if (total > MAX_FILL_BYTES) throw new Error("Files too large to attach automatically");
    out.push({ name: f.name, type: blob.type || "application/octet-stream", data: await toBase64(blob) });
  }
  return out;
}

/** Opens nothing; fills an already-open tab. Returns { filled, attached, reason } */
export async function fillTab(tabId, { text, files = [] }) {
  await waitForLoad(tabId);
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: pageFill, args: [text, files] });
  return result || { filled: false, attached: 0, reason: "no result" };
}

// ---- runs inside the AI's page ----
export async function pageFill(text, files) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => el && el.offsetParent !== null && el.getBoundingClientRect().height > 0;
  const SELECTORS = [
    "#prompt-textarea", "div.ProseMirror[contenteditable=true]", "rich-textarea .ql-editor", "div.ql-editor[contenteditable=true]",
    "textarea#userInput", "textarea[data-testid=composer-input]", "[contenteditable=true][role=textbox]", "main textarea", "textarea",
  ];
  let box = null;
  for (let i = 0; i < 60 && !box; i++) {
    for (const sel of SELECTORS) { const el = [...document.querySelectorAll(sel)].find(visible); if (el) { box = el; break; } }
    if (!box) await sleep(250);
  }
  if (!box) return { filled: false, attached: 0, reason: "Couldn't find the chat box (are you logged in?)" };

  // Files first, so the text ends up last and ready to send.
  let attached = 0;
  if (files.length) {
    const dt = new DataTransfer();
    for (const f of files) {
      const bin = atob(f.data), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const input = [...document.querySelectorAll("input[type=file]")].find((x) => x.multiple || files.length === 1) || document.querySelector("input[type=file]");
    if (input) {
      try { input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); attached = files.length; } catch { /* try paste */ }
    }
    if (!attached) {
      box.focus();
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      box.dispatchEvent(ev);
      if (ev.defaultPrevented) attached = files.length;
    }
    await sleep(1200);
  }

  box.focus();
  const before = (box.value ?? box.innerText ?? "").length;
  if (box.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(box, (box.value ? box.value + "\n" : "") + text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const sel = getSelection(); sel.selectAllChildren(box); sel.collapseToEnd();
    document.execCommand("insertText", false, text);
  }
  await sleep(300);
  const after = (box.value ?? box.innerText ?? "").length;
  return { filled: after > before + Math.min(50, text.length / 2), attached, reason: after > before ? "" : "The chat box didn't accept the text" };
}
