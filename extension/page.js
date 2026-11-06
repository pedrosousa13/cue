// Runs in the page's own JavaScript world (MAIN), in every frame, from
// document_start. It has to stay cheap because it runs on every site: it wraps
// a few MediaSession methods, listens to media events, and never polls.
//
// It talks to relay.js (the isolated world) through two window events that
// carry JSON strings. Strings cross the world boundary intact; objects do not.
(() => {
  const INSTALLED = Symbol.for("cue.installed");
  if (window[INSTALLED]) return; // injected twice after an extension update
  Object.defineProperty(window, INSTALLED, { value: true });

  const STATE_EVENT = "cue:state";
  const COMMAND_EVENT = "cue:command";
  const MEDIA_EVENTS = [
    "play", "pause", "playing", "ended", "seeked", "ratechange",
    "durationchange", "loadedmetadata", "volumechange", "emptied",
    "enterpictureinpicture", "leavepictureinpicture",
  ];
  // Fields that make a state worth sending. Position is checked separately.
  const STABLE = [
    "playing", "duration", "live", "rate", "title", "artist", "album",
    "artwork", "actions", "video", "pip", "volume", "muted",
  ];

  const elements = new Set();
  const handlers = new Map();
  let positionState = null;
  let timer = 0;
  let last = null;

  // --- MediaSession hooks ---------------------------------------------------
  // Chrome's own media hub calls the page's action handlers directly. Wrapping
  // setActionHandler gives this extension the same handlers, so next/previous
  // work on any site that supports media keys, with no per-site selectors.
  const proto = window.MediaSession && MediaSession.prototype;
  if (proto) {
    const setActionHandler = proto.setActionHandler;
    proto.setActionHandler = function (action, handler) {
      const result = setActionHandler.call(this, action, handler); // throws first on bad input
      if (typeof handler === "function") handlers.set(action, handler);
      else handlers.delete(action);
      schedule();
      return result;
    };

    // When a site publishes its own clock, it wins over the media element. Some
    // players (YouTube's autoplay queue, for one) stream several tracks through
    // one element, so the element's time covers the whole queue, not the track.
    const setPositionState = proto.setPositionState;
    if (setPositionState) {
      proto.setPositionState = function (state) {
        const result = setPositionState.call(this, state);
        positionState =
          state && Number.isFinite(state.duration) && state.duration > 0
            ? {
                duration: state.duration,
                position: state.position ?? 0,
                rate: state.playbackRate ?? 1,
                at: Date.now(),
              }
            : null;
        schedule();
        return result;
      };
    }

    for (const prop of ["metadata", "playbackState"]) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.set) continue;
      Object.defineProperty(proto, prop, {
        ...desc,
        set(value) {
          desc.set.call(this, value);
          schedule();
        },
      });
    }
  }

  // --- Media element discovery ----------------------------------------------
  // Listeners go on the element itself, so elements inside shadow roots and
  // elements never attached to the document (new Audio()) still report.
  const watch = (el) => {
    if (elements.has(el)) return;
    elements.add(el);
    for (const type of MEDIA_EVENTS) el.addEventListener(type, schedule);
  };

  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    watch(this);
    return play.apply(this, arguments);
  };

  for (const type of ["play", "loadedmetadata"]) {
    window.addEventListener(
      type,
      (e) => {
        if (e.target instanceof HTMLMediaElement) {
          watch(e.target);
          schedule();
        }
      },
      true
    );
  }

  const scan = () => {
    document.querySelectorAll("video, audio").forEach(watch);
    schedule();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan, { once: true });
  } else {
    scan();
  }

  // --- Picking the element the user is listening to --------------------------
  const score = (el) =>
    (!el.paused && !el.ended ? 8 : 0) +
    (!el.muted && el.volume > 0 ? 4 : 0) +
    (el.duration > 0 ? 2 : 0) +
    Math.min(1, (el.clientWidth * el.clientHeight) / (640 * 360));

  const primary = () => {
    let best = null;
    let bestScore = -1;
    for (const el of elements) {
      if (!el.isConnected && (el.ended || !el.currentSrc)) {
        elements.delete(el); // detached and finished: let it be collected
        continue;
      }
      if (el.paused && el.readyState === 0) continue; // nothing loaded yet
      const s = score(el);
      if (s > bestScore) {
        best = el;
        bestScore = s;
      }
    }
    return best ? { el: best, score: bestScore } : null;
  };

  // --- Snapshot -------------------------------------------------------------
  const text = (value) => (typeof value === "string" ? value.trim().slice(0, 300) : "");

  const artworkUrl = (artwork) => {
    const items = Array.from(artwork || [], (a) => ({
      src: a.src,
      size: Math.max(0, ...String(a.sizes || "").split(/\s+/).map((s) => parseInt(s, 10) || 0)),
    })).sort((a, b) => a.size - b.size);
    // The panel shows art at 48px; 128px covers 2x screens without fetching a
    // poster-sized image.
    const pick = items.find((i) => i.size >= 128) || items[items.length - 1];
    if (!pick) return "";
    try {
      const url = new URL(pick.src, location.href);
      if (url.protocol === "https:" || url.protocol === "http:") return url.href;
      if (url.protocol === "data:" && url.href.length < 200000) return url.href;
    } catch {}
    return "";
  };

  const snapshot = () => {
    const found = primary();
    if (!found) return null;
    const { el } = found;
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const playing = !el.paused && !el.ended;
    const now = Date.now();

    let position = el.currentTime;
    let duration = el.duration;
    let rate = el.playbackRate;
    if (positionState) {
      const ps = positionState;
      position = Math.min(ps.duration, ps.position + (playing ? ((now - ps.at) / 1000) * ps.rate : 0));
      duration = ps.duration;
      rate = ps.rate;
    }

    return {
      playing,
      position: Number.isFinite(position) ? position : 0,
      duration: Number.isFinite(duration) ? duration : 0,
      live: duration === Infinity,
      rate,
      title: text(md && md.title) || text(document.title) || location.hostname,
      artist: text(md && md.artist),
      album: text(md && md.album),
      artwork: md ? artworkUrl(md.artwork) : "",
      actions: [...handlers.keys()],
      video: el instanceof HTMLVideoElement && el.videoWidth > 0,
      pip: !!document.pictureInPictureElement,
      volume: el.volume,
      muted: el.muted,
      score: found.score,
      host: location.hostname,
      at: now,
    };
  };

  const expected = (s, at) => (s.playing ? s.position + ((at - s.at) / 1000) * s.rate : s.position);

  const unchanged = (a, b) =>
    STABLE.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k])) &&
    Math.abs(a.position - expected(b, a.at)) < 1.5;

  function emit(force) {
    timer = 0;
    const state = snapshot();
    if (!force && (state ? last && unchanged(state, last) : !last)) return;
    last = state;
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: JSON.stringify(state) }));
  }

  // Coalesces bursts: a track change fires metadata, durationchange, seeked and
  // play within a few milliseconds, and that should be one message.
  function schedule() {
    if (!timer) timer = setTimeout(emit, 50);
  }

  // --- Commands -------------------------------------------------------------
  const callHandler = (action, details) => {
    const handler = handlers.get(action);
    if (!handler) return false;
    try {
      handler({ action, ...details });
    } catch {}
    return true;
  };

  const resume = (el) => callHandler("play") || (el && el.play().catch(() => {}));
  const pause = (el) => callHandler("pause") || (el && el.pause());

  const seekElement = (el, time) => {
    if (!el) return;
    // With a site clock, element time can be offset from track time. Keep the
    // offset so seeking lands in the current track, not an earlier one.
    const offset = positionState ? el.currentTime - snapshot().position : 0;
    const target = Math.max(0, time + offset);
    el.currentTime = el.duration > 0 ? Math.min(el.duration, target) : target;
  };

  const togglePip = async (el) => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return true;
      }
      let video = el instanceof HTMLVideoElement ? el : null;
      if (!video) {
        for (const e of elements) if (e instanceof HTMLVideoElement && e.videoWidth > 0) video = e;
      }
      if (!video) return false;
      video.disablePictureInPicture = false;
      await video.requestPictureInPicture();
      return true;
    } catch {
      return false;
    }
  };

  // Picture-in-picture needs a user gesture. The panel calls this through
  // chrome.scripting, which carries the click's gesture into the page; a plain
  // message would not.
  Object.defineProperty(window, Symbol.for("cue.pip"), {
    value: () => togglePip(primary()?.el),
  });

  window.addEventListener(COMMAND_EVENT, (e) => {
    let cmd;
    try {
      cmd = JSON.parse(e.detail);
    } catch {
      return;
    }
    const { action, value } = cmd || {};
    if (action === "report") return emit(true);

    const el = primary()?.el;
    switch (action) {
      case "play":
        resume(el);
        break;
      case "pause":
        pause(el);
        break;
      case "toggle":
        if (el && !el.paused) pause(el);
        else resume(el);
        break;
      case "previoustrack":
      case "nexttrack":
        callHandler(action);
        break;
      case "seekbackward":
      case "seekforward": {
        const offset = action === "seekforward" ? 10 : -10;
        if (!callHandler(action, { seekOffset: 10 }) && el) {
          seekElement(el, (positionState ? snapshot().position : el.currentTime) + offset);
        }
        break;
      }
      case "seekto":
        if (!Number.isFinite(value)) break;
        if (!callHandler("seekto", { seekTime: value, fastSeek: false })) seekElement(el, value);
        break;
      case "volume":
        if (el && Number.isFinite(value)) {
          el.volume = Math.min(1, Math.max(0, value));
          if (value > 0) el.muted = false;
        }
        break;
      case "rate":
        if (el && Number.isFinite(value) && value > 0) el.playbackRate = value;
        break;
      case "pip":
        togglePip(el);
        break;
    }
    schedule();
  });
})();
