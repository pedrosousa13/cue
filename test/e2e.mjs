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
      window.calls = { next: 0, prev: 0, skipad: 0 };
      const meta = () => (navigator.mediaSession.metadata = new MediaMetadata({
        title: tracks[i], artist: "Test Artist", album: "Test Album",
        artwork: [{ src: "/art.svg", sizes: "128x128", type: "image/svg+xml" }],
        chapterInfo: [{ title: "Intro", startTime: 0 }, { title: "Verse", startTime: 20 }, { title: "Chorus", startTime: 90 }],
      }));
      // Like real sites: the skipad handler exists only while an ad plays.
      window.startAd = () => navigator.mediaSession.setActionHandler("skipad", () => {
        calls.skipad++;
        navigator.mediaSession.setActionHandler("skipad", null);
      });
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
  "/call.html": `<!doctype html><title>Call page</title>
    <script>
      window.calls = { mic: 0, cam: 0, hang: 0 };
      let mic = true, cam = true;
      const ms = navigator.mediaSession;
      ms.setMicrophoneActive(true);
      ms.setCameraActive(true);
      ms.setActionHandler("togglemicrophone", () => { calls.mic++; mic = !mic; ms.setMicrophoneActive(mic); });
      ms.setActionHandler("togglecamera", () => { calls.cam++; cam = !cam; ms.setCameraActive(cam); });
      ms.setActionHandler("hangup", () => calls.hang++);
    </script>`,
  "/slow.html": `<!doctype html><title>Slow art page</title>
    <audio id="a" src="/tone.wav"></audio>
    <script>
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Slow Art", artist: "Slow Artist",
        artwork: [{ src: "/slow-art.svg", sizes: "128x128", type: "image/svg+xml" }],
      });
    </script>`,
  // Imitates YouTube's player: one element streams the whole queue, so its
  // clock runs 100s ahead of the track; the player object knows the track.
  "/yt.html": `<!doctype html><title>Fake YouTube</title>
    <div id="movie_player"><audio id="a" src="/tone.wav"></audio></div>
    <script>
      window.OFFSET = 100;
      const a = document.getElementById("a"), mp = document.getElementById("movie_player");
      let vol = 100, muted = false;
      window.yt = { seekTo: [], setVolume: [], skipped: 0 };
      mp.getProgressState = () => ({ current: a.currentTime - OFFSET, seekableStart: 0, seekableEnd: 60, duration: 999 });
      mp.getVideoData = () => ({ isLive: false });
      mp.seekTo = (t) => { yt.seekTo.push(t); a.currentTime = t + OFFSET; };
      // An ad, the way YouTube shows one: a class on the player and a Skip button.
      window.startYtAd = () => {
        mp.classList.add("ad-showing");
        const b = document.createElement("button");
        // A class name YouTube has not used: found by the "skip" fallback.
        b.className = location.search === "?renamed" ? "ytp-future-skip-thing" : "ytp-skip-ad-button";
        b.textContent = "Skip";
        b.onclick = () => { yt.skipped++; mp.classList.remove("ad-showing"); b.closest(".video-ads").remove(); a.dispatchEvent(new Event("durationchange")); };
        const ads = document.createElement("div");
        ads.className = "video-ads ytp-ad-module";
        ads.append(b);
        mp.append(ads);
        a.dispatchEvent(new Event("durationchange"));
      };
      mp.getVolume = () => vol;
      mp.isMuted = () => muted;
      mp.unMute = () => (muted = false);
      // Loudness normalization: the element plays quieter than the player volume.
      mp.setVolume = (v) => { yt.setVolume.push(v); vol = v; a.volume = (v / 100) * 0.5; };
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Queue Song", artist: "YT Artist" });
    </script>`,
  // Audio inside a shadow root that autoplays: no play() call, and its events
  // never leave the shadow tree.
  "/shadow.html": `<!doctype html><title>Shadow page</title><div id="host"></div>
    <script>
      document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
        '<audio src="/tone.wav" autoplay></audio>';
    </script>`,
  // A YouTube live stream: the player says live; the live edge moves with the
  // wall clock and starts 42 s ahead of playback.
  "/yt-live.html": `<!doctype html><title>Fake YouTube live</title>
    <div id="movie_player"><audio id="a" src="/tone.wav"></audio></div>
    <script>
      const a = document.getElementById("a"), mp = document.getElementById("movie_player");
      const t0 = Date.now();
      let atHead = false;
      window.live = { wentLive: 0 };
      const edge = () => 42 + (Date.now() - t0) / 1000;
      mp.getVideoData = () => ({ isLive: true });
      mp.getProgressState = () => ({ current: a.currentTime, seekableStart: 0, seekableEnd: atHead ? a.currentTime : edge(), isAtLiveHead: atHead, duration: 121601512 });
      mp.seekToLiveHead = () => { live.wentLive++; atHead = true; };
      mp.seekTo = () => {};
      mp.getVolume = () => 100;
      mp.isMuted = () => false;
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Live Show", artist: "Live Channel" });
    </script>`,
  "/site-live.html": `<!doctype html><title>Site live</title><audio id="a" src="/tone.wav"></audio>
    <script>
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Radio", artist: "Site Live" });
      navigator.mediaSession.setPositionState({ duration: Infinity, position: 0 });
    </script>`,
  // Reddit-like: no Media Session; the post element carries the title, and the
  // player keeps its video in a shadow root.
  "/reddit.html": `<!doctype html><title>Reddit - Dive into anything</title>
    <meta property="og:site_name" content="Reddit">
    <shreddit-post post-title="Cat does a perfect backflip" subreddit-prefixed-name="r/aww">
      <shreddit-player-2></shreddit-player-2>
    </shreddit-post>
    <script>
      const root = document.querySelector("shreddit-player-2").attachShadow({ mode: "open" });
      root.innerHTML = '<video id="v" src="/tone.wav" poster="/art.svg"></video>';
      window.v = root.getElementById("v");
      // Real Reddit publishes the post title, with "Reddit" as the artist.
      if (location.search === "?ms") {
        navigator.mediaSession.metadata = new MediaMetadata({ title: "Cat does a perfect backflip", artist: "Reddit" });
      }
    </script>`,
  "/article.html": `<!doctype html><title>Example News</title>
    <meta property="og:site_name" content="Example News">
    <article><h2>Storm hits the coast</h2><audio id="a" src="/tone.wav"></audio></article>`,
  "/muted.html": `<!doctype html><title>Muted preview</title><audio id="a" src="/tone.wav" muted></audio>`,
  "/nopip.html": `<!doctype html><title>No PiP page</title>
    <canvas id="c" width="320" height="180"></canvas>
    <video id="v" muted playsinline disablepictureinpicture width="320" height="180"></video>
    <script>
      const c = document.getElementById("c"), g = c.getContext("2d");
      setInterval(() => g.fillRect(0, 0, 320, 180), 50);
      document.getElementById("v").srcObject = c.captureStream(20);
    </script>`,
  "/detached.html": `<!doctype html><title>Detached page</title>
    <audio id="b" src="/tone.wav" preload="auto"></audio>
    <script>window.d = new Audio("/tone.wav");</script>`,
  "/forge.html": `<!doctype html><title>Forge page</title><audio id="a" src="/tone.wav"></audio>
    <script>navigator.mediaSession.metadata = new MediaMetadata({ title: "Forged", artist: "Forger" });</script>`,
  "/crash.html": `<!doctype html><title>Crash page</title><audio id="a" src="/tone.wav"></audio>
    <script>navigator.mediaSession.metadata = new MediaMetadata({ title: "Doomed", artist: "Crasher" });</script>`,
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
  if (req.url === "/slow-art.svg") {
    // A thumbnail on a slow network.
    return setTimeout(() => res.writeHead(200, { "content-type": "image/svg+xml" }).end(PAGES["/art.svg"]), 3000);
  }
  const body = PAGES[req.url.split("?")[0]];
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
    input.dispatchEvent(new Event("change"));
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

