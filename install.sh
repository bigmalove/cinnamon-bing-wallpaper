#!/usr/bin/env bash
#
# Bing Wallpaper - Cinnamon extension: install / update / remove for the current user.
#
# Usage:
#   ./install.sh                    install (or update) and enable the extension
#   ./install.sh --no-enable        install (or update) only
#   ./install.sh --link             install as a symlink to this folder (handy for development)
#   ./install.sh reload             reload the running extension after editing its code
#   ./install.sh enable | disable   turn the extension on / off
#   ./install.sh status             show whether it is installed/enabled and the last log lines
#   ./install.sh uninstall          disable and remove the extension (keeps wallpapers and settings)
#   ./install.sh uninstall --purge  ... and also remove the saved settings
set -euo pipefail

UUID="bing-wallpaper@bigmalove"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/$UUID"
DEST_ROOT="$HOME/.local/share/cinnamon/extensions"
DEST="$DEST_ROOT/$UUID"
LOCALE_ROOT="$HOME/.local/share/locale"
CONFIG_DIRS=("$HOME/.config/cinnamon/spices/$UUID" "$HOME/.cinnamon/configs/$UUID")

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '3,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

is_enabled() {
    gsettings get org.cinnamon enabled-extensions 2>/dev/null | grep -qF "'$UUID'"
}

# set_enabled add|remove  - edit the org.cinnamon enabled-extensions list
set_enabled() {
    python3 - "$UUID" "$1" <<'PY'
import ast, subprocess, sys
uuid, action = sys.argv[1:3]
raw = subprocess.check_output(["gsettings", "get", "org.cinnamon", "enabled-extensions"], text=True).strip()
if raw.startswith("@as"):
    raw = raw.split(None, 1)[1]
current = list(ast.literal_eval(raw)) if raw else []
if action == "add" and uuid not in current:
    current.append(uuid)
elif action == "remove":
    current = [u for u in current if u != uuid]
value = "[" + ", ".join("'%s'" % u for u in current) + "]"
subprocess.check_call(["gsettings", "set", "org.cinnamon", "enabled-extensions", value])
PY
}

reload_running() {
    is_enabled || return 0
    if command -v dbus-send >/dev/null 2>&1; then
        info "Reloading the running extension"
        dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon \
            org.Cinnamon.ReloadXlet string:"$UUID" string:"EXTENSION" \
            || warn "Reload failed. Restart Cinnamon instead (Ctrl+Alt+Esc)."
    else
        warn "dbus-send not found. Restart Cinnamon (Ctrl+Alt+Esc) to load the new code."
    fi
}

compile_translations() {
    if ! command -v msgfmt >/dev/null 2>&1; then
        warn "msgfmt not found (sudo apt install gettext). Skipping translations; the UI will be in English."
        return
    fi
    local po lang
    for po in "$SRC"/po/*.po; do
        [ -e "$po" ] || continue
        lang="$(basename "$po" .po)"
        mkdir -p "$LOCALE_ROOT/$lang/LC_MESSAGES"
        msgfmt -o "$LOCALE_ROOT/$lang/LC_MESSAGES/$UUID.mo" "$po"
        info "Installed translation: $lang"
    done
}

remove_translations() {
    local mo
    for mo in "$LOCALE_ROOT"/*/LC_MESSAGES/"$UUID".mo; do
        [ -e "$mo" ] && rm -f "$mo"
    done
    return 0
}

do_install() {   # $1 = copy|link   $2 = yes|no (enable)
    [ -f "$SRC/metadata.json" ] || die "Cannot find $SRC/metadata.json"
    command -v cinnamon >/dev/null 2>&1 || warn "Cinnamon does not seem to be installed on this system."

    mkdir -p "$DEST_ROOT"
    local was_enabled=no
    is_enabled && was_enabled=yes
    if [ -e "$DEST" ] || [ -L "$DEST" ]; then rm -rf "$DEST"; fi

    if [ "$1" = link ]; then
        ln -s "$SRC" "$DEST"
        info "Linked $DEST -> $SRC"
    else
        cp -r "$SRC" "$DEST"
        chmod -R u+rwX,go+rX "$DEST"
        info "Copied the extension to $DEST"
    fi
    compile_translations

    if [ "$was_enabled" = yes ]; then
        reload_running
    elif [ "$2" = yes ]; then
        set_enabled add
        info "Extension enabled. The first Bing image is fetched within a few seconds."
    else
        info "Not enabled. Enable it in System Settings -> Extensions, or run: $0 enable"
    fi
    info "Settings: System Settings -> Extensions -> Bing Wallpaper -> configure (gear icon)"
}

do_uninstall() {   # $1 = yes|no (purge settings)
    if is_enabled; then
        set_enabled remove
        info "Extension disabled"
    fi
    rm -rf "$DEST"
    remove_translations
    if [ "$1" = yes ]; then
        local d
        for d in "${CONFIG_DIRS[@]}"; do rm -rf "$d"; done
        info "Saved settings removed"
    fi
    info "Uninstalled. Downloaded wallpapers were left in place."
}

do_status() {
    if [ -L "$DEST" ]; then echo "Installed: $DEST -> $(readlink "$DEST")"
    elif [ -d "$DEST" ]; then echo "Installed: $DEST"
    else echo "Installed: no"; fi
    if is_enabled; then echo "Enabled:   yes"; else echo "Enabled:   no"; fi
    echo "Wallpaper: $(gsettings get org.cinnamon.desktop.background picture-uri 2>/dev/null || echo unknown)"
    local cfg
    for cfg in "$HOME/.config/cinnamon/spices/$UUID/$UUID.json" "$HOME/.cinnamon/configs/$UUID/$UUID.json"; do
        [ -f "$cfg" ] && echo "Settings:  $cfg"
    done
    if [ -f "$HOME/.xsession-errors" ]; then
        echo "Recent log lines:"
        grep -F "[$UUID]" "$HOME/.xsession-errors" | tail -n 10 | sed 's/^/  /' || true
    fi
}

CMD=install
MODE=copy
ENABLE=yes
PURGE=no
for arg in "$@"; do
    case "$arg" in
        install|uninstall|enable|disable|reload|status) CMD="$arg" ;;
        --link) MODE=link ;;
        --no-enable) ENABLE=no ;;
        --purge) PURGE=yes ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown argument: $arg (try --help)" ;;
    esac
done

case "$CMD" in
    install)   do_install "$MODE" "$ENABLE" ;;
    uninstall) do_uninstall "$PURGE" ;;
    enable)    [ -e "$DEST" ] || die "Not installed. Run: $0 install"; set_enabled add; info "Extension enabled" ;;
    disable)   set_enabled remove; info "Extension disabled" ;;
    reload)    is_enabled || die "The extension is not enabled"; reload_running ;;
    status)    do_status ;;
esac
