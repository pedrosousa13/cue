// Shared by the service worker, the panel and the settings page.
const CUE_DEFAULTS = {
  autoPause: false, // pause other tabs when one starts playing with sound
  rememberVolume: true, // reapply the last volume set for a site
  badge: "playing", // "listed" | "playing" | "off"
};

async function cueSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...CUE_DEFAULTS, ...settings };
}
