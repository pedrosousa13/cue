const form = document.getElementById("form");

cueSettings().then((settings) => {
  form.autoPause.checked = settings.autoPause;
  form.rememberVolume.checked = settings.rememberVolume;
  form.badge.value = settings.badge;
});

form.addEventListener("change", () => {
  chrome.storage.sync.set({
    settings: {
      autoPause: form.autoPause.checked,
      rememberVolume: form.rememberVolume.checked,
      badge: form.badge.value,
    },
  });
});

// Vivaldi and Brave redirect chrome:// URLs to their own scheme.
document.getElementById("shortcuts").onclick = () =>
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
