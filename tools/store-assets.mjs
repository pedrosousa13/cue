// Renders the Chrome Web Store images from the real extension.
//   npm run store-assets
// Writes store/screenshot-*.png (1280x800) and store/promo-small.png (440x280).
import { chromium } from "playwright";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));
const OUT = fileURLToPath(new URL("../store/", import.meta.url));

function tone(seconds, rate = 8000) {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n, 128);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
}
const WAV = tone(240);

// Made-up artists and art: store images must not show other people's brands.
const art = (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
  <rect width="128" height="128" fill="url(#g)"/><circle cx="64" cy="64" r="26" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="6"/></svg>`;

const music = (title, artist, album, artUrl, chapters = "") => `<!doctype html><title>${title}</title><audio id="a" src="/tone.wav"></audio>
  <script>
    navigator.mediaSession.metadata = new MediaMetadata({ title: ${JSON.stringify(title)}, artist: ${JSON.stringify(artist)}, album: ${JSON.stringify(album)},
      artwork: [{ src: "${artUrl}", sizes: "128x128", type: "image/svg+xml" }] ${chapters} });
    navigator.mediaSession.setActionHandler("nexttrack", () => {});
    navigator.mediaSession.setActionHandler("previoustrack", () => {});
  </script>`;

const PAGES = {
  "/art1.svg": art("#ff7a59", "#7b2ff7"),
  "/art2.svg": art("#00c6a7", "#1e3c72"),
  "/art3.svg": art("#f7b733", "#fc4a1a"),
  "/song.html": music("Midnight Drive", "Neon Harbor", "Night Shift", "/art1.svg"),
  "/podcast.html": music("Episode 42: Building quiet software", "The Slow Web", "", "/art2.svg",
    ', chapterInfo: [{ title: "Intro", startTime: 0 }, { title: "Why quiet matters", startTime: 40 }, { title: "Q&A", startTime: 150 }]'),
  "/live.html": `<!doctype html><title>Live</title><audio id="a" src="/tone.wav"></audio>
    <script>
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Rain on the Harbor", artist: "Ambient Radio",
        artwork: [{ src: "/art3.svg", sizes: "128x128", type: "image/svg+xml" }] });
      navigator.mediaSession.setPositionState({ duration: Infinity, position: 0 });
    </script>`,
  "/call.html": `<!doctype html><title>Team stand-up</title><script>
    const ms = navigator.mediaSession; ms.setMicrophoneActive(true); ms.setCameraActive(true);
    for (const a of ["togglemicrophone", "togglecamera", "hangup"]) ms.setActionHandler(a, () => {});
  </script>`,
};

const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/tone.wav") {
    const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    const start = r ? Number(r[1]) : 0, end = r && r[2] ? Number(r[2]) : WAV.length - 1;
    res.writeHead(r ? 206 : 200, { "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": end - start + 1,
      ...(r ? { "content-range": `bytes ${start}-${end}/${WAV.length}` } : {}) });
    return res.end(WAV.subarray(start, end + 1));
  }
  const body = PAGES[path];
  if (!body) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": path.endsWith(".svg") ? "image/svg+xml" : "text/html" }).end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
// Example domains (resolved to this server) so cards show a site name.
const site = (name) => `http://${name}:${port}`;

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: true, deviceScaleFactor: 2,
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required",
    "--host-resolver-rules=MAP *.example 127.0.0.1",
  ],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
const id = new URL(sw.url()).host;

