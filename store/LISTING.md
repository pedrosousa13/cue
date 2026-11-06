# Chrome Web Store listing

Copy each field into the [developer dashboard](https://chrome.google.com/webstore/devconsole). The dashboard takes plain text, so paste the description as it is.

## Package

Run `npm run package` and upload `cue.zip`.

## Store listing tab

**Title** (from the manifest): Cue: Media Controls for Every Tab

**Summary** (from the manifest): Control audio and video in every tab from the toolbar or the side panel.

**Category:** Productivity → Tools

**Language:** English

**Store icon:** `extension/icons/icon-128.png`

**Screenshots** (1280×800): `store/screenshot-1.png`, `store/screenshot-2.png`, `store/screenshot-3.png`

**Small promo tile** (440×280): `store/promo-small.png`

**Marquee promo tile** (1400×560): `store/promo-marquee.png`

**Homepage URL:** https://github.com/pedrosousa13/cue

**Support URL:** https://github.com/pedrosousa13/cue/issues

**Description:**

```
Cue lists every tab that plays audio or video and lets you control each one from the toolbar or the side panel. Music, podcasts, videos, live streams and video calls, all in one place.

WHAT YOU CAN DO
• Play, pause, and seek in any tab without switching to it
• Next and previous track on any site that supports media keys. Cue calls the site's own controls, so it works without per-site setup
• Change volume per tab. Cue remembers the volume for each site
• Change playback speed
• Open picture-in-picture for videos
• Pause all tabs at once, or let Cue pause other tabs when one starts playing
• Control video calls: microphone, camera, and hang up, on sites that support it
• Skip ads when the site offers a Skip button, and see chapters on sites that publish them
• Live streams show LIVE, how far behind you are, and a Go live button
• Keyboard shortcuts for play/pause, next, previous, and mute. They can work even when the browser is in the background
• Hide a card until that tab plays again
• Light and dark themes, full keyboard access, and screen reader labels

FAST AND LIGHT
Cue does not poll your tabs. Pages report only when playback changes, and the panel keeps the clock itself. The popup opens without waiting for artwork to download.

PRIVATE
Cue collects no data. Its only network requests download artwork, without cookies. Playback state stays in your browser and is deleted when the browser closes. Your settings and per-site volumes are stored in your browser only.

WHY CUE NEEDS ACCESS TO ALL SITES
Media can play on any site. Cue uses this access only to read what is playing and to send the controls that you click.

WORKS IN
Chrome, Brave, Edge, Vivaldi, and other Chromium browsers. In Vivaldi, Cue also works as a web panel.

Open source (MIT): https://github.com/pedrosousa13/cue
```

## Privacy practices tab

**Single purpose:**

```
Cue shows the audio and video playing in the user's tabs and lets the user control playback (play, pause, seek, track, volume, speed, picture-in-picture, call controls) from one panel.
```

**Permission justifications:**

`storage`
```
Keeps the list of tabs that play media while the browser is open (session storage, deleted when the browser closes), the user's settings, and the volume the user chose for each site.
```

`scripting`
```
Adds Cue's page script to tabs that were already open when Cue was installed, so they appear without a reload. Also starts picture-in-picture when the user clicks Cue's picture-in-picture button, which must run with that click.
```

`sidePanel`
```
Shows Cue's controls in the browser side panel, as an alternative to the toolbar popup.
```

Host permission (`<all_urls>`)
```
Media can play on any website. Cue runs a small script in pages to read what is playing (title, artist, artwork, position, playing or paused) and to carry out the controls the user clicks. It does not read or send any other page content.
```

**Are you using remote code?** No. All code is in the package.

**Data usage:** select none of the data types. Cue does not collect or transmit user data. Then confirm the three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/pedrosousa13/cue/blob/main/PRIVACY.md

## Distribution tab

- **Visibility:** Public
- **Regions:** All regions
- **Payment:** Free

## Before you submit

- [ ] `npm test` passes
- [ ] The version in `extension/manifest.json` is higher than the last uploaded version
- [ ] `npm run package` made a new `cue.zip`
- [ ] Screenshots match the current UI (`npm run store-assets` rebuilds them)
