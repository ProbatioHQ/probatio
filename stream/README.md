# The broadcaster

A browser running on a server, with a screen you can reach from anywhere. You
connect once, start the stream, and close the tab. It keeps going with your
machine off.

## Why it works this way

pump.fun streams from the browser. Accepting the moderation terms puts you live
immediately; there is no RTMP endpoint on the coin page to push video at. The
only way to get a page onto the stream is a real browser session that has a
wallet connected, has pressed Start livestream, and has shared a window.

None of that can be done by an encoder pointed at a URL, so the browser runs
here instead. The clicking is the same clicking you would do on a laptop. The
difference is which machine has to stay awake.

## Setting it up on Railway

1. **New Service** → **GitHub Repo** → this repo.
2. **Settings** → **Root Directory**: `stream`. Railway finds the Dockerfile.
3. **Settings** → **Networking** → **Generate Domain**. That URL is the screen.
4. **Variables**:

   | Variable       | Value                                                     |
   | -------------- | --------------------------------------------------------- |
   | `VNC_PASSWORD` | anything long. It is the only lock on the screen.          |
   | `STREAM_URL`   | optional, defaults to `https://probatiotrade.com/livestream` |

5. **Settings** → **Volumes** → add one mounted at `/profile`. Without it the
   wallet has to be set up again on every redeploy.
6. Deploy.

## Then, once

Open the service's URL, enter the password, and you are looking at a desktop
with Chromium on it, already showing the board and pump.fun.

1. Install a wallet extension and connect the creator wallet.
2. Open the coin page, **Start livestream**, accept the terms.
3. Click the share button, pick the window showing the board.
4. Close your tab.

The container holds the session. Nothing on your machine is involved after this.

## The part worth thinking about before you do it

The creator wallet ends up inside a browser on a server, and the only thing in
front of it is `VNC_PASSWORD`. Anyone who has that password, or who gets into
the container, has the wallet.

Use a long password, and keep nothing in that wallet beyond what it needs to be
the coin's creator. This is a real tradeoff rather than a formality, and it is
the price of the stream not depending on a laptop.

## If the stream drops

It has to be restarted by hand, through the same screen. That is the cost of
pump.fun having no RTMP endpoint: an encoder can reconnect on its own, a browser
session that was ended cannot.

## RTMP, if it ever comes back

`MODE=rtmp` with `RTMP_URL` and `STREAM_KEY` skips all of the above and pushes
the board straight at an endpoint, reconnecting on its own, with nothing to log
into. The code is there and correct. There is currently nowhere to point it.
