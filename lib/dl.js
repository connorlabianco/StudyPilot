// Every download StudyPilot starts goes through here, so the background's onDeterminingFilename
// listener can make Chrome keep the intended "StudyPilot/…" folder path, even if another
// extension or the server's own filename would otherwise win.
import { cleanZipPath } from "./zipwrite.js";

export const cleanPath = (p) => cleanZipPath(p);

// saveAs: Chrome asks where to save (the StudyPilot path is the suggested name).
export async function download(url, filename, { conflictAction = "overwrite", saveAs = false } = {}) {
  const path = cleanPath(filename);
  await chrome.storage.session.set({ ["dl:" + url]: path });
  return chrome.downloads.download({ url, filename: path, conflictAction, saveAs });
}

export function waitForDownload(id, ms = 10 * 60e3) {
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); chrome.downloads.onChanged.removeListener(on); resolve(v); };
    const on = (d) => { if (d.id === id && d.state && d.state.current !== "in_progress") done(d.state.current); };
    const t = setTimeout(() => done("timeout"), ms);
    chrome.downloads.onChanged.addListener(on);
    chrome.downloads.search({ id }).then(([d]) => { if (d && d.state !== "in_progress") done(d.state); });
  });
}
