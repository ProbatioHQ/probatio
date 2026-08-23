#!/usr/bin/env bash
#
# One page, encoded and pushed, forever.
#
# The board is a web page and pump.fun wants RTMP, so something has to sit in
# between: a browser drawing onto a virtual screen and an encoder reading that
# screen back. Doing that on a laptop means the broadcast ends when the lid
# closes, which is the one thing a twenty four hour stream cannot do.
#
# Everything here is arranged around the assumption that it will be running
# unattended for months, so nothing is fatal. Chromium dying, ffmpeg dying, the
# RTMP endpoint dropping the connection: each of those is a thing that happens
# at four in the morning and each of them is recovered from without a person.
#
#   RTMP_URL    from pump.fun's Start livestream, RTMP mode
#   STREAM_KEY  the key it shows next to that URL
#   STREAM_URL  what to broadcast, defaults to the live board
#
set -Euo pipefail

URL="${STREAM_URL:-https://probatiotrade.com/livestream}"
WIDTH="${STREAM_WIDTH:-1920}"
HEIGHT="${STREAM_HEIGHT:-1080}"
FPS="${STREAM_FPS:-30}"
BITRATE="${STREAM_BITRATE:-4500k}"

if [ -z "${RTMP_URL:-}" ] || [ -z "${STREAM_KEY:-}" ]; then
  echo "[stream] RTMP_URL and STREAM_KEY must be set. Get both from the coin"
  echo "[stream] page on pump.fun: Start livestream, choose RTMP." >&2
  exit 1
fi

# Trailing slash or not, both are common and only one of them concatenates.
TARGET="${RTMP_URL%/}/${STREAM_KEY}"

say() { echo "[stream] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

# The key must never reach a log. Railway keeps build and deploy logs, and a
# stream key in one is a stream anybody can hijack.
say "target ${RTMP_URL%/}/****"
say "source $URL at ${WIDTH}x${HEIGHT} ${FPS}fps"

cleanup() {
  say 'shutting down'
  kill "${CHROME_PID:-}" "${XVFB_PID:-}" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# ---- the screen ------------------------------------------------------------

Xvfb :99 -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp &
XVFB_PID=$!
sleep 2

# ---- the browser -----------------------------------------------------------

start_chrome() {
  # `--no-sandbox` because this is a container running as root with nothing else
  # in it; the sandbox protects a desktop from a page, and here the page is the
  # only thing there is.
  #
  # `--disable-dev-shm-usage` because a container's /dev/shm is 64MB by default
  # and Chromium will fill it and die, hours in, for no visible reason.
  chromium \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --disable-software-rasterizer \
    --no-first-run \
    --no-default-browser-check \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=Translate,MediaRouter \
    --autoplay-policy=no-user-gesture-required \
    --hide-scrollbars \
    --window-position=0,0 \
    --window-size="${WIDTH},${HEIGHT}" \
    --kiosk \
    --app="$URL" \
    >/tmp/chromium.log 2>&1 &
  CHROME_PID=$!
  say "chromium started (pid $CHROME_PID)"
}

start_chrome
# The board reads its data before it can draw it, so the first seconds after a
# start are the placeholder state. Broadcasting those is not wrong, but waiting
# is free and it means the stream opens on something worth looking at.
sleep 10

# ---- the encoder, restarted for as long as this container lives ------------

while true; do
  # A browser that has gone is a black rectangle being faithfully encoded and
  # pushed at four megabits, which looks exactly like a working stream from the
  # outside. Checked on every pass rather than trusted.
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    say 'chromium is gone, restarting it'
    start_chrome
    sleep 10
  fi

  say 'encoder starting'

  # `anullsrc` because RTMP ingests generally reject a video-only stream, and a
  # silent track is cheap. `-g` twice the frame rate so a keyframe lands every
  # two seconds, which is what a player needs to be able to join partway in.
  ffmpeg -hide_banner -loglevel warning \
    -f x11grab -draw_mouse 0 -framerate "$FPS" -video_size "${WIDTH}x${HEIGHT}" -i :99 \
    -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
    -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
    -b:v "$BITRATE" -maxrate "$BITRATE" -bufsize "$BITRATE" \
    -g "$((FPS * 2))" -keyint_min "$((FPS * 2))" -sc_threshold 0 \
    -c:a aac -b:a 128k -ar 44100 \
    -f flv "$TARGET" || true

  # Reached whenever the encoder stops: the endpoint dropped us, the network
  # went, or pump.fun ended the stream. Wait rather than spin, because a tight
  # reconnect loop against a service that is refusing us is how an address gets
  # rate limited.
  say 'encoder stopped, retrying in 10s'
  sleep 10
done
