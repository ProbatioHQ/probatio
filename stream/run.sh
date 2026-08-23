#!/usr/bin/env bash
#
# A browser on a server, and a screen you can reach to drive it.
#
# pump.fun streams from the browser. There is no RTMP endpoint on the coin page:
# accepting the moderation terms puts you live immediately, in browser mode, and
# the only way to get a page onto that stream is to share a window from a
# session that has a wallet connected. None of that can be done by an encoder
# pushing video at a URL.
#
# So the browser runs here instead. You connect once, do the clicking, and close
# the tab; the container holds the session open. The laptop stops mattering,
# which was the only thing wrong with doing it locally.
#
#   MODE=desktop   the above. The default, because it is the one that works.
#   MODE=rtmp      push the board straight to an RTMP endpoint. Kept because it
#                  is written and correct, and needs RTMP_URL and STREAM_KEY.
#
# Desktop mode wants:
#   VNC_PASSWORD   required. Eight characters and no more: VNC's scheme uses an
#                  eight byte key and silently truncates the rest, so a long
#                  passphrase here buys the confidence of a long password and
#                  the strength of its first eight letters.
#   WEB_PASSWORD   optional but wanted. A real password in front of the whole
#                  thing, checked before the VNC handshake is ever reached, and
#                  not subject to that truncation. Username is `probatio`.
#   PORT           set by Railway.
#
set -Euo pipefail

MODE="${MODE:-desktop}"
URL="${STREAM_URL:-https://probatiotrade.com/livestream}"
WIDTH="${STREAM_WIDTH:-1920}"
HEIGHT="${STREAM_HEIGHT:-1080}"
FPS="${STREAM_FPS:-30}"
BITRATE="${STREAM_BITRATE:-4500k}"
PROFILE="${CHROME_PROFILE:-/profile}"

say() { echo "[stream] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

cleanup() {
  say 'shutting down'
  pkill -P $$ 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# ---- the screen ------------------------------------------------------------

mkdir -p "$PROFILE"
Xvfb :99 -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp &
sleep 2

# ---- chromium --------------------------------------------------------------

# `--no-sandbox` because this is a container running as root whose only contents
# are the pages the sandbox would be protecting it from.
#
# `--disable-dev-shm-usage` because a container's /dev/shm is 64MB, Chromium
# will fill it, and it will then die hours later for no visible reason.
chrome_flags=(
  --no-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --no-first-run
  --no-default-browser-check
  --noerrdialogs
  --disable-session-crashed-bubble
  --disable-features=Translate,MediaRouter
  --autoplay-policy=no-user-gesture-required
  --user-data-dir="$PROFILE"
  --window-position=0,0
  --window-size="${WIDTH},${HEIGHT}"
)

start_chrome() {
  chromium "${chrome_flags[@]}" "$@" >/tmp/chromium.log 2>&1 &
  CHROME_PID=$!
  say "chromium started (pid $CHROME_PID)"
}

# ---- desktop: the browser, and a way in ------------------------------------

if [ "$MODE" = 'desktop' ]; then
  if [ -z "${VNC_PASSWORD:-}" ]; then
    say 'VNC_PASSWORD must be set.' >&2
    say 'This screen has a wallet on it. Without a password the URL is the' >&2
    say 'only thing between anyone on the internet and that wallet.' >&2
    exit 1
  fi

  # A window manager, so windows can be focused, moved and resized. Without one
  # every window is stuck at the top left with no title bar, which makes the
  # share-a-window step impossible to do.
  openbox &
  sleep 1

  # Kiosk is deliberately not used here: this session is driven by a person.
  start_chrome "$URL" 'https://pump.fun'

  mkdir -p /tmp/vnc
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vnc/passwd >/dev/null 2>&1
  x11vnc -display :99 -forever -shared -rfbauth /tmp/vnc/passwd \
         -rfbport 5900 -noxdamage -quiet &
  sleep 1

  say "screen ready on the service's public URL"
  say 'connect, connect the wallet, start the stream, share the board window'

  # websockify serves noVNC's page and proxies it to x11vnc, so the screen is
  # reachable over the HTTPS URL Railway already gives this service.
  #
  # A password in front of that, when one is set. This matters more than it
  # looks: the VNC password behind it is capped at eight characters by the
  # protocol, which is thin for something facing the internet with a wallet on
  # the other side. This one is checked first, is not truncated, and turns a
  # brute force from a script's afternoon into a waste of its time.
  auth=()
  if [ -n "${WEB_PASSWORD:-}" ]; then
    auth=(--auth-plugin=BasicHTTPAuth --auth-source="probatio:${WEB_PASSWORD}")
    say 'web password is set; the screen asks for it before anything else'
  else
    say 'WEB_PASSWORD is not set. The only lock is the eight character VNC one.' >&2
  fi

  exec websockify "${auth[@]}" --web=/usr/share/novnc "0.0.0.0:${PORT:-8080}" localhost:5900
fi

# ---- rtmp: kept for the day pump.fun offers an endpoint again ---------------

if [ -z "${RTMP_URL:-}" ] || [ -z "${STREAM_KEY:-}" ]; then
  say 'MODE=rtmp needs RTMP_URL and STREAM_KEY.' >&2
  exit 1
fi

TARGET="${RTMP_URL%/}/${STREAM_KEY}"
# The key must never reach a log: Railway keeps deploy logs, and a key in one is
# a stream anybody can take over.
say "target ${RTMP_URL%/}/****"

start_chrome --kiosk --app="$URL"
sleep 10

while true; do
  # A browser that has gone is a black rectangle being faithfully encoded and
  # pushed at four megabits, which from the outside looks exactly like a working
  # stream. Checked rather than trusted.
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    say 'chromium is gone, restarting it'
    start_chrome --kiosk --app="$URL"
    sleep 10
  fi

  say 'encoder starting'
  ffmpeg -hide_banner -loglevel warning \
    -f x11grab -draw_mouse 0 -framerate "$FPS" -video_size "${WIDTH}x${HEIGHT}" -i :99 \
    -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
    -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
    -b:v "$BITRATE" -maxrate "$BITRATE" -bufsize "$BITRATE" \
    -g "$((FPS * 2))" -keyint_min "$((FPS * 2))" -sc_threshold 0 \
    -c:a aac -b:a 128k -ar 44100 \
    -f flv "$TARGET" || true

  # Wait rather than spin: hammering a service that is refusing you is how an
  # address gets blocked.
  say 'encoder stopped, retrying in 10s'
  sleep 10
done
