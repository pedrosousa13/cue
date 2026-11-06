# Cue

Media controls for every tab. Cue lists every tab that plays audio or video, and lets you control each one from the toolbar or the side panel. It works in Chrome, Brave, Vivaldi, Edge, and other Chromium browsers.

## Features

- **Every tab, one list.** Title, artist, artwork, and site for each tab that plays media. Playing tabs come first. When a site does not publish what is playing, Cue reads it from the page: the post title and subreddit on Reddit, or the article heading on other sites, with the video's thumbnail as artwork.
- **Real next and previous.** Cue calls the site's own track handlers (the Media Session API), the same ones that your keyboard media keys use. This works on any site that supports media keys, with no per-site code. When a site has no track handlers, the buttons skip 10 seconds.
- **Seek bar and clock.** Drag to seek. The clock stops while the player buffers, and Cue corrects it if it drifts from the page. When a site publishes chapters, the seek bar marks them and the card names the current chapter.
- **Live streams.** The card shows `LIVE` at the live edge. When you pause or fall behind, it shows how far behind you are (for example `LIVE −0:42`) and a **Go live** button.
- **Ads.** During a YouTube ad the card shows "Ad" and seeking is off. When YouTube shows its Skip button, Cue's **Skip ad** presses it.
- **Video calls.** On call sites that support it (for example Google Meet), the card shows microphone, camera, and hang-up buttons.
- **Picture-in-picture** for video tabs.
- **Volume per tab**, plus a tab mute button. Cue remembers the volume for each site.
- **Playback speed**: 1×, 1.25×, 1.5×, 2×, 0.75×.
- **Pause all** when more than one tab plays.
- **Auto-pause (optional).** When a tab starts to play with sound, Cue pauses the other tabs.
- **Hide a card** until that tab plays again.
- **Keyboard shortcuts** for play/pause, next, previous, and mute. They can work when the browser is in the background.
- **Light and dark themes**, keyboard access, and screen reader labels.

## Install

Cue is not in the Chrome Web Store yet. To load it from source:

1. Clone this repository.
2. Open `chrome://extensions` (`vivaldi://extensions` in Vivaldi, `brave://extensions` in Brave).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `extension/` folder.

Tabs that were open before you installed Cue appear when they next play media.

### Toolbar

Pin Cue to the toolbar and click it to open the controls.

### Side panel

- **Chrome, Brave, Edge:** open the side panel and select **Cue**.
- **Vivaldi:** add a web panel with the URL `chrome-extension://<id>/panel.html`. Find `<id>` on `vivaldi://extensions`. If the panel theme does not match the browser, add `?theme=dark` or `?theme=light` to the URL.

### Keyboard shortcuts

| Action | Default |
| --- | --- |
| Play or pause | `Alt+Shift+P` |
| Next track | `Alt+Shift+.` |
| Previous track | `Alt+Shift+,` |
| Mute or unmute the tab | `Alt+Shift+M` |

To change a shortcut, or to make it work when the browser is not focused, open `chrome://extensions/shortcuts` and set its scope to **Global**. The shortcuts control the tab that is playing, or the tab that played most recently.

### Settings

Click the sliders icon in the Cue header, or open Cue's **Extension options**. You can turn on auto-pause, turn off volume memory, and choose what the toolbar badge counts: tabs in Cue, tabs playing, or nothing.

## How it works

Cue does not poll. Most media panels inject a script into each tab once a second to read the player. Cue does this instead:

1. A small script in each page listens for media events (play, pause, seek, track change). It sends a message only when something changes.
2. The service worker keeps the list in `chrome.storage.session`.
3. The panel reads that list and advances the clock itself between updates.

When nothing plays, Cue does no periodic work. When media plays, each tab sends a few messages per track, not one per second.

The popup draws the last known list immediately and loads artwork after it opens. The browser shows a popup only after its page finishes loading, so artwork from a slow network would otherwise keep the popup closed.

The page script also records the handlers that the site registers with `navigator.mediaSession`. That is how next and previous work on any site, and why Cue can use the site's own clock when the site publishes one. Some players, for example YouTube's autoplay queue, put several tracks into one media element. For those players the element's clock is wrong, and the site's clock is correct.

## Compared with other options

Checked in November 2026. The table lists only features that each project documents or that its code shows. "Not listed" means the project does not document the feature; it does not prove that the feature is missing.

