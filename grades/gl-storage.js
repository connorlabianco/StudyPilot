// StudyPilot storage adapter for Grade Ledger: saved results live in chrome.storage.local ("gl").
window.GradeLedgerStorage = {
  label: "Saved in StudyPilot",
  async list() {
    const { gl = [] } = await chrome.storage.local.get("gl");
    return gl.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  },
  async add(rec) {
    const { gl = [] } = await chrome.storage.local.get("gl");
    const id = crypto.randomUUID();
    gl.push({ id, ...rec });
    await chrome.storage.local.set({ gl });
    return id;
  },
  async remove(id) {
    const { gl = [] } = await chrome.storage.local.get("gl");
    await chrome.storage.local.set({ gl: gl.filter((r) => r.id !== id) });
  },
};
