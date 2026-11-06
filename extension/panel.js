// One page, two hosts: the toolbar popup and the side panel (or a Vivaldi web
// panel pointed at chrome-extension://<id>/panel.html).
//
// State comes from chrome.storage.session, written by background.js only when
// playback changes. Between updates the panel moves the clock forward itself,
// so it never has to ask a page for the time.

// --- Icons ------------------------------------------------------------------
const ICONS = {
  play: ["M8 5.5v13l10.5-6.5z"],
  pause: ["M7 5h3.5v14H7z", "M13.5 5H17v14h-3.5z"],
  prev: ["M6 6h2v12H6z", "M19 6v12l-9-6z"],
  next: ["M16 6h2v12h-2z", "M5 6l9 6-9 6z"],
  back10: ["M11.5 7l-6 5 6 5z", "M19 7l-6 5 6 5z"],
  fwd10: ["M12.5 7l6 5-6 5z", "M5 7l6 5-6 5z"],
  pip: [{ stroke: "M3.5 5.5h17v13h-17z" }, "M12 11.5h7v5.5h-7z"],
  volume: ["M4 9.5h3.5L12 6v12l-4.5-3.5H4z", { stroke: "M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" }],
  muted: ["M4 9.5h3.5L12 6v12l-4.5-3.5H4z", { stroke: "M16 9.5l5 5M21 9.5l-5 5" }],
};

