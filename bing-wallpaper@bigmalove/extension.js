/*
 * Bing Wallpaper - Cinnamon extension
 *
 * Downloads the Bing "image of the day" and sets it as the desktop background.
 * Works on Cinnamon 5.x (libsoup 2.4) and Cinnamon 6.x (libsoup 3).
 *
 * Lifecycle: init() -> enable() -> ... -> disable()
 * The object returned by enable() exposes the callbacks used by the buttons in
 * settings-schema.json (onRefreshNow, onShowInfo, onOpenBingPage, onOpenFolder).
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Soup = imports.gi.Soup;
const Gettext = imports.gettext;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const ByteArray = imports.byteArray;

const UUID = "bing-wallpaper@bigmalove";

const BING_BASE_URL = "https://www.bing.com";
const ARCHIVE_URL = BING_BASE_URL + "/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) Cinnamon BingWallpaper/1.0";

const BACKGROUND_SCHEMA = "org.cinnamon.desktop.background";
const SLIDESHOW_SCHEMA = "org.cinnamon.desktop.background.slideshow";

// Tried in order when the configured resolution is not available for an image.
const FALLBACK_RESOLUTIONS = ["1920x1200", "1920x1080"];
// Back-off delays (seconds) after consecutive failures.
const RETRY_DELAYS = [30, 60, 120, 300, 600, 1800];
// Notify the user once a failure streak reaches this length.
const FAILURES_BEFORE_NOTIFY = 3;
// Give the desktop a moment to settle after login / enable before the first check.
const STARTUP_DELAY = 5;
// "network-changed" fires in bursts; wait this long before reacting.
const NETWORK_DEBOUNCE = 10;
// Only files matching this pattern (the ones we create) are ever deleted.
const IMAGE_FILE_PATTERN = /^\d{8}_.+\.jpe?g$/i;

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(str) {
    let translated = Gettext.dgettext(UUID, str);
    return translated !== str ? translated : Gettext.gettext(str);
}

function logInfo(msg) {
    global.log("[" + UUID + "] " + msg);
}

function logWarn(msg) {
    if (typeof global.logWarning === "function")
        global.logWarning("[" + UUID + "] " + msg);
    else
        global.log("[" + UUID + "] WARNING: " + msg);
}

function logError(msg) {
    global.logError("[" + UUID + "] " + msg);
}

function bytesToString(bytes) {
    return ByteArray.toString(ByteArray.fromGBytes(bytes));
}

/**
 * Minimal async HTTP GET client that hides the libsoup 2 / libsoup 3 differences.
 * Callbacks receive (error, GLib.Bytes).
 */
class HttpClient {
    constructor() {
        this._session = new Soup.Session({ user_agent: USER_AGENT, timeout: 60 });
        if (Soup.MAJOR_VERSION === 2) {
            // libsoup 2 only honours the system proxy when explicitly asked to.
            Soup.Session.prototype.add_feature.call(this._session, new Soup.ProxyResolverDefault());
        }
    }

    get(url, callback) {
        let message = Soup.Message.new("GET", url);
        if (!message) {
            callback(new Error("Invalid URL: " + url));
            return;
        }

        if (Soup.MAJOR_VERSION === 2) {
            this._session.queue_message(message, (session, msg) => {
                if (msg.status_code !== 200) {
                    callback(new Error("HTTP " + msg.status_code + " " + (msg.reason_phrase || "")));
                    return;
                }
                let bytes = msg.response_body_data || msg.response_body.flatten().get_as_bytes();
                callback(null, bytes);
            });
            return;
        }

        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            let bytes;
            try {
                bytes = session.send_and_read_finish(result);
            } catch (e) {
                callback(e);
                return;
            }
            let status = message.get_status();
            if (status !== Soup.Status.OK) {
                callback(new Error("HTTP " + status + " " + (message.get_reason_phrase() || "")));
                return;
            }
            callback(null, bytes);
        });
    }

    abort() {
        this._session.abort();
    }
}

