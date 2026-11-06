# Privacy policy

Cue does not collect, store, sell, or send any personal data.

## What Cue reads

To show and control media, Cue reads this information from tabs that play audio or video:

- The playback state: playing or paused, position, duration, volume, and speed.
- The media metadata that the site publishes: title, artist, album, and artwork URL.
- The tab title, the tab icon, and the site host name.

## Where it goes

This information stays in your browser. Cue keeps it in `chrome.storage.session`, which the browser deletes when it closes.

Cue also stores three things that last after the browser closes:

- **Your settings**, in `chrome.storage.sync`. If you turn on browser sync, your browser syncs them to your other devices.
- **The volume you chose for each site**, as a site host name and a number, in `chrome.storage.local`. This data does not leave your device. Turn off "Remember volume for each site" to stop this.
- **The height of the popup's list**, as one number, so the popup opens at the right size. No titles, sites, or other playback details are written to disk.

In private (incognito) windows, if you allow Cue there, Cue runs separately: private tabs never appear in Cue in normal windows, and their state is kept apart.

Cue does not send any of this to a server. The only network requests Cue makes are for artwork images: Cue downloads the image at the address that the site published, without cookies and without a referrer. Cue loads plain-http artwork only from the site's own host.

## Permissions

- **Access to all sites:** media can play on any site. Cue uses this access only to read the playback state and to send the controls that you click.
- **scripting:** to add Cue to tabs that were already open when you installed it, and to start picture-in-picture when you click its button.
- **storage:** to keep the list of media tabs while the browser is open, your settings, and the volume for each site.
- **sidePanel:** to show Cue in the browser side panel.

## Contact

Open an issue at https://github.com/pedrosousa13/cue/issues.
