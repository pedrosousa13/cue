// Isolated-world bridge between page.js (which cannot use chrome.* APIs) and
// the service worker (which cannot see the page's JavaScript).
(() => {
  // Exactly one live relay per frame. A tab that was still loading during
  // install gets both the manifest copy and the injected copy, and two relays
  // would run every command twice (toggle twice = no change). A relay orphaned
  // by an extension reload reports itself dead, so the new copy takes over.
  if (globalThis.__cueRelayAlive?.()) return;
  globalThis.__cueRelayAlive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  const post = (state) => {
    try {
      chrome.runtime.sendMessage({ type: "state", state }).catch(() => {});
    } catch {
      // The extension was reloaded and this copy is orphaned. The new copy
      // takes over; nothing to do here.
    }
  };

  // At most one message per 200 ms per frame; the latest state wins. A page
  // can dispatch cue:state itself, so this limit is what protects the
  // service worker, not page.js's own coalescing.
  const INTERVAL = 200;
  let reported = false; // has this frame ever sent a state?
  let pending; // undefined: nothing waiting
  let lastSent = 0;
  let timer = 0;

  const flush = () => {
    timer = 0;
    lastSent = Date.now();
    const state = pending;
    pending = undefined;
    // A frame with no media never wakes the service worker: "nothing here"
    // is only worth sending after something was reported.
    if (state === null && !reported) return;
    reported = state !== null;
    post(state);
  };

  const send = (state) => {
    pending = state;
    if (timer) return;
    const wait = INTERVAL - (Date.now() - lastSent);
    if (wait <= 0) flush();
    else timer = setTimeout(flush, wait);
  };

  const command = (detail) =>
    window.dispatchEvent(new CustomEvent("cue:command", { detail: JSON.stringify(detail) }));

  window.addEventListener("cue:state", (e) => {
    if (typeof e.detail !== "string") return;
    try {
      send(JSON.parse(e.detail));
    } catch {}
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "command") {
      command({ action: msg.action, value: msg.value });
      // Always answer: a command that gets no reply looks like a dead frame,
      // and the hub removes dead frames.
      sendResponse(true);
    }
  });

  // Leaving the page (or entering the back/forward cache) removes this frame
  // from the hub; coming back from the cache reports it again.
  window.addEventListener("pagehide", () => {
    // Send now: the page may be gone before a timer fires.
    clearTimeout(timer);
    pending = null;
    flush();
  });
  window.addEventListener("pageshow", (e) => e.persisted && command({ action: "report" }));

  // When injected into an already-open tab, ask page.js for its current state.
  command({ action: "report" });
})();
