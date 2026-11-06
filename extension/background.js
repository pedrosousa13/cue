// Keeps the list of tabs with media, fed by relay.js. Nothing here polls: state
// arrives only when a page's playback actually changes.
//
// The list lives in chrome.storage.session so it survives the service worker
// being stopped, and so the panel can read it and subscribe to changes without
// a message round trip.

importScripts("settings.js");

// tabId -> { tabId, windowId, title, favIconUrl, muted, dismissed, lastActive, frames: { frameId: state } }
const tabs = new Map();
let settings = { ...CUE_DEFAULTS };

let settingsChanged = false;
const removedTabs = new Set(); // late messages must not bring a closed tab back

// A failed read must not leave every handler waiting forever: fall back to
// empty state and default settings.
const loaded = Promise.all([
  chrome.storage.session
    .get("tabs")
    .then(({ tabs: saved }) => {
      for (const entry of Object.values(saved || {})) tabs.set(entry.tabId, entry);
    })
    .catch(() => {}),
  cueSettings()
    .then((s) => {
      if (!settingsChanged) settings = s; // a change that arrived first is newer
    })
    .catch(() => {}),
]);

chrome.storage.sync.onChanged.addListener((changes) => {
  if (!changes.settings) return;
  settingsChanged = true;
  settings = { ...CUE_DEFAULTS, ...changes.settings.newValue };
  updateBadge();
});