await step("chapters mark the seek bar and name the current chapter", async () => {
  assert.equal(await card.locator(".marks span").count(), 2);
  await card.locator(".chapter", { hasText: "Verse" }).waitFor({ timeout: 2000 });
});

await step("skip ad appears during an ad and calls the page's handler", async () => {
  await audio(() => startAd());
  await card.locator("button.skip-ad").click();
  await until(() => audio(() => calls.skipad === 1));
  await card.locator("button.rate").waitFor({ timeout: 2000 }); // speed is back after the ad
});

await step("hiding a card lasts until the tab plays again", async () => {
  await card.locator("button.hide").click();
  await until(async () => (await panel.locator(".card").count()) === 0);
  // A hidden card is not a keyboard shortcut target.
  await sw.evaluate(() => runCommand("toggle-playback"));
  await panel.waitForTimeout(400);
  assert.equal(await audio(() => document.getElementById("a").paused), false);
  await audio(() => document.getElementById("a").pause());
  await panel.waitForTimeout(300); // let the pause reach the hub, or it coalesces with the play
  await audio(() => document.getElementById("a").play());
  await card.waitFor({ timeout: 4000 });
});

await step("settings page saves auto-pause", async () => {
  const options = await ctx.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.locator('input[name="autoPause"]').check();
  await until(() => sw.evaluate(async () => (await chrome.storage.sync.get("settings")).settings?.autoPause === true));
  await options.close();
});

