# Cue

Media controls for every tab. Cue lists every tab that plays audio or video, and lets you control each one from the toolbar or the side panel. It works in Chrome, Brave, Vivaldi, Edge, and other Chromium browsers.

## Features

- **Every tab, one list.** Title, artist, artwork, and site for each tab that plays media. Playing tabs come first.
- **Real next and previous.** Cue calls the site's own track handlers (the Media Session API), the same ones that your keyboard media keys use. This works on any site that supports media keys, with no per-site code. When a site has no track handlers, the buttons skip 10 seconds.
- **Seek bar and clock.** Drag to seek. Live streams show `LIVE` and do not seek. When a site publishes chapters, the seek bar marks them and the card names the current chapter.
- **Skip ad.** When a site registers a skip-ad handler, a **Skip ad** button appears.
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

## Privacy

Cue collects no data and makes no network requests. Playback state stays in your browser and is deleted when the browser closes. Cue also keeps your settings and the volume you chose for each site. See [PRIVACY.md](PRIVACY.md).

Cue asks for access to all sites because media can play on any site. It uses this access only to read playback state and to send the controls you click.

## Known limitations

- **The clock depends on the site.** Cue uses the site's own clock when the site publishes one with `navigator.mediaSession.setPositionState()`. Otherwise it uses the media element's clock. On players that put several tracks into one media element, the element's clock can show the wrong time after autoplay moves to the next track. This has not been checked on YouTube Music.
- **Cue wraps built-in page functions.** To see players and their handlers, Cue wraps `HTMLMediaElement.prototype.play` and the `MediaSession` methods in every page. The wrappers call the original functions and return their results. A site that checks for modified built-in functions can detect them.
- **Some audio is not detected.** Cue finds media when it plays, loads, or is in the page. A site that plays audio from an element that is never added to the page, and that starts it without `play()`, does not appear in Cue.
- **Sites can override the volume.** Some players, for example YouTube, keep their own volume setting and can replace the volume that Cue sets.
- **Skip ad, call controls, and chapters need site support.** These buttons appear only when the site registers the related Media Session handlers or chapter data.
- **Picture-in-picture is for video only.** Audio-only tabs do not show the button.
- **Casting is not available.** Browsers do not let extensions use their Cast feature.
- **The popup window itself.** Cue's page loads in a few tens of milliseconds. The remaining time between the click and the popup is the browser. In Vivaldi, a web panel opens faster than the toolbar popup because it stays loaded.

## Testing

### Automated

`npm test` loads the extension into Playwright's Chromium, opens local test pages that play audio and video, and drives Cue through its real panel. It checks:

- metadata, artwork, and the clock
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
