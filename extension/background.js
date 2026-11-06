// Keeps the list of tabs with media, fed by relay.js. Nothing here polls: state
// arrives only when a page's playback actually changes.
//
// The list lives in chrome.storage.session so it survives the service worker
// being stopped, and so the panel can read it and subscribe to changes without
// a message round trip.

const tabs = new Map(); // tabId -> { tabId, windowId, title, favIconUrl, muted, lastActive, frames: { frameId: state } }

const loaded = chrome.storage.session.get("tabs").then(({ tabs: saved }) => {
  for (const entry of Object.values(saved || {})) tabs.set(entry.tabId, entry);
});

let savePending = false;
function save() {
  if (savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    chrome.storage.session.set({ tabs: Object.fromEntries(tabs) }).catch(() => {});
    updateBadge();
  }, 0);
}

// --- Input validation ---------------------------------------------------------
// State comes from page.js, which runs in the page's world, so a page can send
// anything. Keep only known fields with the expected types.
const str = (v, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const bool = (v) => v === true;

function sanitize(s) {
  if (!s || typeof s !== "object") return null;
  const artwork = str(s.artwork, 200000);
  return {
    playing: bool(s.playing),
    position: Math.max(0, num(s.position)),
    duration: Math.max(0, num(s.duration)),
    live: bool(s.live),
    rate: num(s.rate) > 0 ? num(s.rate) : 1,
    title: str(s.title),
    artist: str(s.artist),
    album: str(s.album),
    artwork: /^(https?:|data:image\/)/.test(artwork) ? artwork : "",
    actions: Array.isArray(s.actions) ? s.actions.filter((a) => typeof a === "string").slice(0, 20) : [],
    video: bool(s.video),
    pip: bool(s.pip),
    volume: Math.min(1, Math.max(0, num(s.volume))),
    muted: bool(s.muted),
    score: num(s.score),
    host: str(s.host, 255),
    at: num(s.at) || Date.now(),
  };
}

const tabInfo = (tab) => ({
  windowId: tab.windowId,
  title: str(tab.title),
  favIconUrl: /^(https?:|data:image\/)/.test(tab.favIconUrl || "") ? str(tab.favIconUrl, 20000) : "",
  muted: !!(tab.mutedInfo && tab.mutedInfo.muted),
});

// --- Tab bookkeeping ------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "state" || !sender.tab || sender.tab.id < 0) return;
  handleState(sender.tab, sender.frameId ?? 0, msg.state);
});

async function handleState(tab, frameId, raw) {
  await loaded;
  const state = sanitize(raw);
  let entry = tabs.get(tab.id);
  if (!state) {
    if (!entry) return;
    delete entry.frames[frameId];
    if (!Object.keys(entry.frames).length) tabs.delete(tab.id);
    return save();
  }
  if (!entry) {
    entry = { tabId: tab.id, lastActive: 0, frames: {} };
    tabs.set(tab.id, entry);
  }
  Object.assign(entry, tabInfo(tab));
  entry.frames[frameId] = state;
  if (state.playing) entry.lastActive = Date.now();
  save();
}

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  await loaded;
  const entry = tabs.get(tabId);
  if (!entry) return;
  if (change.discarded) {
    tabs.delete(tabId);
  } else if ("mutedInfo" in change || "title" in change || "favIconUrl" in change) {
    Object.assign(entry, tabInfo(tab));
  } else {
    return;
  }
  save();
});

const forget = async (tabId) => {
  await loaded;
  if (tabs.delete(tabId)) save();
};
chrome.tabs.onRemoved.addListener(forget);
chrome.tabs.onReplaced.addListener((_added, removed) => forget(removed));

// --- Badge ------------------------------------------------------------------
function updateBadge() {
  let playing = 0;
  for (const entry of tabs.values()) {
    if (Object.values(entry.frames).some((s) => s.playing)) playing++;
  }
  chrome.action.setBadgeText({ text: playing > 1 ? String(playing) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#3d5afe" });
}

// --- Keyboard shortcuts -------------------------------------------------------
// The target is the tab that is playing, or else the one that played last.
function bestFrame(entry) {
  let best = null;
  for (const [frameId, state] of Object.entries(entry.frames)) {
    if (!best || state.score > best.state.score) best = { frameId: Number(frameId), state };
  }
  return best;
}

function currentTarget() {
  let target = null;
  for (const entry of tabs.values()) {
    const frame = bestFrame(entry);
    if (!frame) continue;
    const rank = [frame.state.playing ? 1 : 0, entry.lastActive];
    if (!target || rank[0] > target.rank[0] || (rank[0] === target.rank[0] && rank[1] > target.rank[1])) {
      target = { entry, frame, rank };
    }
  }
  return target;
}

const sendCommand = (tabId, frameId, action, value) =>
  chrome.tabs.sendMessage(tabId, { type: "command", action, value }, { frameId }).catch(() => {});

// Top-level function so tests can call it from the service worker console.
async function runCommand(command) {
  await loaded;
  const target = currentTarget();
  if (!target) return;
  const { entry, frame } = target;
  const has = (action) => frame.state.actions.includes(action);
  switch (command) {
    case "toggle-playback":
      return sendCommand(entry.tabId, frame.frameId, "toggle");
    case "next-track":
      return sendCommand(entry.tabId, frame.frameId, has("nexttrack") ? "nexttrack" : "seekforward");
    case "previous-track":
      return sendCommand(entry.tabId, frame.frameId, has("previoustrack") ? "previoustrack" : "seekbackward");
    case "toggle-mute":
      return chrome.tabs.update(entry.tabId, { muted: !entry.muted });
  }
}

chrome.commands.onCommand.addListener(runCommand);

// --- Install ------------------------------------------------------------------
// Content scripts only reach pages loaded after install. Inject into tabs that
// are already open so they show up without a reload.
chrome.runtime.onInstalled.addListener(async () => {
  const open = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of open) {
    const target = { tabId: tab.id, allFrames: true };
    chrome.scripting
      .executeScript({ target, world: "MAIN", files: ["page.js"], injectImmediately: true })
      .then(() => chrome.scripting.executeScript({ target, files: ["relay.js"] }))
      .catch(() => {}); // discarded tabs and the Web Store reject injection
  }
});

// Toolbar click opens the popup. Browsers with a side panel can also open the
// same page there from their side panel menu.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