await step("auto-pause stops the other tab when a new one plays with sound", async () => {
  const second = await ctx.newPage();
  await second.goto(`${base}/music.html?second`);
  await second.evaluate(() => document.getElementById("a").play());
  await until(() => audio(() => document.getElementById("a").paused));
  await second.close();
  await sw.evaluate(() => chrome.storage.sync.set({ settings: { autoPause: false } }));
  await audio(() => document.getElementById("a").play());
  await panel.bringToFront();
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

await step("badge counts the tabs in Cue", async () => {
  await until(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === "2");
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

await step("call page shows mic, camera and hang-up instead of the transport", async () => {
  const callPage = await ctx.newPage();
  await callPage.goto(`${base}/call.html`);
  await panel.bringToFront();
  const ccard = panel.locator(".card").filter({ hasText: "Call page" });
  await ccard.waitFor({ timeout: 4000 });
  assert.equal(await ccard.locator("button.play").isVisible(), false);
  await ccard.locator('button[aria-label="Mute microphone"]').click();
  await ccard.locator('button[aria-label="Unmute microphone"]').waitFor({ timeout: 2000 });
  await ccard.locator('button[aria-label="Turn camera off"]').click();
  await ccard.locator('button[aria-label="Turn camera on"]').waitFor({ timeout: 2000 });
  await ccard.locator('button[aria-label="Leave call"]').click();
  await until(() => callPage.evaluate(() => calls.mic === 1 && calls.cam === 1 && calls.hang === 1));
  await callPage.close();
});

await step("closing a tab removes its card", async () => {
  await video.close();
  await until(async () => (await panel.locator(".card").count()) === 1);
});

await step("page reload clears the stale card", async () => {
  await music.reload();
  await until(async () => (await panel.locator(".card").count()) === 0);
});

await step("volume is remembered for the site after a reload", async () => {
  await audio(() => document.getElementById("a").play());
  await until(() => audio(() => Math.abs(document.getElementById("a").volume - 0.3) < 0.01));
});

await step("slow artwork does not delay the popup", async () => {
  const slow = await ctx.newPage();
  await slow.goto(`${base}/slow.html`);
  await slow.evaluate(() => document.getElementById("a").play());
  // Let the hub learn about the tab and the panel cache its card.
  await panel.bringToFront();
  await panel.locator(".card").filter({ hasText: "Slow Artist" }).waitFor({ timeout: 4000 });

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  // The browser shows a popup at its load event. It must not wait for art.
  const loadMs = await popup.evaluate(() => performance.getEntriesByType("navigation")[0].loadEventEnd);
  assert.ok(loadMs < 1000, `load took ${Math.round(loadMs)}ms`);
  // The cached card is drawn before live state arrives, and art still loads.
  await popup.locator(".card").filter({ hasText: "Slow Artist" }).waitFor({ timeout: 1000 });
  await until(() => popup.evaluate(() => [...document.querySelectorAll(".art img")].some((i) => i.src.endsWith("/slow-art.svg") && i.complete && i.naturalWidth > 0)), 6000);
  await popup.close();
  await slow.close();
});

await step("YouTube player: track clock, track seek, player volume", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/yt.html`);
  await page.evaluate(() => { const a = document.getElementById("a"); a.currentTime = 105; return a.play(); });
  await panel.bringToFront();
  const ycard = panel.locator(".card").filter({ hasText: "YT Artist" });
  await ycard.waitFor({ timeout: 4000 });
  assert.equal(await ycard.locator(".total").textContent(), "1:00"); // the track, not the 3:00 element
  assert.match(await ycard.locator(".current").textContent(), /^0:0\d$/);

  await ycard.locator('input[aria-label="Seek"]').evaluate((input) => {
    input.value = "30";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("change"));
  });
  await until(() => page.evaluate(() => yt.seekTo.includes(30) && Math.abs(document.getElementById("a").currentTime - 130) < 1.5));

  await ycard.locator('input[aria-label="Volume"]').evaluate((input) => {
    input.value = "0.5";
    input.dispatchEvent(new Event("input"));
  });
  await until(() => page.evaluate(() => yt.setVolume.includes(50)));
  // The slider shows the player's 50%, not the normalized element's 25%.
  await until(async () => (await ycard.locator('input[aria-label="Volume"]').inputValue()) === "0.5");

  // The page's clock jumps 5 s without any media event (a stall the browser did
  // not report). The periodic check while playing corrects the panel.
  const shown = async () => {
    const [m, sec] = (await ycard.locator(".current").textContent()).split(":").map(Number);
    return m * 60 + sec;
  };
  const before = await shown();
  await page.evaluate(() => (OFFSET = 95));
  await until(async () => (await shown()) >= before + 5, 4000);

  // An ad: the card says so, seeking is off, and Skip ad presses YouTube's button.
  await page.evaluate(() => startYtAd());
  await ycard.locator(".chapter", { hasText: "Ad" }).waitFor({ timeout: 2000 });
  assert.equal(await ycard.locator('input[aria-label="Seek"]').isDisabled(), true);
  assert.equal(await ycard.locator('button[aria-label="Forward 10 seconds"]').isDisabled(), true);
  await ycard.locator("button.skip-ad").click();
  await until(() => page.evaluate(() => yt.skipped === 1));
  await until(async () => !(await ycard.locator(".chapter").isVisible()));
  await page.close();
});

await step("live stream: behind live, growing while paused, Go live", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/yt-live.html`);
  await page.evaluate(() => document.getElementById("a").play());
  await panel.bringToFront();
  const lcard = panel.locator(".card").filter({ hasText: "Live Channel" });
  await lcard.waitFor({ timeout: 4000 });
  await lcard.locator(".live", { hasText: /LIVE −0:4\d/ }).waitFor({ timeout: 2000 });
  assert.equal(await lcard.locator(".total").textContent(), "");
  assert.equal(await lcard.locator('input[aria-label="Seek"]').isDisabled(), true);

  // Paused, the live edge moves on without us.
  const gap = async () => {
    const m = /−(\d+):(\d+)/.exec(await lcard.locator(".live").textContent());
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  };
  await lcard.locator("button.play").click();
  await until(() => page.evaluate(() => document.getElementById("a").paused));
  const g1 = await gap();
  await panel.waitForTimeout(2500);
  assert.ok((await gap()) >= g1 + 2, "gap grows while paused");

  await lcard.locator("button.go-live").click();
  await until(() => page.evaluate(() => live.wentLive === 1));
  await lcard.locator(".live", { hasText: /^LIVE$/ }).waitFor({ timeout: 2000 });
  assert.equal(await lcard.locator("button.go-live").isVisible(), false);
  await page.close();
});

await step("a site can declare live with setPositionState", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/site-live.html`);
  await page.evaluate(() => document.getElementById("a").play());
  await panel.bringToFront();
  const c = panel.locator(".card").filter({ hasText: "Site Live" });
  await c.waitFor({ timeout: 4000 });
  await c.locator(".live").waitFor({ timeout: 2000 });
  assert.equal(await c.locator(".total").textContent(), "");
  await page.close();
});

await step("Skip ad still works if YouTube renames its Skip button", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/yt.html?renamed`);
  await page.evaluate(() => document.getElementById("a").play());
  await panel.bringToFront();
  const c = panel.locator(".card").filter({ hasText: "YT Artist" });
  await c.waitFor({ timeout: 4000 });
  await page.evaluate(() => startYtAd());
  await c.locator("button.skip-ad").click({ timeout: 3000 });
  await until(() => page.evaluate(() => yt.skipped === 1));
  await page.close();
});