const SVG = "http://www.w3.org/2000/svg";
function icon(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  for (const part of ICONS[name]) {
    const path = document.createElementNS(SVG, "path");
    if (typeof part === "string") {
      path.setAttribute("d", part);
      path.setAttribute("fill", "currentColor");
    } else {
      path.setAttribute("d", part.stroke);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.8");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    }
    svg.append(path);
  }
  return svg;
}

// --- Helpers ----------------------------------------------------------------
const RATES = [1, 1.25, 1.5, 2, 0.75];
const SAFE_IMAGE = /^(https?:|data:image\/)/;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const iconButton = (name, label, className = "icon-btn") => {
  const button = el("button", { type: "button", className, title: label });
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  return button;
};

const setIcon = (button, name, label) => {
  if (button.dataset.icon === name && button.title === label) return;
  button.dataset.icon = name;
  button.replaceChildren(icon(name));
  button.title = label;
  button.setAttribute("aria-label", label);
};

const clock = (seconds, total = seconds) => {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return total >= 3600 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

const spoken = (seconds) => {
  const t = Math.max(0, Math.floor(seconds));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m} minute${m === 1 ? "" : "s"} ${s} second${s === 1 ? "" : "s"}`;
};

const positionOf = ({ state }) => {
  const p = state.playing ? state.position + ((Date.now() - state.at) / 1000) * state.rate : state.position;
  return state.duration > 0 ? Math.min(state.duration, Math.max(0, p)) : Math.max(0, p);
};

// --- Talking to tabs ----------------------------------------------------------
const command = (item, action, value) =>
  chrome.tabs.sendMessage(item.tabId, { type: "command", action, value }, { frameId: item.frameId }).catch(() => {});

// Goes through chrome.scripting rather than a message: the injected call keeps
// this click's user gesture, which picture-in-picture requires.
const togglePip = (item) =>
  chrome.scripting
    .executeScript({
      target: { tabId: item.tabId, frameIds: [item.frameId] },
      world: "MAIN",
      func: () => window[Symbol.for("cue.pip")]?.() ?? false,
    })
    .catch(() => {});

const focusTab = async (item) => {
  await chrome.tabs.update(item.tabId, { active: true }).catch(() => {});
  await chrome.windows.update(item.windowId, { focused: true }).catch(() => {});
};

// --- Cards ------------------------------------------------------------------
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const pauseAllEl = document.getElementById("pause-all");
const cards = new Map();
let items = [];

function createCard() {
  const card = { item: null, dragging: false };

  const artImg = el("img", { alt: "" });
  const art = el("button", { type: "button", className: "art", title: "Go to tab" }, artImg);
  const title = el("button", { type: "button", className: "title" });
  const artist = el("div", { className: "artist" });
  const sourceIcon = el("img", { alt: "" });
  const sourceText = el("span");
  const source = el("div", { className: "source" }, sourceIcon, sourceText);
  const info = el("div", { className: "info" }, title, artist, source);

  const pip = iconButton("pip", "Picture in picture");
  const corner = el("div", { className: "corner" }, pip);
  const top = el("div", { className: "top" }, art, info, corner);

  const current = el("span", { className: "current" });
  const seek = el("input", { type: "range", min: "0", step: "any", value: "0" });
  seek.setAttribute("aria-label", "Seek");
  const total = el("span", { className: "total" });
  const progress = el("div", { className: "progress" }, current, seek, total);

  const rate = el("button", { type: "button", className: "rate", title: "Playback speed" });
  const prev = iconButton("prev", "Previous track");
  const play = el("button", { type: "button", className: "play" });
  const next = iconButton("next", "Next track");
  const transport = el("div", { className: "transport" }, prev, play, next);
  const mute = iconButton("volume", "Mute tab");
  const volume = el("input", { type: "range", min: "0", max: "1", step: "0.01" });
  volume.setAttribute("aria-label", "Volume");
  const volumeBox = el("div", { className: "volume" }, mute, volume);
  const controls = el("div", { className: "controls" }, rate, transport, volumeBox);

  const root = el("li", { className: "card" }, top, progress, controls);
  Object.assign(card, {
    root, art, artImg, title, artist, sourceIcon, sourceText, pip,
    current, seek, total, progress, rate, prev, play, next, mute, volume,
  });

  // Handlers read card.item at click time, so they always act on fresh state.
  art.onclick = () => focusTab(card.item);
  title.onclick = () => focusTab(card.item);
  pip.onclick = () => togglePip(card.item);
  play.onclick = () => command(card.item, "toggle");
  prev.onclick = () => command(card.item, prev.dataset.action);
  next.onclick = () => command(card.item, next.dataset.action);
  rate.onclick = () => {
    const now = card.item.state.rate;
    const i = RATES.findIndex((r) => Math.abs(r - now) < 0.01);
    command(card.item, "rate", RATES[(i + 1) % RATES.length]);
  };
  mute.onclick = () => chrome.tabs.update(card.item.tabId, { muted: !card.item.muted }).catch(() => {});
  volume.oninput = () => {
    volume.style.setProperty("--p", `${volume.value * 100}%`);
    command(card.item, "volume", Number(volume.value));
  };

  // Dragging the seek bar previews the time; releasing it seeks once.
  seek.oninput = () => {
    card.dragging = true;
    const value = Number(seek.value);
    seek.style.setProperty("--p", `${(value / card.item.state.duration) * 100}%`);
    card.current.textContent = clock(value, card.item.state.duration);
  };
  seek.onchange = () => {
    card.dragging = false;
    const value = Number(seek.value);
    // Show the new position now instead of waiting for the page's reply.
    Object.assign(card.item.state, { position: value, at: Date.now() });
    command(card.item, "seekto", value);
  };
  seek.onblur = () => (card.dragging = false);

  return card;
}

function paint(card) {
  const { item } = card;
  const { state } = item;
  const has = (action) => state.actions.includes(action);

  card.title.textContent = state.title;
  card.title.title = `${state.title}\nGo to tab`;
  card.artist.textContent = [state.artist, state.album].filter(Boolean).join(" · ");
  card.artist.hidden = !card.artist.textContent;
  card.sourceText.textContent = state.host.replace(/^www\./, "");

  const favicon = SAFE_IMAGE.test(item.favIconUrl) ? item.favIconUrl : "";
  if (card.sourceIcon.getAttribute("src") !== favicon) card.sourceIcon.src = favicon;
  card.sourceIcon.hidden = !favicon;

  const art = state.artwork || favicon;
  card.art.classList.toggle("fallback", !state.artwork);
  if (art) {
    if (card.artImg.getAttribute("src") !== art) card.artImg.src = art;
    card.artImg.hidden = false;
  } else {
    card.artImg.hidden = true;
  }

  card.pip.hidden = !state.video;
  card.pip.setAttribute("aria-pressed", String(state.pip));

  setIcon(card.play, state.playing ? "pause" : "play", state.playing ? "Pause" : "Play");

  // Prefer the site's own track handlers; fall back to a 10 second skip.
  const prevTrack = has("previoustrack");
  const nextTrack = has("nexttrack");
  setIcon(card.prev, prevTrack ? "prev" : "back10", prevTrack ? "Previous track" : "Back 10 seconds");
  setIcon(card.next, nextTrack ? "next" : "fwd10", nextTrack ? "Next track" : "Forward 10 seconds");
  card.prev.dataset.action = prevTrack ? "previoustrack" : "seekbackward";
  card.next.dataset.action = nextTrack ? "nexttrack" : "seekforward";
  card.prev.disabled = state.live && !prevTrack;
  card.next.disabled = state.live && !nextTrack;

  card.rate.textContent = `${Number(state.rate.toFixed(2))}×`;
  card.rate.hidden = state.live;

  setIcon(card.mute, item.muted ? "muted" : "volume", item.muted ? "Unmute tab" : "Mute tab");
  card.mute.setAttribute("aria-pressed", String(item.muted));
  if (document.activeElement !== card.volume) {
    const v = state.muted ? 0 : state.volume;
    card.volume.value = String(v);
    card.volume.style.setProperty("--p", `${v * 100}%`);
  }

  const seekable = state.duration > 0;
  card.seek.disabled = !seekable;
  card.seek.max = String(seekable ? state.duration : 1);
  card.total.textContent = seekable ? clock(state.duration) : "";
  card.current.className = state.live ? "live" : "current";
  tick(card);
}

function tick(card) {
  const { state } = card.item;
  if (state.live) {
    card.current.textContent = "LIVE";
    card.seek.style.setProperty("--p", "100%");
    card.seek.setAttribute("aria-valuetext", "Live stream");
    return;
  }
  if (card.dragging) return;
  const position = positionOf(card.item);
  const seekable = state.duration > 0;
  card.seek.value = String(position);
  card.seek.style.setProperty("--p", seekable ? `${(position / state.duration) * 100}%` : "0%");
  card.current.textContent = clock(position, state.duration);
  card.seek.setAttribute(
    "aria-valuetext",
    seekable ? `${spoken(position)} of ${spoken(state.duration)}` : "Not seekable"
  );
}

// --- Rendering ----------------------------------------------------------------
function bestFrame(entry) {
  let best = null;
  for (const [frameId, state] of Object.entries(entry.frames || {})) {
    if (!best || state.score > best.state.score) best = { frameId: Number(frameId), state };
  }
  return best;
}

function update(tabs = {}) {
  items = Object.values(tabs)
    .map((entry) => {
      const frame = bestFrame(entry);
      return frame && { ...entry, ...frame };
    })
    .filter(Boolean)
    .sort((a, b) => b.state.playing - a.state.playing || b.lastActive - a.lastActive);
  render();
}

function render() {
  const seen = new Set();
  items.forEach((item, i) => {
    let card = cards.get(item.tabId);
    if (!card) {
      card = createCard();
      cards.set(item.tabId, card);
    }
    card.item = item;
    paint(card);
    seen.add(item.tabId);
    if (listEl.children[i] !== card.root) listEl.insertBefore(card.root, listEl.children[i] || null);
  });
  for (const [tabId, card] of cards) {
    if (!seen.has(tabId)) {
      card.root.remove();
      cards.delete(tabId);
    }
  }
  emptyEl.hidden = items.length > 0;
  pauseAllEl.hidden = items.filter((i) => i.state.playing).length < 2;
  syncTicker();
}

// The clock only runs while something plays and the panel is visible.
let ticker = 0;
function syncTicker() {
  const needed = !document.hidden && items.some((i) => i.state.playing && !i.state.live);
  if (needed && !ticker) ticker = setInterval(() => cards.forEach(tick), 250);
  if (!needed && ticker) {
    clearInterval(ticker);
    ticker = 0;
  }
}
document.addEventListener("visibilitychange", syncTicker);

pauseAllEl.onclick = () => items.filter((i) => i.state.playing).forEach((i) => command(i, "pause"));

// --- Start --------------------------------------------------------------------
// A web panel cannot read the browser theme, so ?theme=dark|light can pin it.
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

try {
  if (chrome.extension.getViews({ type: "popup" }).includes(window)) {
    document.documentElement.classList.add("popup");
  }
} catch {}

chrome.storage.session.get("tabs").then(({ tabs }) => update(tabs));
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.tabs) update(changes.tabs.newValue);
});
