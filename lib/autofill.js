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
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30e3);
    const r = await fetch(f.url, { credentials: "include", signal: ctl.signal }).catch(() => null).finally(() => clearTimeout(t));
    if (!r) throw new Error(`Couldn't load ${f.name} in time`);
    if (!r.ok) throw new Error(`Couldn't load ${f.name}`);
    const blob = await r.blob();
    total += blob.size;
    if (total > MAX_FILL_BYTES) throw new Error("Files too large to attach automatically");
    out.push({ name: f.name, type: blob.type || "application/octet-stream", data: await toBase64(blob) });
  }
  return out;
}

/** Opens nothing; fills an already-open tab. Returns { filled, attached, reason } */
// Never leaves StudyPilot waiting: if the AI's page doesn't answer within 45 seconds, give up and use copy and paste.
export async function fillTab(tabId, { text, files = [] }) {
  const work = (async () => {
    await waitForLoad(tabId);
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: pageFill, args: [text, files] });
    return result || { filled: false, attached: 0, reason: "no result" };
  })();
  const limit = new Promise((r) => setTimeout(() => r({ filled: false, attached: 0, reason: "The AI's page took too long to respond" }), 45e3));
  return Promise.race([work, limit]);
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
  const attachmentsBefore = document.querySelectorAll("[data-testid*=file], [data-testid*=attachment], [class*=attachment], [class*=Attachment]").length;
  let pasted = false;
  if (box.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(box, (box.value ? box.value + "\n" : "") + text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const sel = getSelection(); sel.selectAllChildren(box); sel.collapseToEnd();
    // Rich chat boxes (Claude, ChatGPT, Gemini) are very slow at *typing* long text and can freeze the tab.
    // A paste is fast: the site handles it its own way (Claude turns long pastes into an attachment).
    if (text.length > 4000) {
      const dt2 = new DataTransfer();
      dt2.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", { clipboardData: dt2, bubbles: true, cancelable: true });
      box.dispatchEvent(ev);
      pasted = ev.defaultPrevented;
      await sleep(900);
    }
    if (!pasted) {
      if (text.length <= 30000) document.execCommand("insertText", false, text);
      else {
        // Too long to type and the site ignored the paste: attach the request as a file, with a one-line message.
        const dt3 = new DataTransfer();
        dt3.items.add(new File([text], "StudyPilot request.md", { type: "text/markdown" }));
        const input = document.querySelector("input[type=file]");
        let sent = false;
        if (input) { try { input.files = dt3.files; input.dispatchEvent(new Event("change", { bubbles: true })); sent = true; } catch { /* ignore */ } }
        await sleep(800);
        box.focus();
        if (sent) document.execCommand("insertText", false, "Please follow the instructions in the attached file “StudyPilot request.md”.");
        pasted = sent;
      }
    }
  }
  await sleep(300);
  const after = (box.value ?? box.innerText ?? "").length;
  const attachmentsAfter = document.querySelectorAll("[data-testid*=file], [data-testid*=attachment], [class*=attachment], [class*=Attachment]").length;
  if (pasted && (after > before || attachmentsAfter > attachmentsBefore)) return { filled: true, attached, reason: "" };
  return { filled: after > before + Math.min(50, text.length / 2), attached, reason: after > before ? "" : "The chat box didn't accept the text" };
}


// ---- reading the reply back (runs inside the AI's page; read-only) ----
// Looks only at code blocks, and returns the LAST one that looks like StudyPilot's reply of the expected kind,
// plus whether the AI still seems to be writing (a Stop button is showing).
// skip: StudyPilot blocks that were already in the chat before this request (continuing an earlier chat).
export function pageGrab(kind, skip = 0) {
  const looks = {
    quiz: (t) => /"type"\s*:/.test(t) && /"question"\s*:/.test(t),
    checklist: (t) => /"sections"\s*:/.test(t) && /"(items|terms)"\s*:/.test(t),
    plan: (t) => /"sessions"\s*:/.test(t),
    weights: (t) => /"weights"\s*:/.test(t),
    schedule: (t) => /"courses"\s*:/.test(t) && /"meetings"\s*:/.test(t),
    sizes: (t) => /"assignments"\s*:/.test(t) && /"hours"\s*:/.test(t),
    priorities: (t) => /"tasks"\s*:/.test(t) && /"minutes"\s*:/.test(t),
  }[kind] || (() => false);
  const any = /"(sections|type|sessions|weights|meetings|hours|minutes)"\s*:/;
  const pres = [...document.querySelectorAll("pre")].map((el) => (el.querySelector("code") || el).textContent || "").filter((t) => any.test(t));
  const blocks = pres.slice(skip).filter(looks);
  const loose = pres.length ? [] : [...document.querySelectorAll("code")].map((el) => el.textContent || "").filter((t) => t.length > 80 && looks(t));
  const text = (blocks.length ? blocks : loose).pop() || "";
  const stop = document.querySelector('button[aria-label*="Stop" i], button[data-testid="stop-button"], button[aria-label*="stop generating" i], button[aria-label*="Stop response" i]');
  const visible = (el) => !!el && el.offsetParent !== null;
  // Notices the AI sites show under a reply that was stopped or failed (read just after our block).
  const page = document.body?.innerText || "";
  const key = text.trim().slice(-40);
  const i = key ? page.lastIndexOf(key) : -1;
  const after = i >= 0 ? page.slice(i + key.length, i + key.length + 600) : page.slice(-600);
  const stopped = /(stopped (this|the) response|response (was )?(interrupted|stopped|cut off)|you stopped|was interrupted|network error|something went wrong|an error occurred|error (while )?generating|connection (lost|error)|message (could not|couldn.t) be (completed|generated)|reached (the )?(maximum|max) (length|output))/i.test(after);
  return { text, writing: visible(stop), stopped };
}