await step("audible tab with media in a shadow root is found", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/shadow.html`);
  await panel.waitForTimeout(500);
  assert.equal(await panel.locator(".card").filter({ hasText: "Shadow page" }).count(), 0); // not found by events
  // Headless Chromium never marks tabs audible, so fire what that event calls.
  await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await onAudibleUnknown(tab.id);
  }, `${base}/shadow.html`);
  await panel.bringToFront();
  await panel.locator(".card").filter({ hasText: "Shadow page" }).waitFor({ timeout: 6000 });
  await page.close();
});

await step("Reddit post: title and subreddit from the post, art from the poster", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/reddit.html`);
  await page.evaluate(() => v.play());
  await panel.bringToFront();
  const c = panel.locator(".card").filter({ hasText: "Cat does a perfect backflip" });
  await c.waitFor({ timeout: 4000 });
  assert.match(await c.locator(".artist").textContent(), /r\/aww/);
  assert.match(await c.locator(".art img").getAttribute("src"), /\/art\.svg$/);
  await page.close();
});

await step("Reddit's own artist 'Reddit' is replaced by the subreddit", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/reddit.html?ms`);
  await page.evaluate(() => v.play());
  await panel.bringToFront();
  const c = panel.locator(".card").filter({ hasText: "Cat does a perfect backflip" });
  await c.waitFor({ timeout: 4000 });
  await c.locator(".artist", { hasText: "r/aww" }).waitFor({ timeout: 2000 });
  await page.close();
});

await step("article page: title from the article heading, site from og:site_name", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/article.html`);
  await page.evaluate(() => document.getElementById("a").play());
  await panel.bringToFront();
  const c = panel.locator(".card").filter({ hasText: "Storm hits the coast" });
  await c.waitFor({ timeout: 4000 });
  assert.match(await c.locator(".artist").textContent(), /Example News/);
  await page.close();
});

