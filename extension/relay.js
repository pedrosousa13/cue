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

  const send = (state) => {
    try {
      chrome.runtime.sendMessage({ type: "state", state }).catch(() => {});
    } catch {
      // The extension was reloaded and this copy is orphaned. The new copy
      // takes over; nothing to do here.
    }
  };

  const command = (detail) =>
    window.dispatchEvent(new CustomEvent("cue:command", { detail: JSON.stringify(detail) }));

  window.addEventListener("cue:state", (e) => {
    if (typeof e.detail !== "string") return;
    try {
      send(JSON.parse(e.detail));
    } catch {}
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "command") command({ action: msg.action, value: msg.value });
  });

  // Leaving the page (or entering the back/forward cache) removes this frame
  // from the hub; coming back from the cache reports it again.
  window.addEventListener("pagehide", () => send(null));
  window.addEventListener("pageshow", (e) => e.persisted && command({ action: "report" }));

  // When injected into an already-open tab, ask page.js for its current state.
  command({ action: "report" });
})();
