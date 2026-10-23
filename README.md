# Dhiraj-TV

A Samsung Smart TV app built with Tizen Studio that streams live IPTV channels from M3U/M3U8 playlists, navigable entirely with a TV remote.

## Original Credit : IPTV org
## Demo

[![Watch the demo](images/thumbnail.png)](https://www.youtube.com/watch?v=Uj-7Cc0Xxqk)

## Features

- **Multiple playlists, multiple active at once** — add any number of M3U/M3U8 playlist URLs in Settings, and toggle each one active/inactive independently with a checkbox. Categories from different active playlists are kept visually separate (grouped under a header per playlist) rather than merged together.
- **Built-in default playlist** — ships with the IPTV-ORG country-indexed catalog bundled locally (`playlists/index.country.m3u`), so channels are available even when the device has no route to an external host. A one-tap **"+ Add IPTV-ORG Open Channels"** button in Settings adds the live version of the same catalog fetched from `iptv-org.github.io`.
- **Categories & channel browsing** — channels are grouped by `group-title` into an alphabetical, two-column category list, then into a channel grid per category.
- **Favorites** — star any channel while watching it. Favorites persist independently of which playlists are active, but are only *shown* while their source playlist is active (deactivating a playlist hides its favorites without deleting them; deleting the playlist removes them for good).
- **Remote-control navigation** — a custom focus-zone system drives all navigation via D-pad (arrow keys + Enter/OK) and the remote's Back key; no mouse/pointer required. Includes Channel Up/Down zapping and Play/Pause from the remote.
- **AVPlay live DVR controls** — on Samsung TVs, the player queries `GET_LIVE_DURATION` rather than assuming a fixed archive length. Rewind, fast-forward, a configurable seek step (10 seconds through 5 minutes), a DVR timeline, and Go Live are disabled or bounded when the channel does not expose a reliable seek range.
- **Catch-up metadata retention** — common M3U catch-up and timeshift attributes are retained for future provider-specific playback. Catch-up is only advertised when a playlist supplies a recognizable recording URL template; the app does not invent archive URLs.
- **TV playback** via Samsung AVPlay on Tizen, with guarded native-video / [hls.js](https://github.com/video-dev/hls.js/) fallbacks for desktop browsers.
- **Support / Donate screen** — a QR code and link to a Stripe payment link for optional tips. The amount is donor-adjustable (starts at $1, no maximum).

## Requirements

- [Tizen Studio](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk.html) (or just the Tizen CLI tools under `tools/ide/bin` and `tools/`) with the `tv-samsung` platform installed.
- A Samsung TV or the Tizen TV emulator/simulator running Tizen 2.3+.
- A signing security profile registered with the Tizen CLI (`tizen security-profiles list` / `tizen security-profiles add`) to package and install the app.

## Project structure

```
config.xml           Tizen widget manifest (app id, privileges, profile)
index.html            App shell — all screens as <section> elements
css/style.css         All styling (focus states, layout, screens)
js/main.js            App logic: Focus/navigation, playlists, playback, favorites
playlists/            Bundled default M3U playlist (offline fallback)
images/               App art: donate banner, donate QR code, icons
icon.png              App icon
noun-live-tv-3548799.png   Widget icon referenced by config.xml
TVapp.wgt             Pre-built, signed package ready to sideload
```

## Building

From the project root:

```bash
# 1. Compile the web content into .buildResult/
tizen build-web -- .

# 2. Package .buildResult/ into a signed .wgt
tizen package -t wgt -s <your-security-profile> -- .buildResult
```

This produces `.buildResult/TVapp.wgt`.

## Installing on a device or emulator

```bash
# Connect to the TV/emulator (skip if already connected)
sdb connect <tv-ip-address>

# Install
tizen install -n TVapp.wgt -t <device-id> -- .buildResult
```

Alternatively, sideload the pre-built `TVapp.wgt` in this repo directly without building anything yourself.

## Notes on network dependence

Only the app shell and the bundled default playlist are guaranteed to work fully offline. Any playlist fetched from an external URL (including the IPTV-ORG "open channels" quick-add) requires network access from the TV/emulator; loads that hang are aborted after 15 seconds with an error toast rather than blocking the UI indefinitely. On Tizen, channel streams are opened by Samsung AVPlay rather than the HTML5 video element. Playback diagnostics log only a sanitized stream origin/path plus channel and lifecycle state.

## Validation

The bundled playlist can be checked without installing dependencies:

```bash
node tools/validate-playlist.js playlists/index.country.m3u
```

This checks that every `#EXTINF` entry has a following stream URL and reports the number of parsed channels.