await step("volume memory does not unmute a muted element", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/muted.html`);
  await page.evaluate(() => document.getElementById("a").play());
  await panel.bringToFront();
  await panel.locator(".card").filter({ hasText: "Muted preview" }).waitFor({ timeout: 4000 });
  await panel.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.getElementById("a").muted), true);
  await page.close();
});

await step("a site's picture-in-picture block is respected", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/nopip.html`);
  await page.evaluate(() => document.getElementById("v").play());
  await panel.bringToFront();
  const c = panel.locator(".card").filter({ hasText: "No PiP page" });
  await c.waitFor({ timeout: 4000 });
  assert.equal(await c.locator('button[aria-label="Picture in picture"]').isVisible(), false);
  assert.equal(await page.evaluate(() => document.getElementById("v").disablePictureInPicture), true);
  await page.close();
});

await step("a paused detached element does not outrank media in the page", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/detached.html`);
  await page.evaluate(async () => {
    await d.play();
    await new Promise((r) => setTimeout(r, 300));
    d.pause();
    const b = document.getElementById("b");
    if (b.readyState === 0) await new Promise((r) => b.addEventListener("loadedmetadata", r, { once: true }));
  });
  await panel.bringToFront();
  const c = panel.locator(".card").filter({ hasText: "Detached page" });
  await c.waitFor({ timeout: 4000 });
  await c.locator("button.play").click();
  await until(() => page.evaluate(() => !document.getElementById("b").paused && d.paused));
  await page.close();
});

await step("a page cannot forge its host name or outrank other frames", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/forge.html`);
  await page.evaluate(() => document.getElementById("a").play());
  await page.waitForTimeout(300);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("cue:state", { detail: JSON.stringify({
      playing: true, position: 1, duration: 60, rate: 1, title: "Forged", artist: "Forger",
      actions: [], volume: 1, score: 1e9, host: "paypal.com", at: Date.now(),
    }) }))
  );
  await panel.bringToFront();
  const c = panel.locator(".card").filter({ hasText: "Forger" });
  await c.waitFor({ timeout: 4000 });
  await panel.waitForTimeout(300);
  assert.equal((await c.locator(".source span").textContent()).trim(), "127.0.0.1");
  const score = await sw.evaluate(async () => {
    const { tabs } = await chrome.storage.session.get("tabs");
    return Math.max(...Object.values(tabs).flatMap((t) => Object.values(t.frames).map((f) => f.score)));
  });
  assert.ok(score <= 31, `score ${score}`);
  await page.close();
});

await step("a frame that no longer answers is removed when a control cannot reach it", async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/crash.html`);
  await page.evaluate(() => document.getElementById("a").play());
  await panel.bringToFront();
  await panel.locator(".card").filter({ hasText: "Crasher" }).waitFor({ timeout: 4000 });
  // What a crash leaves behind: a playing frame that no longer exists. A real
  // renderer crash takes down headless Chromium, so plant it directly.
  await sw.evaluate((url) => {
    for (const entry of tabs.values()) {
      const real = Object.values(entry.frames)[0];
      if (!real || real.title !== "Doomed") continue;
      entry.frames[999] = { ...real, title: "Ghost", score: 31, at: Date.now() };
    }
    save();
  });
  const ghost = panel.locator(".card").filter({ hasText: "Ghost" });
  await ghost.waitFor({ timeout: 2000 });
  await ghost.locator("button.play").click();
  await until(async () => (await ghost.count()) === 0);
  await panel.locator(".card").filter({ hasText: "Doomed" }).waitFor({ timeout: 2000 }); // the real frame stays
  await page.close();
});

await step("page.js version matches the manifest", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(`${EXT}/manifest.json`, "utf8"));
  const page = await readFile(`${EXT}/page.js`, "utf8");
  assert.equal(/const VERSION = "([^"]+)"/.exec(page)[1], manifest.version);
});

await step("toolbar popup page has a fixed popup width", async () => {
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  assert.equal(await popup.evaluate(() => document.body.getBoundingClientRect().width), 380);
  await popup.close();
});

await ctx.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
