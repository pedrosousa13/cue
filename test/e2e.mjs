// End-to-end test: loads the extension into Playwright's Chromium, plays media
// on local test pages, and drives everything through the real panel UI.
//   npm test
import { chromium } from "playwright";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));

// --- Test site --------------------------------------------------------------
function tone(seconds = 60, rate = 8000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return buf;
}

const PAGES = {
  "/music.html": `<!doctype html><title>Music page</title>
    <audio id="a" src="/tone.wav"></audio>
    <script>
      const tracks = ["Track One", "Track Two", "Track Three"];
      let i = 0;
      window.calls = { next: 0, prev: 0 };
      const meta = () => (navigator.mediaSession.metadata = new MediaMetadata({
        title: tracks[i], artist: "Test Artist", album: "Test Album",
        artwork: [{ src: "/art.svg", sizes: "128x128", type: "image/svg+xml" }],
      }));
      meta();
      navigator.mediaSession.setActionHandler("nexttrack", () => { i = (i + 1) % 3; calls.next++; meta(); });
      navigator.mediaSession.setActionHandler("previoustrack", () => { i = (i + 2) % 3; calls.prev++; meta(); });
    </script>`,
  "/video.html": `<!doctype html><title>Video page</title>
    <canvas id="c" width="320" height="180"></canvas>
    <video id="v" muted playsinline width="320" height="180"></video>
    <script>
      const c = document.getElementById("c"), g = c.getContext("2d");
      let f = 0;
      setInterval(() => { g.fillStyle = "hsl(" + (f++ * 7) % 360 + ",70%,50%)"; g.fillRect(0, 0, 320, 180); }, 50);
      document.getElementById("v").srcObject = c.captureStream(20);
    </script>`,
  "/art.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#f80"/></svg>`,
};

const WAV = tone(180);
const server = createServer((req, res) => {
  if (req.url === "/tone.wav") {
    // Media elements need byte ranges to learn the duration and to seek.
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    if (!range) {
      res.writeHead(200, { "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": WAV.length });
      return res.end(WAV);
    }
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : WAV.length - 1;
    res.writeHead(206, {
      "content-type": "audio/wav",
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${WAV.length}`,
      "content-length": end - start + 1,
    });
    return res.end(WAV.subarray(start, end + 1));
  }
  const body = PAGES[req.url];
  if (!body) return res.writeHead(404).end();
  const type = req.url.endsWith(".svg") ? "image/svg+xml" : "text/html";
  res.writeHead(200, { "content-type": type }).end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// --- Harness ------------------------------------------------------------------
const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
const extId = new URL(sw.url()).host;

let passed = 0;
let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e.message).split("\n")[0]}`);
  }
}

const until = async (fn, timeout = 4000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out (last: ${last})`);
};

// --- Tests ----------------------------------------------------------------------
const music = await ctx.newPage();
await music.goto(`${base}/music.html`);
await music.evaluate(() => document.getElementById("a").play());

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.bringToFront();
const card = panel.locator(".card").filter({ hasText: "Test Artist" });
const audio = (fn) => music.evaluate(fn);

await step("shows the playing tab with mediaSession metadata", async () => {
  await card.locator(".title", { hasText: "Track One" }).waitFor({ timeout: 4000 });
  assert.match(await card.locator(".artist").textContent(), /Test Artist · Test Album/);
  assert.match(await card.locator(".art img").getAttribute("src"), /\/art\.svg$/);
});

await step("clock advances without any page round trip", async () => {
  const a = await card.locator(".current").textContent();
  await panel.waitForTimeout(1300);
  const b = await card.locator(".current").textContent();
  assert.notEqual(a, b);
});

await step("next uses the page's nexttrack handler", async () => {
  await card.locator('button[aria-label="Next track"]').click();
  await card.locator(".title", { hasText: "Track Two" }).waitFor({ timeout: 2000 });
  assert.equal(await audio(() => calls.next), 1);
});

await step("previous uses the page's previoustrack handler", async () => {
  await card.locator('button[aria-label="Previous track"]').click();
  await card.locator(".title", { hasText: "Track One" }).waitFor({ timeout: 2000 });
  assert.equal(await audio(() => calls.prev), 1);
});

await step("pause and play", async () => {
  await card.locator("button.play").click();
  await until(() => audio(() => document.getElementById("a").paused));
  await card.locator('button.play[aria-label="Play"]').waitFor({ timeout: 2000 });
  await card.locator("button.play").click();
  await until(() => audio(() => !document.getElementById("a").paused));
});

await step("seek bar seeks the element", async () => {
  await card.locator('input[aria-label="Seek"]').evaluate((input) => {
    input.value = "30";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("change"));
  });
  await until(() => audio(() => Math.abs(document.getElementById("a").currentTime - 30) < 1.5));
});

await step("volume slider sets element volume", async () => {
  await card.locator('input[aria-label="Volume"]').evaluate((input) => {
    input.value = "0.3";
    input.dispatchEvent(new Event("input"));
  });
  await until(() => audio(() => Math.abs(document.getElementById("a").volume - 0.3) < 0.01));
});

await step("speed button changes playbackRate", async () => {
  await card.locator("button.rate").click();
  await until(() => audio(() => document.getElementById("a").playbackRate === 1.25));
  await card.locator("button.rate", { hasText: "1.25×" }).waitFor({ timeout: 2000 });
});

await step("mute button mutes the tab", async () => {
  await card.locator('button[aria-label="Mute tab"]').click();
  await card.locator('button[aria-label="Unmute tab"]').waitFor({ timeout: 2000 });
  await card.locator('button[aria-label="Unmute tab"]').click();
  await card.locator('button[aria-label="Mute tab"]').waitFor({ timeout: 2000 });
});

await step("keyboard shortcut toggles the playing tab", async () => {
  await sw.evaluate(() => runCommand("toggle-playback"));
  await until(() => audio(() => document.getElementById("a").paused));
  await sw.evaluate(() => runCommand("toggle-playback"));
  await until(() => audio(() => !document.getElementById("a").paused));
  await sw.evaluate(() => runCommand("next-track"));
  await until(() => audio(() => calls.next === 2));
});

const video = await ctx.newPage();
await video.goto(`${base}/video.html`);
await video.evaluate(() => document.getElementById("v").play());
await panel.bringToFront();
const vcard = panel.locator(".card").filter({ hasText: "Video page" });

await step("second tab appears; live stream shows LIVE and disables seek", async () => {
  await vcard.waitFor({ timeout: 4000 });
  assert.equal(await panel.locator(".card").count(), 2);
  await vcard.locator(".live", { hasText: "LIVE" }).waitFor({ timeout: 2000 });
  assert.equal(await vcard.locator('input[aria-label="Seek"]').isDisabled(), true);
});

await step("pause all pauses both tabs", async () => {
  await panel.locator("#pause-all").click();
  await until(() => audio(() => document.getElementById("a").paused));
  await until(() => video.evaluate(() => document.getElementById("v").paused));
  await video.evaluate(() => document.getElementById("v").play());
});

await step("picture-in-picture opens from the panel", async () => {
  await vcard.locator('button[aria-label="Picture in picture"]').click();
  await until(() => video.evaluate(() => !!document.pictureInPictureElement));
});

await step("closing a tab removes its card", async () => {
  await video.close();
  await until(async () => (await panel.locator(".card").count()) === 1);
});

await step("page reload clears the stale card", async () => {
  await music.reload();
  await until(async () => (await panel.locator(".card").count()) === 0);
});

await ctx.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
