# The broadcaster

Opens `/livestream` in a browser on a server, encodes what it draws, and pushes
it to pump.fun over RTMP. It exists so the stream does not depend on a laptop
being awake.

## Setting it up on Railway

1. In the same Railway project, **New Service** → **GitHub Repo** → this repo.
2. In that service's **Settings**:
   - **Root Directory**: `stream`
   - **Builder**: Dockerfile (Railway detects it from the root directory)
3. In **Variables**, add:

   | Variable     | Where it comes from                                        |
   | ------------ | ---------------------------------------------------------- |
   | `RTMP_URL`   | pump.fun coin page → Start livestream → RTMP → Stream URL   |
   | `STREAM_KEY` | the key shown next to that URL                              |

   Optional: `STREAM_URL` (defaults to `https://probatiotrade.com/livestream`),
   `STREAM_FPS` (30), `STREAM_BITRATE` (4500k), `STREAM_WIDTH`, `STREAM_HEIGHT`.

4. Deploy. It starts pushing within about fifteen seconds.

There is no port and no healthcheck: this is a worker, not a web service.

## What it does when things go wrong

Nothing here is fatal, because everything here happens at four in the morning
with nobody watching.

- **The encoder stops**, because the endpoint dropped the connection or the
  network went: waits ten seconds and reconnects. Waits rather than spins, since
  a tight loop against a service refusing you is how an address gets blocked.
- **The browser dies**: noticed on the next pass and restarted. Checked rather
  than assumed, because a dead browser is a black rectangle being encoded and
  pushed at four megabits, which from the outside looks exactly like a working
  stream.
- **The board is slow to answer**: it draws its own placeholder state, which is
  honest about not having read anything yet. Ten seconds are allowed before the
  encoder starts so the stream does not open on it.

## The stream key

Set it in Railway, never in the repository. The script prints the endpoint with
the key masked, because Railway keeps deploy logs and a key in one is a stream
anybody can take over.

## Cost

A 1080p30 encode keeps a CPU busy continuously. That is the whole bill, and it
is why this is a separate service rather than a thread inside the app: the site
should not be competing for CPU with a video encoder, and neither should be
scaled because of the other.

Dropping `STREAM_FPS` to 24 or `STREAM_BITRATE` to `3000k` costs little on a
board that is mostly still text, and saves a noticeable amount.
