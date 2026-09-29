#!/usr/bin/env bash
# Installs (or updates) the WiserHeat Control Panel as a service that starts at boot.
# See docs/LINUX.md.
#
# From a copy of the repository:      sudo ./linux/install.sh
# Straight from GitHub:               curl -fsSL https://raw.githubusercontent.com/BayMax1990/WiserHeat-ControlPanel/main/linux/install.sh | sudo bash
#
# Options:
#   --port <number>        Listen on another port (default 8765).
#   --password <password>  Set the sign-in password now, instead of on the first visit.
#   --version <tag|main>   With the download: which release to install (default: the latest).
#   --uninstall            Remove the service and the app. Keeps your settings and data.
#   --purge                With --uninstall: also delete settings, data and the service user.
#
# Running it again updates the panel and keeps your settings and data.

set -euo pipefail

REPO="BayMax1990/WiserHeat-ControlPanel"
NAME="wiserheat-panel"
APP_DIR="/opt/$NAME"
DATA_DIR="/var/lib/$NAME"
ENV_FILE="/etc/$NAME.env"
UNIT_FILE="/etc/systemd/system/$NAME.service"
SERVICE_USER="wiserheat"
MIN_NODE=18

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

PORT="" PASSWORD="" VERSION="" UNINSTALL=0 PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port)      PORT="${2:-}"; shift 2 ;;
    --password)  PASSWORD="${2:-}"; shift 2 ;;
    --version)   VERSION="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge)     PURGE=1; shift ;;
    -h|--help)   sed -n '2,17p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           die "Unknown option: $1 (try --help)" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "Run this with sudo."
command -v systemctl >/dev/null && [ -d /run/systemd/system ] || die "This needs a Linux system that uses systemd."

# --- Uninstall ------------------------------------------------------------------------------

if [ "$UNINSTALL" = 1 ]; then
  say "Removing the WiserHeat Control Panel service…"
  systemctl disable --now "$NAME" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload
  rm -rf "$APP_DIR"
  if [ "$PURGE" = 1 ]; then
    rm -rf "$DATA_DIR" "$ENV_FILE"
    id "$SERVICE_USER" >/dev/null 2>&1 && userdel "$SERVICE_USER" 2>/dev/null || true
    say "Removed, including settings, data and the $SERVICE_USER user."
  else
    say "Removed. Your settings and data are still in $DATA_DIR (and options in $ENV_FILE)."
    echo "To delete those too, run this again with --uninstall --purge."
  fi
  exit 0
fi

if [ -n "$PORT" ]; then
  case "$PORT" in *[!0-9]*|"") die "--port needs a number" ;; esac
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be between 1 and 65535"
fi
if [ -n "$PASSWORD" ] && [ "${#PASSWORD}" -lt 8 ]; then die "--password needs at least 8 characters"; fi

# --- Node.js --------------------------------------------------------------------------------

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if ! command -v node >/dev/null || [ "$(node_major)" -lt "$MIN_NODE" ]; then
  if command -v apt-get >/dev/null; then
    say "Installing Node.js…"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  fi
