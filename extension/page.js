// Runs in the page's own JavaScript world (MAIN), in every frame, from
// document_start. It has to stay cheap because it runs on every site: it wraps
// a few MediaSession methods, listens to media events, and never polls.
//
// It talks to relay.js (the isolated world) through two window events that
// carry JSON strings. Strings cross the world boundary intact; objects do not.
(() => {
  // Keep equal to manifest.json "version"; npm test checks it.
  const VERSION = "0.4.2";
  const INSTALLED = Symbol.for("cue.installed");
  if (window[INSTALLED] === VERSION) return; // already running in this frame
  // An older copy is still here after an extension update. Tell it to stop
  // answering, then take over. (0.2.x copies predate this and cannot be told.)
  if (window[INSTALLED]) window.dispatchEvent(new Event("cue:retire"));
  try {
    Object.defineProperty(window, INSTALLED, { value: VERSION, configurable: true });
  } catch {
    return; // a 0.2.x copy locked the marker; leave it in charge
  }
  let retired = false;
  window.addEventListener("cue:retire", () => (retired = true), { once: true });

  const STATE_EVENT = "cue:state";
  const COMMAND_EVENT = "cue:command";
  const MEDIA_EVENTS = [
    "play", "pause", "playing", "waiting", "ended", "seeked", "ratechange",
    "durationchange", "loadedmetadata", "volumechange", "emptied",
    "enterpictureinpicture", "leavepictureinpicture",
  ];
  // Fields that make a state worth sending. Position is checked separately.
  const STABLE = [
    "playing", "advancing", "duration", "live", "ad", "canGoLive", "rate", "title", "artist", "album",
    "artwork", "actions", "video", "pip", "volume", "muted",
    "chapters", "inCall", "mic", "camera",
  ];
  // Video-call sites (Google Meet, for one) register these instead of, or as
  // well as, playback handlers.
  const CALL_ACTIONS = ["togglemicrophone", "togglecamera", "hangup"];

  const elements = new Set();
  const handlers = new Map();
  const call = { mic: null, camera: null }; // null: the site has not said
  let positionState = null;
  let siteSaysLive = false;
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
        // duration Infinity is how a site says "live".
        siteSaysLive = !!state && state.duration === Infinity;
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

    for (const [method, key] of [["setMicrophoneActive", "mic"], ["setCameraActive", "camera"]]) {
      const original = proto[method];
      if (!original) continue;
      proto[method] = function (active) {
        const result = original.call(this, active);
        call[key] = !!active;
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
  const lastPlayed = new WeakMap(); // element -> time it last started

  const watch = (el) => {
    if (elements.has(el)) return;
    elements.add(el);
    for (const type of MEDIA_EVENTS) el.addEventListener(type, schedule);
    el.addEventListener("play", () => lastPlayed.set(el, Date.now()));
    // While playing, re-check the clock every 2 s. emit() sends only if the
    // panel's estimate has drifted (for example after a stall the browser
    // did not report), so this costs a comparison, not a message.
    let lastCheck = 0;
    el.addEventListener("timeupdate", () => {
      const now = Date.now();
      if (now - lastCheck < 2000) return;
      lastCheck = now;
      schedule();
    });
    // A new source means a new item: a clock the site published for the old
    // one no longer applies.
    el.addEventListener("emptied", () => {
      if (el === current) positionState = null;
    });
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

  // Media inside a shadow root that starts without play() never reaches the
  // listeners above. background.js asks for this deeper scan only when the
  // browser marks the tab audible and Cue knows nothing playing in it, so it
  // costs nothing on ordinary pages. Closed shadow roots stay out of reach.
  const deepScan = (root) => {
    for (const node of root.querySelectorAll("*")) {
      if (node instanceof HTMLMediaElement) watch(node);
      if (node.shadowRoot) deepScan(node.shadowRoot);
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan, { once: true });
  } else {
    scan();
  }

  // --- YouTube player ---------------------------------------------------------
  // YouTube and YouTube Music stream an autoplay queue through one media
  // element, so the element's clock covers the whole queue, not the track. The
  // page's player object (#movie_player) knows the track's clock and keeps its
  // own volume, which it would otherwise reapply over the element's. Used only
  // when the site has not published a clock with setPositionState().
  // The seekable-window approach comes from levz0r/vivaldi-media-panel (MIT).
  const youtube = (el) => {
    const mp = document.getElementById("movie_player");
    if (!mp || !el || !mp.contains(el) || typeof mp.getProgressState !== "function") return null;
    return mp;
  };

  // YouTube reports live streams through its player data; the element and
  // the progress state show durations of years (121601512 s, measured).
  const youtubeLive = (mp) => {
    try {
      const d = mp.getVideoData();
      return !!(d && (d.isLive || d.isWindowedLive));
    } catch {
      return false;
    }
  };

  // During an ad, YouTube plays the ad in the same element and marks the player.
  // Two signals, so one renamed class does not hide every ad.
  const youtubeAd = (mp) =>
    mp.classList.contains("ad-showing") ||
    mp.classList.contains("ad-interrupting") ||
    !!mp.querySelector(
      ".ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-preview-container, .ytp-ad-text"
    );

  // YouTube's own Skip button, when it is on screen. Cue only presses it when
  // the user clicks Skip ad, the same as clicking it on the page.
  // Known class names first, then any button in YouTube's ad area whose class
  // mentions "skip". Not the button text: it changes with the language.
  const youtubeSkipButton = () => {
    const visible = (b) => b && b.offsetParent !== null;
    const known = document.querySelector(".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern");
    if (visible(known)) return known;
    for (const b of document.querySelectorAll('.video-ads button, .ytp-ad-module button, #movie_player [class*="ad"] button')) {
      if (/skip/i.test(b.className) && visible(b)) return b;
    }
    return null;
  };

  const youtubeClock = (mp, el) => {
    if (el.duration === Infinity || youtubeLive(mp) || youtubeAd(mp)) return null; // live or ad: not the track
    try {
      const p = mp.getProgressState();
      // Not p.duration: it reports how much has buffered and grows while the
      // track loads. The seekable window is the track.
      const length = p.seekableEnd - p.seekableStart;
      if (Number.isFinite(length) && length > 0 && Number.isFinite(p.current)) {
        // p.current is already track time (measured in the source above).
        return { position: Math.min(length, Math.max(0, p.current)), duration: length };
      }
    } catch {}
    return null;
  };

  const youtubeVolume = (mp) => {
    try {
      const v = mp.getVolume();
      if (Number.isFinite(v)) return { volume: v / 100, muted: !!mp.isMuted() };
    } catch {}
    return null;
  };

  // How far behind the live edge playback is, if the stream can be seeked.
  const liveEdge = (el, mp) => {
    if (mp) {
      try {
        const p = mp.getProgressState();
        if (p.isAtLiveHead === true) return { behind: 0 };
        const behind = p.seekableEnd - p.current;
        if (Number.isFinite(behind) && behind >= 0 && behind < 86400) return { behind };
      } catch {}
    }
    if (el.seekable && el.seekable.length) {
      const behind = el.seekable.end(el.seekable.length - 1) - el.currentTime;
      if (Number.isFinite(behind) && behind >= 0) return { behind };
    }
    return null;
  };

  const goLive = (el) => {
    const mp = youtube(el);
    if (mp) {
      try {
        if (typeof mp.seekToLiveHead === "function") return mp.seekToLiveHead();
        const p = mp.getProgressState();
        if (Number.isFinite(p.seekableEnd)) return mp.seekTo(p.seekableEnd, true);
      } catch {}
    }
    if (el && el.seekable && el.seekable.length) el.currentTime = el.seekable.end(el.seekable.length - 1);
  };

  // --- What is playing, when the site does not say ---------------------------
  // Sites without Media Session metadata (Reddit, news sites, blogs) leave Cue
  // with the tab title, which is often just the site name. Look around the
  // element instead: Reddit's post element, else the enclosing article.
  const up = (node) => node.parentNode || (node instanceof ShadowRoot ? node.host : null);

  const contextInfo = (el) => {
    // artist: from the post or page around the element. site: the site's name.
    const info = { title: "", artist: "", site: "", artwork: "" };
    if (el instanceof HTMLVideoElement && el.poster) info.artwork = el.poster;
    for (let node = el, depth = 0; node && depth < 40; node = up(node), depth++) {
      if (node.nodeType !== 1) continue;
      // Reddit: <shreddit-post post-title="…" subreddit-prefixed-name="r/…">
      const postTitle = node.getAttribute("post-title");
      if (postTitle) {
        info.title = postTitle;
        const sub = node.getAttribute("subreddit-name");
        info.artist =
          node.getAttribute("subreddit-prefixed-name") || (sub ? `r/${sub}` : "") || node.getAttribute("author") || "";
        break;
      }
      if (node.tagName === "ARTICLE" || node.getAttribute("role") === "article") {
        const heading = node.querySelector("h1, h2, h3");
        info.title = (heading && heading.textContent) || node.getAttribute("aria-label") || "";
        break;
      }
    }
    if (!info.title) info.title = el.getAttribute("aria-label") || el.title || "";
    if (!info.title) {
      const og = document.querySelector('meta[property="og:title"]');
      info.title = (og && og.content) || "";
    }
    const site = document.querySelector('meta[property="og:site_name"]');
    info.site = (site && site.content) || "";
    return info;
  };

  // "Reddit" as the artist on reddit.com says nothing the card does not
  // already show. Treat an artist that only names the site as missing.
  const namesSite = (artist, site) => {
    const a = artist.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!a) return true;
    if (site && a === site.toLowerCase().replace(/[^a-z0-9]/g, "")) return true;
    return location.hostname.replace(/[^a-z0-9]/gi, "").toLowerCase().includes(a);
  };

  // --- Picking the element the user is listening to --------------------------
  const score = (el) =>
    (!el.paused && !el.ended ? 8 : 0) +
    (!el.muted && el.volume > 0 ? 4 : 0) +
    (el.duration > 0 ? 2 : 0) +
    Math.min(1, (el.clientWidth * el.clientHeight) / (640 * 360));

  let current = null; // the element the last snapshot reported

  const primary = () => {
    let best = null;
    let bestScore = -1;
    // Detached, paused elements (new Audio() that was paused) are kept so a
    // paused player can be resumed, but only the most recent one: sites that
    // create an element per sound would otherwise fill this set.
    let keepDetached = null;
    for (const el of elements) {
      if (el.isConnected || !el.paused) continue;
      if (!keepDetached || (lastPlayed.get(el) || 0) > (lastPlayed.get(keepDetached) || 0)) keepDetached = el;
    }
    for (const el of elements) {
      const detachedPaused = !el.isConnected && el.paused;
      if (detachedPaused && (el !== keepDetached || el.ended || !el.currentSrc)) {
        elements.delete(el); // let it be collected
        continue;
      }
      if (el.paused && el.readyState === 0) continue; // nothing loaded yet
      // A detached paused element never outranks media that is in the page.
      const s = score(el) - (detachedPaused ? 6 : 0);
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
      // Small inline images only: every state is stored in session storage.
      if (url.protocol === "data:" && url.href.length < 20000) return url.href;
    } catch {}
    return "";
  };

  const chapterList = (md) =>
    md && md.chapterInfo
      ? Array.from(md.chapterInfo, (c) => ({ title: text(c.title), start: Number(c.startTime) || 0 })).slice(0, 100)
      : [];

  const snapshot = () => {
    const found = primary();
    // A call page may have no media element the panel can use, but its
    // mic, camera and hang-up handlers are still worth showing.
    const inCall = CALL_ACTIONS.some((a) => handlers.has(a));
    if (!found && !inCall) return null;
    const el = found ? found.el : null;
    current = el;
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const playing = !!el && !el.paused && !el.ended;
    // Playing but buffering (an ad blocker skipping an ad, a slow network):
    // the clock must not run ahead of the sound.
    const advancing = playing && el.readyState >= 3;
    const now = Date.now();

    let position = el ? el.currentTime : 0;
    let duration = el ? el.duration : 0;
    let rate = el ? el.playbackRate : 1;
    let volume = el ? el.volume : 1;
    let muted = el ? el.muted : false;
    const mp = youtube(el);
    if (positionState && el) {
      const ps = positionState;
      position = Math.min(ps.duration, ps.position + (advancing ? ((now - ps.at) / 1000) * ps.rate : 0));
      duration = ps.duration;
      rate = ps.rate;
    } else if (mp) {
      const clock = youtubeClock(mp, el);
      if (clock) ({ position, duration } = clock);
    }
    if (mp) {
      // The element's volume includes YouTube's loudness normalization; the
      // player's volume is the number the user set.
      const v = youtubeVolume(mp);
      if (v) ({ volume, muted } = v);
    }

    // Live: the element says Infinity, the site said so, YouTube says so, or
    // the duration is longer than any real recording (live players often use
    // huge placeholders).
    const live = !!el && (duration === Infinity || siteSaysLive || (mp && youtubeLive(mp)) || duration > 1e6);
    const ad = !!mp && youtubeAd(mp);
    const edge = live ? liveEdge(el, mp) : null;

    const actions = [...handlers.keys()];
    const context = el ? contextInfo(el) : null;
    if (ad && !actions.includes("skipad") && youtubeSkipButton()) actions.push("skipad");

    return {
      playing,
      advancing,
      position: !live && Number.isFinite(position) ? position : 0,
      duration: !live && Number.isFinite(duration) ? duration : 0,
      live,
      // Seconds behind the live edge, and whether Cue can jump to it.
      behind: edge ? edge.behind : 0,
      canGoLive: !!edge,
      ad,
      rate,
      title: text(md && md.title) || text(context && context.title) || text(document.title) || location.hostname,
      artist:
        md && md.artist && !(context && context.artist && namesSite(md.artist, context.site))
          ? text(md.artist)
          : text(context && (context.artist || context.site)),
      album: text(md && md.album),
      artwork: (md && artworkUrl(md.artwork)) || (context ? artworkUrl([{ src: context.artwork }]) : ""),
      actions,
      // Respect a site that turns picture-in-picture off for its video.
      video: el instanceof HTMLVideoElement && el.videoWidth > 0 && !el.disablePictureInPicture,
      pip: !!document.pictureInPictureElement,
      volume,
      muted,
      chapters: chapterList(md),
      inCall,
      mic: call.mic,
      camera: call.camera,
      // A call outranks any media in other frames of the same tab.
      score: (found ? found.score : 0) + (inCall ? 16 : 0),
      host: location.hostname,
      at: now,
    };
  };

  // What the panel shows now for state s: it moves the clock only while
  // playback is advancing, and the live gap grows while it is not.
  const expected = (s, at) => (s.advancing ? s.position + ((at - s.at) / 1000) * s.rate : s.position);
  const expectedBehind = (s, at) => s.behind + ((at - s.at) / 1000) * (s.advancing ? 1 - s.rate : 1);

  const unchanged = (a, b) =>
    STABLE.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k])) &&
    Math.abs(a.position - expected(b, a.at)) < 0.75 &&
    Math.abs(a.behind - expectedBehind(b, a.at)) < 2;

  function emit(force) {
    timer = 0;
    if (retired) return;
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
    const mp = youtube(el);
    if (mp && !positionState && typeof mp.seekTo === "function" && youtubeClock(mp, el)) {
      try {
        mp.seekTo(Math.max(0, time), true); // track time, which the player maps itself
        return;
      } catch {}
    }
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
      const allowed = (v) => v instanceof HTMLVideoElement && v.videoWidth > 0 && !v.disablePictureInPicture;
      let video = allowed(el) ? el : null;
      if (!video) for (const e of elements) if (allowed(e)) video = e;
      if (!video) return false;
      await video.requestPictureInPicture();
      return true;
    } catch {
      return false;
    }
  };

  // Picture-in-picture needs a user gesture. The panel calls this through
  // chrome.scripting, which carries the click's gesture into the page; a plain
  // message would not.
  try {
    Object.defineProperty(window, Symbol.for("cue.pip"), {
      value: () => togglePip(primary()?.el),
      configurable: true, // so a newer copy can replace it after an update
    });
  } catch {}

  window.addEventListener(COMMAND_EVENT, (e) => {
    if (retired) return;
    let cmd;
    try {
      cmd = JSON.parse(e.detail);
    } catch {
      return;
    }
    const { action, value } = cmd || {};
    if (action === "report") return emit(true);
    if (action === "scan") {
      deepScan(document);
      return schedule();
    }

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
      case "skipad":
        if (!callHandler("skipad")) youtubeSkipButton()?.click();
        break;
      case "golive":
        goLive(el);
        break;
      case "previoustrack":
      case "nexttrack":
      case "togglemicrophone":
      case "togglecamera":
      case "hangup":
        callHandler(action);
        break;
      case "seekbackward":
      case "seekforward": {
        const offset = action === "seekforward" ? 10 : -10;
        if (!callHandler(action, { seekOffset: 10 }) && el) {
          seekElement(el, snapshot().position + offset); // track time, from whichever clock is in use
        }
        break;
      }
      case "seekto":
        if (!Number.isFinite(value)) break;
        if (!callHandler("seekto", { seekTime: value, fastSeek: false })) seekElement(el, value);
        break;
      case "volume": {
        if (!el || !Number.isFinite(value)) break;
        const v = Math.min(1, Math.max(0, value));
        const mp = youtube(el);
        if (mp && typeof mp.setVolume === "function") {
          // Through the player, so YouTube keeps it instead of reapplying its own.
          try {
            mp.setVolume(Math.round(v * 100));
            if (v > 0 && mp.isMuted()) mp.unMute();
            break;
          } catch {}
        }
        el.volume = v;
        if (v > 0) el.muted = false;
        break;
      }
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
