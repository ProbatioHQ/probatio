# The broadcaster: a browser and an encoder, and nothing else.
#
# This container's whole job is to open one page, point a video encoder at it,
# and push the result to an RTMP endpoint until told to stop. It runs on a
# server so that the stream does not depend on somebody's laptop being awake,
# which is the difference between a twenty four hour broadcast and a demo.
#
# Debian rather than an Alpine image: Chromium on musl is a fight over fonts and
# sandboxing that costs more than the two hundred megabytes it saves, and this
# image is pulled once and then runs for months.
FROM debian:bookworm-slim

# Chromium draws the page, Xvfb gives it a screen to draw on since there is no
# monitor attached to a container, and ffmpeg reads that screen back out.
# The fonts matter more than they look: without them every glyph on the board
# renders as a box, and the first anybody would know is a screenshot of the
# stream.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      xvfb \
      dbus-x11 \
      procps \
      ca-certificates \
      fonts-liberation \
      fonts-dejavu-core \
      fontconfig \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY run.sh /app/run.sh
RUN chmod +x /app/run.sh

# Chromium writes a great deal of cache, and a container's default /dev/shm is
# 64MB, which it will exhaust and then crash. The run script disables shared
# memory use for exactly this reason; this is the second half of that.
ENV HOME=/tmp \
    DISPLAY=:99

CMD ["/app/run.sh"]