fi
command -v node >/dev/null || die "Node.js $MIN_NODE or newer is needed. Install it (see https://nodejs.org/en/download), then run this again."
[ "$(node_major)" -ge "$MIN_NODE" ] || die "Node.js $(node -v) is too old; $MIN_NODE or newer is needed. On older Raspberry Pi OS or Debian, install a newer one from https://github.com/nodesource/distributions, then run this again."
NODE="$(readlink -f "$(command -v node)")"
case "$NODE" in
  /home/*|/root/*) die "Node.js is installed in a home folder ($NODE), for example by nvm, which the service isn't allowed to read. Install Node.js for the whole system (with apt, or from NodeSource), then run this again." ;;
esac

# --- The panel's files ----------------------------------------------------------------------

# Use the copy this script sits in, if there is one; otherwise download a release from GitHub.
SRC=""
SCRIPT="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT" ] && [ -f "$SCRIPT" ]; then
  HERE="$(cd "$(dirname "$SCRIPT")/.." && pwd)"
  [ -f "$HERE/server.js" ] && [ -d "$HERE/public" ] && [ -f "$HERE/linux/$NAME.service" ] && SRC="$HERE"
fi

TMP=""
cleanup() { if [ -n "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT

if [ -z "$SRC" ]; then
  command -v curl >/dev/null || die "curl is needed to download the panel (sudo apt install curl)."
  command -v tar >/dev/null || die "tar is needed to unpack the panel."
  if [ -z "$VERSION" ]; then
    # No releases yet (or GitHub unreachable) isn't fatal: fall back to the main branch.
    VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true)"
    [ -n "$VERSION" ] || VERSION="main"
  fi
  case "$VERSION" in main) URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz" ;;
                     *)    URL="https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz" ;; esac
  say "Downloading the panel ($VERSION)…"
  TMP="$(mktemp -d)"
  curl -fsSL "$URL" | tar -xz -C "$TMP" --strip-components=1 || die "Couldn't download $URL"
  if [ ! -f "$TMP/linux/$NAME.service" ]; then
    [ "$VERSION" = main ] && die "The version on GitHub doesn't include the Linux service yet."
    die "Version $VERSION doesn't include the Linux service yet. Try --version main."
  fi
  SRC="$TMP"
fi

UPDATING=0
[ -f "$APP_DIR/server.js" ] && UPDATING=1

say "$([ "$UPDATING" = 1 ] && echo Updating || echo Installing) the panel in $APP_DIR…"
id "$SERVICE_USER" >/dev/null 2>&1 || \
  useradd --system --user-group --no-create-home --home-dir "$DATA_DIR" --shell "$(command -v nologin || echo /usr/sbin/nologin)" "$SERVICE_USER"
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/server.js" "$APP_DIR/public"
cp "$SRC/server.js" "$APP_DIR/"
cp -r "$SRC/public" "$APP_DIR/"
chown -R root:root "$APP_DIR"
chmod -R u=rwX,go=rX "$APP_DIR"

# --- Options file ---------------------------------------------------------------------------

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# Options for the WiserHeat Control Panel service. After changing them:
#   sudo systemctl restart wiserheat-panel
#
# The port to listen on (default 8765):
# PORT=8765
#
# Set the sign-in password, instead of creating it on the first visit. While this is set, the
# password can't be changed in the panel's Settings:
# PANEL_PASSWORD=
EOF
fi
set_option() { # name value
  if grep -q "^#\? *$1=" "$ENV_FILE"; then sed -i "s|^#\? *$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}
[ -n "$PORT" ] && set_option PORT "$PORT"
[ -n "$PASSWORD" ] && set_option PANEL_PASSWORD "$PASSWORD"
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

# --- The service ----------------------------------------------------------------------------

sed -e "s|@NODE@|$NODE|" -e 's/\r$//' "$SRC/linux/$NAME.service" > "$UNIT_FILE"
chmod 644 "$UNIT_FILE"
systemctl daemon-reload
systemctl enable "$NAME" >/dev/null 2>&1
systemctl restart "$NAME"

# --- Check it's answering -------------------------------------------------------------------

PORT_NOW="$(sed -n 's/^PORT=\([0-9]*\).*/\1/p' "$ENV_FILE" | tail -1)"
PORT_NOW="${PORT_NOW:-8765}"
ok=0
for _ in $(seq 1 20); do
  if node -e "fetch('http://127.0.0.1:$PORT_NOW/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then ok=1; break; fi
  sleep 1
done
if [ "$ok" != 1 ]; then
  warn "The service didn't start answering. Here's its log:"
  journalctl -u "$NAME" -n 20 --no-pager >&2 || true
  exit 1
fi

echo
say "The WiserHeat Control Panel is running, and will start by itself whenever this machine boots."
echo "Open it from any device on your network:"
for ip in $(hostname -I 2>/dev/null); do
  case "$ip" in *:*) ;; *) echo "  http://$ip:$PORT_NOW" ;; esac
done
echo "  http://$(hostname).local:$PORT_NOW   (if your network supports .local names)"
echo
if grep -q '^PANEL_PASSWORD=.' "$ENV_FILE"; then
  echo "Sign in with the password you set."
elif [ "$UPDATING" = 0 ]; then
  echo "The first person to open it is asked to create a password, then a setup screen connects it to your hub."
fi
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  warn "The ufw firewall is on. To let other devices in, run: sudo ufw allow $PORT_NOW/tcp"
fi
echo "Settings and data: $DATA_DIR    Options: $ENV_FILE    Log: journalctl -u $NAME"