const play = async (host, path, setup) => {
  const p = await ctx.newPage();
  await p.goto(site(host) + path);
  await p.evaluate(setup || (() => document.getElementById("a")?.play()));
  return p;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await play("radio.example", "/live.html", async () => { const a = document.getElementById("a"); a.loop = true; a.currentTime = 237; await a.play(); });
const pod = await play("podcasts.example", "/podcast.html", async () => { const a = document.getElementById("a"); a.currentTime = 52; await a.play(); a.pause(); });
await play("music.example", "/song.html", async () => { const a = document.getElementById("a"); a.currentTime = 74; await a.play(); });
await wait(1500);

// Capture the real panel at popup width, in both themes.
const panelShot = async (scheme) => {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 380, height: 560 });
  await p.emulateMedia({ colorScheme: scheme });
  await p.goto(`chrome-extension://${id}/panel.html`);
  await p.waitForTimeout(1500);
  // Whole cards only: crop at the bottom of the list.
  const h = await p.evaluate(() => Math.ceil(document.getElementById("list").getBoundingClientRect().bottom));
  const png = await p.screenshot({ clip: { x: 0, y: 0, width: 380, height: h } });
  await p.close();
  return png.toString("base64");
};
const optionsShot = async () => {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 460, height: 300 });
  await p.goto(`chrome-extension://${id}/options.html`);
  await p.locator('input[name="autoPause"]').check();
  const png = await p.screenshot();
  await p.close();
  return png.toString("base64");
};

const light = await panelShot("light");
// Second shot: swap the podcast for a video call, to show call controls.
await pod.close();
await play("meet.example", "/call.html", () => {});
await wait(1500);
const dark = await panelShot("dark");
const options = await optionsShot();
const icon = (await readFile(new URL("../extension/icon.svg", import.meta.url), "utf8")).replace(
  'width="128" height="128"', 'width="100%" height="100%"'
);

// Compose store images in a plain page.
const stage = await ctx.newPage();
const frame = (bg, ink, headline, sub, img, imgWidth) => `<!doctype html><html><body style="margin:0;width:1280px;height:800px;background:${bg};
  font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;gap:72px;padding:0 96px;box-sizing:border-box;color:${ink}">
  <div style="flex:1"><div style="width:72px;height:72px">${icon}</div>
  <h1 style="font-size:52px;line-height:1.08;margin:28px 0 18px;letter-spacing:-.02em">${headline}</h1>
  <p style="font-size:22px;line-height:1.45;margin:0;opacity:.75">${sub}</p></div>
  <img src="data:image/png;base64,${img}" style="width:${imgWidth}px;border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.28)"></body></html>`;

const shots = [
  ["screenshot-1.png", frame("#eef0f6", "#17181c", "Every tab's media, one place.",
    "Music, podcasts, videos, live streams and calls — with the controls each site supports.", light, 420)],
  ["screenshot-2.png", frame("#121318", "#eceef3", "Real next and previous.",
    "Cue calls each site's own track controls, so skip works anywhere media keys do.", dark, 420)],
  ["screenshot-3.png", frame("#eef0f6", "#17181c", "Your rules.",
    "Pause other tabs when one starts, remember volume per site, and choose what the badge counts.", options, 520)],
];
for (const [name, html] of shots) {
  await stage.setViewportSize({ width: 1280, height: 800 });
  await stage.setContent(html);
  await stage.waitForTimeout(200);
  await stage.screenshot({ path: OUT + name, scale: "css" });
  console.log(`store/${name}`);
}

await stage.setViewportSize({ width: 440, height: 280 });
await stage.setContent(`<!doctype html><body style="margin:0;width:440px;height:280px;background:linear-gradient(135deg,#3d5afe,#7b2ff7);
  display:flex;align-items:center;gap:22px;padding:0 40px;box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;color:#fff">
  <div style="width:84px;height:84px;flex:none;filter:drop-shadow(0 8px 20px rgba(0,0,0,.25))">${icon.replace('fill="#3d5afe"', 'fill="#ffffff26"')}</div>
  <div><div style="font-size:44px;font-weight:700;letter-spacing:-.02em">Cue</div>
  <div style="font-size:17px;line-height:1.35;opacity:.9;margin-top:4px">Media controls for every tab</div></div></body>`);
await stage.screenshot({ path: OUT + "promo-small.png", scale: "css" });
console.log("store/promo-small.png");

await ctx.close();
server.close();