let savePending = false;
function save() {
  if (savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    chrome.storage.session
      .set({ tabs: Object.fromEntries(tabs) })
      .catch((e) => console.warn("Cue: could not save media state", e));
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
  const artwork = str(s.artwork, 20000); // page.js sends data: images under 20 KB only
  return {
    playing: bool(s.playing),
    // Older page scripts do not send it; then playing is the best guess.
    advancing: typeof s.advancing === "boolean" ? s.advancing : bool(s.playing),
    behind: Math.max(0, num(s.behind)),
    canGoLive: bool(s.canGoLive),
    ad: bool(s.ad),
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
    chapters: Array.isArray(s.chapters)
      ? s.chapters
          .filter((c) => c && typeof c === "object")
          .slice(0, 100)
          .map((c) => ({ title: str(c.title, 120), start: Math.max(0, num(c.start)) }))
      : [],
    inCall: bool(s.inCall),
    mic: typeof s.mic === "boolean" ? s.mic : null,
    camera: typeof s.camera === "boolean" ? s.camera : null,
    // page.js scores 0..31. Clamping keeps a frame from claiming more.
    score: Math.min(31, Math.max(0, num(s.score))),
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
  if (!msg) return;
  if (msg.type === "state" && sender.tab && sender.tab.id >= 0) {
    handleState(sender, msg.state);
  } else if (msg.type === "dismiss" && isOwnPage(sender) && Number.isInteger(msg.tabId)) {
    dismiss(msg.tabId);
  } else if (msg.type === "unreachable" && isOwnPage(sender) && Number.isInteger(msg.tabId)) {
    dropFrame(msg.tabId, Number(msg.frameId) || 0); // the panel could not reach it
  }
});

// Only Cue's own pages (popup, side panel, a Vivaldi web panel) may dismiss.
// Content scripts share the extension id, so check the sending page's URL.
const isOwnPage = (sender) => (sender.url || "").startsWith(chrome.runtime.getURL(""));

// The host name comes from the browser, not from the page, so a page cannot
// label its card as another site.
function senderHost(sender) {
  for (const url of [sender.url, sender.origin]) {
    try {
      const host = new URL(url).hostname;
      if (host) return host;
    } catch {}
  }
  return "";
}

async function handleState(sender, raw) {
  await loaded;
  const tab = sender.tab;
  const frameId = sender.frameId ?? 0;
  if (removedTabs.has(tab.id)) return;
  const state = sanitize(raw);
  if (state) {
    state.host = senderHost(sender);
    // Plain-http artwork only from the page's own host: otherwise a page could
    // make Cue fetch any http address on its behalf.
    if (state.artwork.startsWith("http:")) {
      try {
        if (new URL(state.artwork).hostname !== state.host) state.artwork = "";
      } catch {
        state.artwork = "";
      }
    }
  }
  let entry = tabs.get(tab.id);
  if (!state) {
    if (!entry) return;
    delete entry.frames[frameId];
    if (!Object.keys(entry.frames).length) tabs.delete(tab.id);
    return save();
  }
  if (!entry) {
    entry = { tabId: tab.id, lastActive: 0, dismissed: false, frames: {} };
    tabs.set(tab.id, entry);
  }
  const prev = entry.frames[frameId];
  Object.assign(entry, tabInfo(tab));
  entry.frames[frameId] = state;

  if (!prev || prev.host !== state.host) restoreVolume(tab.id, frameId, state);
  if (state.playing) {
    entry.lastActive = Date.now();
    if (!prev || !prev.playing) {
      entry.dismissed = false; // hiding a card means "not now", not "never"
      // At most once every 2 s per tab, so a page that toggles playback in a
      // loop cannot keep pausing everything else.
      const now = Date.now();
      if (settings.autoPause && !entry.muted && !state.muted && state.volume > 0 && now - (entry.autoPausedAt || 0) > 2000) {
        entry.autoPausedAt = now;
        pauseOthers(tab.id);
      }
    }
  }
  save();
}

// Only audible playback triggers this (see handleState), so a muted hover
// preview does not stop your music. Once triggered, everything else that is
// playing pauses, muted or not.
function pauseOthers(tabId) {
  for (const entry of tabs.values()) {
    if (entry.tabId === tabId) continue;
    for (const [frameId, state] of Object.entries(entry.frames)) {
      if (state.playing) sendCommand(entry.tabId, Number(frameId), "pause");
    }
  }
}

async function dismiss(tabId) {
  await loaded;
  const entry = tabs.get(tabId);
  if (!entry) return;
  entry.dismissed = true;
  save();
}

async function restoreVolume(tabId, frameId, state) {
  // A muted element stays muted: setting a volume would also unmute it.
  if (!settings.rememberVolume || !state.host || state.muted) return;
  const { volumes = {} } = await chrome.storage.local.get("volumes");
  const saved = volumes[state.host];
  if (typeof saved === "number" && Math.abs(saved - state.volume) > 0.01) {
    sendCommand(tabId, frameId, "volume", saved);
  }
}

// The browser hears sound from a tab Cue has no player for: ask its frames to
// look deeper (inside shadow roots). Event-driven, so no polling. Top-level so
// tests can call it; headless Chromium never marks a tab audible.
function onAudibleUnknown(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "command", action: "scan" }).catch(() => {});
}

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  await loaded;
  const entry = tabs.get(tabId);
  if (!entry && change.audible === true) return onAudibleUnknown(tabId);
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
  removedTabs.add(tabId);
  await loaded;
  if (tabs.delete(tabId)) save();
};

// A frame that no longer answers (its renderer crashed, or it went away
// without a pagehide) is removed when a command to it fails.
async function dropFrame(tabId, frameId) {
  await loaded;
  const entry = tabs.get(tabId);
  if (!entry || !(frameId in entry.frames)) return;
  delete entry.frames[frameId];
  if (!Object.keys(entry.frames).length) tabs.delete(tabId);
  save();
}
chrome.tabs.onRemoved.addListener(forget);
chrome.tabs.onReplaced.addListener((_added, removed) => forget(removed));

// --- Badge ------------------------------------------------------------------
function updateBadge() {
  let count = 0;
  for (const entry of tabs.values()) {
    if (entry.dismissed) continue;
    if (settings.badge === "listed" || Object.values(entry.frames).some((s) => s.playing)) count++;
  }
  const text = settings.badge !== "off" && count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text });
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
    if (entry.dismissed) continue; // hidden cards are not shortcut targets
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
  chrome.tabs
    .sendMessage(tabId, { type: "command", action, value }, { frameId })
    .catch(() => dropFrame(tabId, frameId));

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