| | Cue | Chrome and Brave media controls | [Browser Media Controls](https://chromewebstore.google.com/detail/browser-media-controls/cfahigpbeoiogheojkdmiebfcampoffa) | [Browser Player](https://github.com/fregante/browser-player) | [vivaldi-media-panel](https://github.com/levz0r/vivaldi-media-panel) |
| --- | --- | --- | --- | --- | --- |
| Type | Extension | Built into the browser | Extension | Extension | Extension |
| Works in Vivaldi | Yes | No (Vivaldi desktop has no built-in media controls) | Not listed | Not listed | Yes, made for Vivaldi |
| All media tabs in one list | Yes | Yes | Yes | No, one button | Yes |
| Next and previous track | Any site with Media Session handlers | Yes | Not listed | Not listed | 4 sites by selector, else ±10 s |
| Seek | Yes | Yes | Yes | Not listed | Yes |
| Volume per tab | Yes, remembered per site | Not listed | Yes | Not listed | Mute only |
| Picture-in-picture | Yes | Yes | Not listed | Not listed | No |
| Playback speed | Yes | Not listed | Not listed | Not listed | No |
| Pause other tabs automatically | Optional | Not listed | Not listed | Yes | No |
| Pause all | Yes | Not listed | Not listed | Not listed | No |
| Video call controls | Yes | Not listed | Not listed | Not listed | No |
| Skip ad, chapters | Yes, when the site supports them | Not listed | Not listed | Not listed | No |
| Keyboard shortcuts | Yes, can be global | Hardware media keys | Not listed | Not listed | No |
| Cast | No (not available to extensions) | Yes | Not listed | Not listed | No |
| Side panel | Yes | No, toolbar button | Yes | No, toolbar button | Vivaldi web panel |
| How it gets state | Page events, no polling | Browser internals | Not listed | Not listed | Injects a script into each media tab once a second |
| Open source | Yes (MIT) | Chromium | Not listed | Yes | Yes (MIT) |

Summary:

- **Chrome and Brave** have good built-in controls, including cast, which no extension can offer. Their documentation does not mention volume, speed, auto-pause, or pause all, which Cue has. In Vivaldi, which has no built-in media controls on desktop, Cue fills the gap.
- **Browser Media Controls** also works from a side panel and has seek and volume. It also connects to a desktop app and Stream Deck, which Cue does not.
- **Browser Player** focuses on one thing: pausing other tabs when one starts. Cue has this as an option.
- **vivaldi-media-panel** inspired Cue. Cue replaces its once-a-second polling with page events, and its per-site selectors with Media Session handlers. vivaldi-media-panel also docks into Vivaldi's tab bar with custom CSS, which Cue does not do.

Sources: [Chrome Help: control your music and videos](https://support.google.com/chrome/answer/9692215?hl=en), [Chrome picture-in-picture in media controls](https://mspoweruser.com/great-news-you-can-now-activate-the-picture-in-picture-mode-directly-from-the-global-media-controls-in-chrome/), [Brave media controls issue #12943](https://github.com/brave/brave-browser/issues/12943), [Vivaldi forum: media hub request](https://forum.vivaldi.net/topic/43572/media-control-feature-like-media-hub-of-chrome), [Vivaldi 8.3 release notes](https://vivaldi.com/blog/vivaldi-on-mobile-8-3/). Vivaldi 8.3 adds media controls for tabs on Android only.

## Site-specific code and fallbacks

Most of Cue uses web standards that do not depend on a site's design: media elements and the Media Session API. Some details need a site's page structure, and sites change their design. Each of those details has a chain of fallbacks. When a site changes, the first steps stop matching and Cue uses the next one. The card loses a detail; it does not break.

| What | Tried in this order |
| --- | --- |
| Title, when the site publishes none | Reddit `post-title` → enclosing article heading → element label → page `og:title` → tab title → host name |
| Artist line | the site's Media Session artist, unless it only names the site → Reddit `subreddit-prefixed-name` → `subreddit-name` → author → `og:site_name` |
| Artwork | the site's Media Session artwork → the video's poster image → the tab icon |
| YouTube track clock | the site's `setPositionState()` → YouTube player's progress → media element |
| YouTube volume | YouTube player's volume → media element volume |
| YouTube live | infinite duration → `setPositionState()` → YouTube player data → a duration longer than about 11 days |
| YouTube ad | player class `ad-showing` or `ad-interrupting` → ad overlay, countdown, or ad text element |
| YouTube Skip button | the site's `skipad` handler → known class names → any button in the ad area whose class contains "skip" |

The tests include a YouTube Skip button with an unknown class name, to check the last fallback.

## Privacy

Cue collects no data and makes no network requests. Playback state stays in your browser and is deleted when the browser closes. Cue also keeps your settings and the volume you chose for each site. See [PRIVACY.md](PRIVACY.md).

Cue asks for access to all sites because media can play on any site. It uses this access only to read playback state and to send the controls you click.

## Known limitations

- **The clock depends on the site.** Cue uses the site's own clock when the site publishes one with `navigator.mediaSession.setPositionState()`. On YouTube and YouTube Music, Cue reads the track clock from YouTube's player, because one media element plays the whole autoplay queue. On other sites Cue uses the media element's clock. A different site that plays a queue through one element, and publishes no clock, can show the wrong time after autoplay. The YouTube support is tested against a page that imitates YouTube's player, not against YouTube itself.
- **Cue wraps built-in page functions.** To see players and their handlers, Cue wraps `HTMLMediaElement.prototype.play` and the `MediaSession` methods in every page. There is no other way for an extension to get a site's Media Session handlers. The wrappers call the original functions and return their results. A site that checks for modified built-in functions can detect them.
- **Some audio is not detected.** Cue finds media when it plays, loads, or is in the page. When the browser marks a tab as playing sound and Cue knows nothing in it, Cue also searches open shadow roots. Cue cannot find media inside closed shadow roots, media that is never added to the page and starts without `play()`, or sound made only with the Web Audio API.
- **Sites can override the volume.** Some players keep their own volume setting and can replace the volume that Cue sets. On YouTube, Cue sets the volume through YouTube's player, so YouTube keeps it.
- **Skip ad, call controls, and chapters need site support.** These buttons appear only when the site registers the related Media Session handlers or chapter data. On YouTube, Cue finds ads and the Skip button from YouTube's player and page. If YouTube changes those, ad detection stops working until Cue is updated.
- **Live detection.** Cue treats media as live when the element reports an infinite duration, the site says so with `setPositionState()`, YouTube's player says so, or the duration is longer than about 11 days (live players often report placeholder durations of years). A live stream that reports an ordinary duration looks like a normal video.
- **Picture-in-picture is for video only.** Audio-only tabs do not show the button. Cue also hides it when a site turns picture-in-picture off for its video.
- **Casting is not available.** Browsers do not let extensions use their Cast feature.
- **The popup window itself.** Cue's page loads in a few tens of milliseconds. The remaining time between the click and the popup is the browser. In Vivaldi, a web panel opens faster than the toolbar popup because it stays loaded.

## Testing

### Automated

`npm test` loads the extension into Playwright's Chromium, opens local test pages that play audio and video, and drives Cue through its real panel. It checks:

- metadata, artwork, and the clock
- the YouTube player clock, seek, and volume, on a page that imitates YouTube's player
- clock correction when the page's clock jumps without a media event
- YouTube ads: the "Ad" label, seeking and 10-second skips off, and Skip ad
- titles from the page when a site publishes none: a Reddit-like post and a news article
- live streams: `LIVE`, the gap growing while paused, and Go live; and a site that declares live with `setPositionState()`
- media inside a shadow root (the test calls the audible-tab handler directly, because headless Chromium never marks a tab as audible)
- next and previous through Media Session handlers
- play, pause, seek, volume, speed, mute, and pause all
- keyboard shortcuts
- chapters, skip ad, and call controls
- picture-in-picture
- auto-pause and the settings page
- hiding a card, and removing cards when tabs close or reload
- volume memory per site
- the badge count
- that slow artwork does not delay the popup
- safety checks: volume memory leaves muted media muted, a page cannot change the site name on its card or outrank other frames, a paused background element does not take the controls from media in the page, a frame that stops answering is removed, and hidden cards are not shortcut targets

The tests use local test pages only. They do not use real sites.

### Manual

Before a release, check these on real sites:

| Site | Check |
| --- | --- |
| YouTube Music | Let two songs autoplay. Compare Cue's clock with the site's clock. Next and previous change the track. |
| YouTube | Play, pause, seek, and picture-in-picture work. During an ad, check whether **Skip ad** appears. Check whether a site volume set in Cue stays. |
| Spotify (web) | Next and previous change the track. The clock matches. |
| SoundCloud | Next and previous change the track. |
| Google Meet | During a call, the microphone, camera, and hang-up buttons work and show the correct state. |
| A live stream | The card shows `LIVE` and the seek bar is disabled. |
| Vivaldi | The toolbar popup is full width. The web panel works at `chrome-extension://<id>/panel.html`. |

## Development

```sh
npm install
npx playwright install chromium
npm test        # loads the extension into Chromium and drives it end to end
npm run icons   # rebuilds the PNG icons from extension/icon.svg
npm run package # writes cue.zip for the Chrome Web Store
```

The extension has no build step and no runtime dependencies. Playwright is used only for tests and icons.

## License

[MIT](LICENSE)
