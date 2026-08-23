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
  # The profile lives on a volume that outlives the container, and Chromium
  # leaves a lock in it. After a restart that lock is still there, describing a
  # process that no longer exists, and Chromium refuses to open against it. The
  # screen comes up black and the log still says it started, because what
  # started was the shell's background job rather than a browser.
  rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket"

  chromium "${chrome_flags[@]}" "$@" >/tmp/chromium.log 2>&1 &
  CHROME_PID=$!

  # Proof rather than a PID. If it died on the way up, say so and say why,
  # instead of leaving a black rectangle and a reassuring log line.
  sleep 3
  if kill -0 "$CHROME_PID" 2>/dev/null; then
    say "chromium up (pid $CHROME_PID)"
  else
    say 'chromium exited on startup. Its last words:' >&2
    tail -n 5 /tmp/chromium.log >&2 || true
  fi
}

# ---- desktop: the browser, and a way in ------------------------------------

if [ "$MODE" = 'desktop' ]; then
  if [ -z "${VNC_PASSWORD:-}" ] || [ -z "${WEB_PASSWORD:-}" ]; then
    say 'VNC_PASSWORD and WEB_PASSWORD must both be set.' >&2
    say 'This screen has a wallet on it, and WEB_PASSWORD is the only lock on' >&2
    say 'it that the VNC protocol does not truncate to eight characters.' >&2
    say 'It used to be optional. It was optional for one deploy, and that' >&2
    say 'deploy served the screen to the internet without asking for anything.' >&2
    exit 1
  fi

  # A window manager, so windows can be focused, moved and resized. Without one
  # every window is stuck at the top left with no title bar, which makes the
  # share-a-window step impossible to do.
  openbox &
  sleep 1

  # A colour rather than the void, so a screen with no windows on it can be
  # told apart from a screen that is not being drawn at all.
  xsetroot -solid '#101418' 2>/dev/null || true

  # Kiosk is deliberately not used here: this session is driven by a person.
  start_chrome "$URL" 'https://pump.fun'

  # Kept alive for the length of the broadcast. Chromium dying at three in the
  # morning would otherwise end the stream and leave the container looking
  # perfectly healthy.
  (
    while true; do
      sleep 20
      if ! kill -0 "$CHROME_PID" 2>/dev/null; then
        say 'chromium went away, bringing it back'
        start_chrome "$URL" 'https://pump.fun'
      fi
    done
  ) &

  mkdir -p /tmp/vnc
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vnc/passwd >/dev/null 2>&1
  x11vnc -display :99 -forever -shared -rfbauth /tmp/vnc/passwd \
         -rfbport 5900 -noxdamage -quiet &
  sleep 1

  say "screen ready on the service's public URL"
  say 'connect, connect the wallet, start the stream, share the board window'

  #
  # A real proxy holding the password, rather than websockify's own.
  #
  # This was `websockify --auth-plugin=BasicHTTPAuth`, which starts without
  # complaint, logs nothing wrong, and serves the noVNC client to anybody who
  # asks. Checked from outside once it was up: the page returned 200 with no
  # WWW-Authenticate header anywhere. The screen was open to the internet with
  # only the eight character VNC password behind it, which is the exact thing
  # the outer password exists to avoid.
  #
  # So websockify no longer listens in public at all. It binds to loopback and
  # nginx takes the port, asks for the password on every path including the
  # websocket upgrade, and passes nothing through until it has one.
  #
  websockify --web=/usr/share/novnc 127.0.0.1:6080 localhost:5900 &
  sleep 1

  htpasswd -bc /tmp/htpasswd probatio "$WEB_PASSWORD" >/dev/null 2>&1

  cat >/tmp/nginx.conf <<NGINX
daemon off;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 256; }
http {
  access_log off;
  client_body_temp_path /tmp/nginx-body;
  proxy_temp_path /tmp/nginx-proxy;
  fastcgi_temp_path /tmp/nginx-fastcgi;
  uwsgi_temp_path /tmp/nginx-uwsgi;
  scgi_temp_path /tmp/nginx-scgi;

  server {
    listen ${PORT:-8080};

    # The root served a directory listing, because that is what websockify does
    # with a web root: it indexes the folder rather than opening the client in
    # it. Anybody arriving got a page of links and no way to know which one was
    # the screen.
    location = / {
      auth_basic           "probatio";
      auth_basic_user_file /tmp/htpasswd;
      return 302 /vnc.html?autoconnect=true&resize=remote;
    }

    location / {
      auth_basic           "probatio";
      auth_basic_user_file /tmp/htpasswd;

      proxy_pass http://127.0.0.1:6080;
      proxy_http_version 1.1;

      # The screen is a websocket. Without these it authenticates and then
      # hangs, which looks like a broken build rather than a missing header.
      proxy_set_header Upgrade    \$http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host       \$host;

      # A desktop session is idle for long stretches and must not be cut for it.
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
    }
  }
}
NGINX

  say 'password wall up; nothing is served without it'
  exec nginx -c /tmp/nginx.conf
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
