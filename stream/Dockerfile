# The broadcaster: a machine that stays awake so you do not have to.
#
# pump.fun streams from the browser. There is no RTMP endpoint to push to, so
# there is nothing to encode against: the only way in is a real browser session
# that has connected a wallet, pressed Start livestream, and shared a window.
#
# So this is that browser, running on a server, with a screen you can reach from
# anywhere. You do the clicking once. The container keeps holding the session
# open after you close the tab, which is the whole point: the stream stops
# depending on a laptop being open.
#
# Debian rather than Alpine: Chromium on musl is a fight over fonts and
# sandboxing that costs more than the disk it saves, and this image is pulled
# once and then runs for months.
FROM debian:bookworm-slim

# Xvfb is the screen nobody is looking at, openbox lets windows be moved and
# focused on it, x11vnc serves that screen, and websockify puts noVNC in front
# so it is reachable from a browser over Railway's HTTPS rather than a VNC
# client. nginx sits in front of all of it holding the password, because
# websockify's own auth plugin served the client page to anybody who asked.
# ffmpeg stays for the RTMP path, which is written and works if pump.fun ever
# offers an endpoint again.
#
# The fonts matter more than they look. Without them every glyph on the board
# renders as a box, and the first anybody would know is a screenshot.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11vnc \
      openbox \
      novnc \
      websockify \
      nginx-light \
      apache2-utils \
      ffmpeg \
      dbus-x11 \
      procps \
      xdg-utils \
      ca-certificates \
      fonts-liberation \
      fonts-dejavu-core \
      fontconfig \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY run.sh /app/run.sh
RUN chmod +x /app/run.sh

# The profile lives here so a Railway volume can be mounted over it. Without one
# the wallet has to be set up again on every redeploy, which turns a five minute
# job into a recurring one.
ENV HOME=/tmp \
    DISPLAY=:99 \
    CHROME_PROFILE=/profile

CMD ["/app/run.sh"]