class BingWallpaperExtension {
    constructor(metadata) {
        this.metadata = metadata;

        this._http = new HttpClient();
        this._background = new Gio.Settings({ schema_id: BACKGROUND_SCHEMA });
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkSignalId = 0;
        this._timerId = 0;
        this._networkDebounceId = 0;
        this._busy = false;
        this._queued = null;
        this._failures = 0;
        this._lastSuccess = 0;
        this._enabled = false;

        this.settings = new Settings.ExtensionSettings(this, UUID);
        this.settings.bind("market", "market", () => this._onSourceChanged());
        this.settings.bind("resolution", "resolution", () => this._onSourceChanged());
        this.settings.bind("picture-options", "pictureOptions", () => this._applyPictureOptions());
        this.settings.bind("notify-on-change", "notifyOnChange");
        this.settings.bind("save-dir", "saveDirSetting", () => this._onSaveDirChanged());
        this.settings.bind("keep-count", "keepCount", () => this._pruneOldImages());
        this.settings.bind("check-interval", "checkInterval", () => this._scheduleCheck());
        this.settings.bind("skip-metered", "skipMetered");
        // Persisted state about the image currently in use.
        this.settings.bind("last-date", "lastDate");
        this.settings.bind("last-file", "lastFile");
        this.settings.bind("last-title", "lastTitle");
        this.settings.bind("last-copyright", "lastCopyright");
        this.settings.bind("last-link", "lastLink");
    }

    /* ---------------------------------------------------------------- lifecycle */

    enable() {
        this._enabled = true;
        this._networkSignalId = this._networkMonitor.connect("network-changed",
            (monitor, available) => this._onNetworkChanged(available));
        this._scheduleCheck(STARTUP_DELAY);
        logInfo("Enabled (libsoup " + Soup.MAJOR_VERSION + ")");
    }

    disable() {
        this._enabled = false;
        this._clearTimer();
        if (this._networkDebounceId) {
            GLib.source_remove(this._networkDebounceId);
            this._networkDebounceId = 0;
        }
        if (this._networkSignalId) {
            this._networkMonitor.disconnect(this._networkSignalId);
            this._networkSignalId = 0;
        }
        this._http.abort();
        this._busy = false;
        this._queued = null;
        this.settings.finalize();
        logInfo("Disabled");
    }

    /* ------------------------------------------------- settings button callbacks */

    onRefreshNow() {
        this.checkForNewWallpaper({ reapply: true, interactive: true });
    }

    onShowInfo() {
        if (!this.lastFile) {
            this._notify(_("Bing Wallpaper"), _("No Bing image has been downloaded yet."));
            return;
        }
        let file = Gio.File.new_for_path(this.lastFile);
        let body = this.lastCopyright || "";
        body += (body ? "\n" : "") + this.lastFile;
        this._notify(this.lastTitle || _("Bing Wallpaper"), body, file);
    }

    onOpenBingPage() {
        if (!this.lastLink) {
            this._notify(_("Bing Wallpaper"), _("No Bing image has been downloaded yet."));
            return;
        }
        this._openUri(this.lastLink);
    }

    onOpenFolder() {
        try {
            this._openUri(this._getSaveDir(true).get_uri());
        } catch (e) {
            logWarn("Could not open the wallpaper folder: " + e.message);
        }
    }

    /* ------------------------------------------------------------ scheduling */

    _intervalSeconds() {
        let minutes = parseInt(this.checkInterval, 10);
        if (isNaN(minutes) || minutes < 1)
            minutes = 60;
        return minutes * 60;
    }

