# Bing Wallpaper for Linux Mint (Cinnamon)

[中文说明 / Chinese README](README.zh-CN.md)

A Cinnamon extension that downloads the Bing image of the day and sets it as your desktop wallpaper.

- Downloads the Bing homepage image every day (4K UHD by default) and applies it as the system wallpaper
- Region (China, US, Japan, … or follow the system language), resolution and picture aspect are configurable
- Retries automatically when the network is down, behind a proxy, or not ready yet at login; catches up as soon as the connection is back
- Saves images to `Pictures/BingWallpapers` (configurable) and prunes old ones (only files it created itself)
- Optional plain-text overlay in the top-right corner of the desktop showing the title, copyright and date of the current image (text color, text effect, characters per line and font size are adjustable)
- Notification with thumbnail, title and copyright when the wallpaper changes
- Settings buttons: refresh now, open the image description on Bing, open the wallpaper folder
- Translated UI (gettext, zh_CN included); tested on Linux Mint 22.3 / Cinnamon 6.6, compatible with Cinnamon 5.0–7.0 (libsoup 2 and 3)

## Layout

```
cinnamon-bing-wallpaper/
├── install.sh                          # install / update / uninstall helper
├── README.md                           # this file
├── README.zh-CN.md                     # Chinese documentation
└── bing-wallpaper@bigmalove/           # the extension itself (UUID = folder name)
    ├── metadata.json                   # name, author, compatible Cinnamon versions
    ├── extension.js                    # main logic
    ├── settings-schema.json            # settings dialog definition
    ├── stylesheet.css                  # styling of the image information shown on the desktop
    ├── icon.png / icon.svg             # icon
    └── po/                             # translations (zh_CN.po and the .pot template)
```

## Installation

```bash
bash install.sh            # copy to ~/.local/share/cinnamon/extensions/ and enable
bash install.sh status     # installed? enabled? current wallpaper, recent log lines
```

The first image is fetched a few seconds after the extension is enabled. Use `bash install.sh --no-enable`
if you prefer to enable it yourself in *System Settings → Extensions*.

Manual installation: copy the `bing-wallpaper@bigmalove` folder to `~/.local/share/cinnamon/extensions/`
and enable it in *System Settings → Extensions*. For a translated UI compile the catalog, e.g.
`msgfmt -o ~/.local/share/locale/zh_CN/LC_MESSAGES/bing-wallpaper@bigmalove.mo bing-wallpaper@bigmalove/po/zh_CN.po`.

## Settings

Open *System Settings → Extensions → Bing Wallpaper → configure (gear icon)*.

| Page | Option | Notes |
| --- | --- | --- |
| General | Bing region (market) | Default *Automatic*: derived from the system language (zh-CN on a Chinese system). Some regions publish a different image |
| General | Image resolution | Default 4K UHD; falls back to 1920x1200 / 1920x1080 when an image is not available in that size |
| General | Picture aspect | Maps to the system `picture-options` (zoom, scaled, stretched, centered, spanned, mosaic) or *keep the current system setting* |
| General | Show a notification when the wallpaper changes | Title, copyright and a thumbnail |
| General | Show image information on the desktop | Plain text in the top-right corner (below the panel) with title, copyright and date. It sits on the desktop behind windows. Adjustable: text color, text effect (none, shadow, strong shadow, glow, outline, background block), characters per line, font size |
| General | Buttons | Refresh now / Open the image description on Bing / Open the wallpaper folder |
| Storage and updates | Save wallpapers to | Empty = `~/Pictures/BingWallpapers` (follows the XDG Pictures directory) |
| Storage and updates | Number of downloaded images to keep | Default 30; only files named like `20260903_xxx.jpg` created by this extension are deleted |
| Storage and updates | Check for a new image every | Default 60 minutes. Bing publishes one image per day; a check is a tiny request |
| Storage and updates | Do not download on metered connections | Off by default |

## How it works

1. Requests `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=<region>` for today's image metadata.
2. Saves the image as `<date>_<image id>_<resolution>.jpg` (for example `20260903_Westerheversand_ZH-CN0517707643_UHD.jpg`); an existing file is not downloaded again.
3. Writes `org.cinnamon.desktop.background picture-uri` (and `picture-options`), then prunes old images.
   Cinnamon's built-in background slideshow is turned off if it is running, otherwise it would override the wallpaper immediately.
4. Checks again at the configured interval; after a failure it backs off 30 s → 60 s → 2 min → 5 min → 10 min → 30 min and shows one notification after three consecutive failures.
   A check is also triggered when the network comes back (NetworkMonitor signal).
5. Once today's image has been applied, a wallpaper you pick by hand is left alone for the rest of the day; the next new image replaces it.
   *Refresh now* always re-applies today's image.

HTTP requests go through GLib/libsoup and honour the system proxy (environment variables or *Network → Proxy*).

## Troubleshooting

- **The wallpaper does not change**: run `bash install.sh status` for the recent log lines, or look for lines prefixed with
  `[bing-wallpaper@bigmalove]` in `~/.xsession-errors`. Alt+F2, `lg` opens Melange with the same log.
- **I want a specific region**: switch *Bing region* from *Automatic* to a region; the image is fetched immediately.
- **Back to my old wallpaper**: disable the extension in *System Settings → Extensions* and pick a wallpaper in *Backgrounds*.
  Downloaded images stay in the wallpaper folder.

## Uninstall

```bash
bash install.sh uninstall           # disable and remove; keeps downloaded images and settings
bash install.sh uninstall --purge   # also remove the saved settings
```

## Development

```bash
bash install.sh --link     # install as a symlink to this checkout
bash install.sh reload     # ask Cinnamon (via DBus) to reload the extension after editing
```

Translations: edit `po/zh_CN.po` (or add another language) and run `bash install.sh` again; it compiles the catalogs into
`~/.local/share/locale/` with `msgfmt`. New strings can be extracted with `cinnamon-xlet-makepot` (needs `python3-polib`).

The buttons in the settings dialog call methods of the object returned by `enable()` (`onRefreshNow`, `onOpenBingPage`,
`onOpenFolder`), as declared in the `callback` fields of `settings-schema.json`.