    _scheduleCheck(delaySeconds) {
        this._clearTimer();
        if (!this._enabled)
            return;
        if (delaySeconds === undefined)
            delaySeconds = this._intervalSeconds();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delaySeconds, () => {
            this._timerId = 0;
            this.checkForNewWallpaper({});
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _onNetworkChanged(available) {
        if (!available || !this._enabled)
            return;
        if (this._networkDebounceId)
            GLib.source_remove(this._networkDebounceId);
        this._networkDebounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, NETWORK_DEBOUNCE, () => {
            this._networkDebounceId = 0;
            let ageSeconds = (GLib.get_monotonic_time() - this._lastSuccess) / 1000000;
            if (this._failures > 0 || this._lastSuccess === 0 || ageSeconds > this._intervalSeconds())
                this.checkForNewWallpaper({});
            return GLib.SOURCE_REMOVE;
        });
    }

    _onSourceChanged() {
        if (this._enabled)
            this.checkForNewWallpaper({ reapply: true });
    }

    _onSaveDirChanged() {
        if (this._enabled)
            this.checkForNewWallpaper({});
    }

    /* ---------------------------------------------------------- main routine */

    /**
     * options.reapply     - set the wallpaper even if today's image was already applied
     * options.interactive - triggered by the user: always give feedback via a notification
     */
    checkForNewWallpaper(options) {
        options = options || {};
        if (!this._enabled)
            return;

        if (this._busy) {
            // Merge with whatever is already waiting and run it when the current check ends.
            let queued = this._queued || {};
            this._queued = {
                reapply: !!(queued.reapply || options.reapply),
                interactive: !!(queued.interactive || options.interactive)
            };
            return;
        }

        if (this.skipMetered && !options.interactive && this._networkMonitor.get_network_metered()) {
            logInfo("Metered connection, skipping this check");
            this._scheduleCheck();
            return;
        }

        this._busy = true;
        let market = this._resolveMarket();
        let url = ARCHIVE_URL + encodeURIComponent(market);
        logInfo("Checking " + url);

        this._http.get(url, (error, bytes) => {
            if (error) {
                this._finish(error, options);
                return;
            }
            let info;
            try {
                info = this._parseArchive(bytes);
            } catch (e) {
                this._finish(e, options);
                return;
            }
            this._processImage(info, options);
        });
    }

    _resolveMarket() {
        if (this.market && this.market !== "auto")
            return this.market;
        let names = GLib.get_language_names();
        for (let i = 0; i < names.length; i++) {
            let match = /^([a-z]{2,3})_([A-Z]{2})/.exec(names[i]);
            if (match)
                return match[1] + "-" + match[2];
        }
        return "en-US";
    }

    _parseArchive(bytes) {
        let data = JSON.parse(bytesToString(bytes));
        if (!data || !data.images || !data.images.length)
            throw new Error("Bing returned no image");
        let image = data.images[0];
        if (!image.urlbase || !image.startdate)
            throw new Error("Unexpected Bing response format");

        // urlbase looks like "/th?id=OHR.Westerheversand_ZH-CN0517707643"
        let idMatch = /id=([^&]+)/.exec(image.urlbase);
        let id = idMatch ? idMatch[1] : (image.hsh || "image");
        id = id.replace(/^OHR\./, "").replace(/[^A-Za-z0-9._-]/g, "_");

        return {
            date: String(image.startdate),
            urlbase: image.urlbase,
            id: id,
            title: image.title || "",
            copyright: image.copyright || "",
            link: image.copyrightlink || ""
        };
    }

    _fileNameFor(info) {
        return info.date + "_" + info.id + "_" + this.resolution + ".jpg";
    }

    _processImage(info, options) {
        let file;
        try {
            file = this._getSaveDir(true).get_child(this._fileNameFor(info));
        } catch (e) {
            this._finish(e, options);
            return;
        }

        if (file.query_exists(null)) {
            if (this.lastFile === file.get_path() && !options.reapply) {
                // Today's image is already in place. If the user picked another wallpaper
                // by hand in the meantime we leave it alone until a new image arrives.
                this._finish(null, options, { file: file, info: info, changed: false });
                return;
            }
            let changed = this._applyWallpaper(file, info);
            this._finish(null, options, { file: file, info: info, changed: changed });
            return;
        }

        let resolutions = [this.resolution].concat(
            FALLBACK_RESOLUTIONS.filter((r) => r !== this.resolution));
        this._downloadImage(info, resolutions, file, (error) => {
            if (error) {
                this._finish(error, options);
                return;
            }
            logInfo("Downloaded " + file.get_path());
            let changed = this._applyWallpaper(file, info);
            this._finish(null, options, { file: file, info: info, changed: changed });
        });
    }

    _downloadImage(info, resolutions, file, callback) {
        let resolution = resolutions[0];
        let url = BING_BASE_URL + info.urlbase + "_" + resolution + ".jpg";

        this._http.get(url, (error, bytes) => {
            if (error) {
                if (resolutions.length > 1 && /^HTTP 4\d\d/.test(error.message)) {
                    logWarn("Resolution " + resolution + " not available (" + error.message.trim() + "), trying " + resolutions[1]);
                    this._downloadImage(info, resolutions.slice(1), file, callback);
                    return;
                }
                callback(error);
                return;
            }

            let data = bytes.get_data();
            if (!data || data.length < 1024 || data[0] !== 0xFF || data[1] !== 0xD8) {
                callback(new Error("Downloaded data is not a JPEG image"));
                return;
            }

            // replace_contents writes to a temporary file and renames it, so a
            // half-written image never ends up as the wallpaper.
            file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, result) => {
                    try {
                        f.replace_contents_finish(result);
                    } catch (e) {
                        callback(e);
                        return;
                    }
                    callback(null);
                });
        });
    }

    _applyWallpaper(file, info) {
        let uri = file.get_uri();

        // Cinnamon's built-in slideshow would immediately override us.
        try {
            let slideshow = new Gio.Settings({ schema_id: SLIDESHOW_SCHEMA });
            if (slideshow.get_boolean("slideshow-enabled")) {
                slideshow.set_boolean("slideshow-enabled", false);
                logInfo("Turned off the Cinnamon background slideshow");
            }
        } catch (e) {
            // schema not present on this Cinnamon version - nothing to do
        }

        let changed = this._background.get_string("picture-uri") !== uri;
        if (changed)
            this._background.set_string("picture-uri", uri);
        this._applyPictureOptions();

        this.lastDate = info.date;
        this.lastFile = file.get_path();
        this.lastTitle = info.title;
        this.lastCopyright = info.copyright;
        this.lastLink = info.link;

        if (changed)
            logInfo("Wallpaper set to " + file.get_path());

        this._pruneOldImages();
        return changed;
    }

    _applyPictureOptions() {
        if (!this.pictureOptions || this.pictureOptions === "keep")
            return;
        try {
            if (this._background.get_string("picture-options") !== this.pictureOptions)
                this._background.set_string("picture-options", this.pictureOptions);
        } catch (e) {
            logWarn("Could not apply picture aspect '" + this.pictureOptions + "': " + e.message);
        }
    }

    _finish(error, options, result) {
        this._busy = false;

        if (error) {
            this._failures++;
            let delay = RETRY_DELAYS[Math.min(this._failures - 1, RETRY_DELAYS.length - 1)];
            delay = Math.min(delay, this._intervalSeconds());
            logWarn("Update failed (" + error.message + "), retrying in " + delay + "s");
            if (options.interactive || this._failures === FAILURES_BEFORE_NOTIFY) {
                this._notify(_("Could not update the Bing wallpaper"),
                    String(error.message).trim() + "\n" + _("It will be retried automatically."));
            }
            this._scheduleCheck(delay);
        } else {
            this._failures = 0;
            this._lastSuccess = GLib.get_monotonic_time();
            if (result)
                this._report(result, options);
            this._scheduleCheck();
        }

        if (this._queued && this._enabled) {
            let queued = this._queued;
            this._queued = null;
            this.checkForNewWallpaper(queued);
        }
    }

    _report(result, options) {
        let info = result.info;
        if (result.changed) {
            if (options.interactive || this.notifyOnChange)
                this._notify(info.title || _("Bing Wallpaper"), info.copyright, result.file);
        } else if (options.interactive) {
            let body = info.title ? info.title + "\n" + info.copyright : info.copyright;
            this._notify(_("The wallpaper is already up to date"), body, result.file);
        }
    }

    /* ----------------------------------------------------------- file handling */

    _getSaveDir(create) {
        let value = (this.saveDirSetting || "").trim();
        let dir;

        if (!value) {
            let pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir();
            dir = Gio.File.new_for_path(GLib.build_filenamev([pictures, "BingWallpapers"]));
        } else if (value.indexOf("://") !== -1) {
            dir = Gio.File.new_for_uri(value);
        } else {
            if (value.charAt(0) === "~")
                value = GLib.get_home_dir() + value.substring(1);
            dir = Gio.File.new_for_path(value);
        }

        if (!dir.get_path())
            throw new Error("The wallpaper folder must be on the local file system: " + value);

        if (create && !dir.query_exists(null)) {
            try {
                dir.make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches || !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw e;
            }
        }
        return dir;
    }

    _pruneOldImages() {
        let keep = parseInt(this.keepCount, 10);
        if (isNaN(keep) || keep < 1)
            keep = 1;

        let dir;
        try {
            dir = this._getSaveDir(false);
        } catch (e) {
            return;
        }
        if (!dir.query_exists(null))
            return;

        let names = [];
        try {
            let enumerator = dir.enumerate_children("standard::name,standard::type",
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                if (fileInfo.get_file_type() !== Gio.FileType.REGULAR)
                    continue;
                let name = fileInfo.get_name();
                if (IMAGE_FILE_PATTERN.test(name))
                    names.push(name);
            }
            enumerator.close(null);
        } catch (e) {
            logWarn("Could not list the wallpaper folder: " + e.message);
            return;
        }

        // File names start with YYYYMMDD, so sorting puts the oldest first.
        names.sort();
        let current = this.lastFile ? GLib.path_get_basename(this.lastFile) : null;
        let excess = names.length - keep;
        for (let i = 0; i < names.length && excess > 0; i++) {
            if (names[i] === current)
                continue;
            try {
                dir.get_child(names[i]).delete(null);
                excess--;
                logInfo("Removed old image " + names[i]);
            } catch (e) {
                logWarn("Could not remove " + names[i] + ": " + e.message);
            }
        }
    }

    /* ------------------------------------------------------------------- misc */

    _openUri(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch (e) {
            Util.spawnCommandLine("xdg-open " + GLib.shell_quote(uri));
        }
    }

    _notify(title, body, imageFile) {
        try {
            let source = new MessageTray.Source(_("Bing Wallpaper"));
            let size = source.ICON_SIZE || 48;
            let icon = null;
            if (imageFile) {
                try {
                    icon = St.TextureCache.get_default().load_uri_async(imageFile.get_uri(), size, size);
                } catch (e) {
                    icon = null;
                }
            }
            if (!icon) {
                icon = new St.Icon({
                    icon_name: "preferences-desktop-wallpaper",
                    icon_type: St.IconType.FULLCOLOR,
                    icon_size: size
                });
            }
            let notification = new MessageTray.Notification(source, title, body || "", { icon: icon });
            notification.setTransient(true);
            Main.messageTray.add(source);
            source.notify(notification);
        } catch (e) {
            logWarn("Could not show a notification: " + e.message);
        }
    }
}

/* ------------------------------------------------------------ entry points */

let extensionMeta = null;
let extension = null;

function init(metadata) {
    extensionMeta = metadata;
}

function enable() {
    extension = new BingWallpaperExtension(extensionMeta);
    extension.enable();
    // Returning the instance makes its on* methods available to the settings dialog buttons.
    return extension;
}

function disable() {
    if (extension) {
        extension.disable();
        extension = null;
    }
}
