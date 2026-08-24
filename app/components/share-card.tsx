'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Turning a closed trade into an image somebody will actually post.
 *
 * WHY IT IS DRAWN IN THE BROWSER
 *
 * The picture on the card is the trader's own, and it never leaves their
 * machine. Nothing is uploaded, nothing is stored, and there is no moderation
 * queue, because there is no moment at which this site is holding somebody
 * else's image. A server-rendered version would mean accepting arbitrary
 * uploads onto a volume that has filled up once already, and taking on the job
 * of deciding what people may put behind our logo. Composing locally avoids all
 * of that and is also simply faster: the preview updates as they scrub.
 *
 * WHAT THEY CANNOT CHANGE
 *
 * The chrome. The mark, the wordmark, the word PAPER, the numbers, and the line
 * telling a reader where to check the record are drawn after their picture and
 * cannot be moved or removed. A card is worth posting because of what it can
 * prove, and a version with the proof cropped off would be worth nothing to
 * anybody except somebody trying to pass paper gains off as real ones.
 *
 * PAPER IS SAID PLAINLY, ON PURPOSE
 *
 * It is the loudest word on the card after the number. Not because a rule
 * demands it, but because a card that looks exactly like a real profit and is
 * not one will eventually be posted as though it were, and the first time
 * somebody is caught doing that it becomes this project's reputation. It is
 * also the pitch: paper money, real prices, and a record anybody can check.
 */

export interface TradeCardData {
  leafHash: string;
  mint: string;
  name: string;
  symbol: string;
  image: string | null;
  invested: string;
  proceeds: string;
  realized: string;
  returnBps: number;
  heldMs: number;
  closedAt: number;
  feesPaid: string;
  worstImpactBps: number;
  fills: number;
}

/* 1200x675 is 16:9, which is what X shows inline without cropping anybody's
   face off. Drawn at 2x for a crisp download. */
const W = 1200;
const H = 675;
const SCALE = 2;

/** The margin every column of the card is set against. */
const PAD = 64;

/** Frames a second for the animated card. */
const FPS = 30;

/**
 * Backgrounds for somebody who has no picture in mind.
 *
 * A card with nothing behind it looks unfinished, and asking for a file before
 * anything can be posted is a step most people will not take. These are the
 * default rather than an extra: the card is worth posting the moment it opens,
 * and a picture replaces the wash for anybody who wants one.
 */
const BACKGROUNDS: ReadonlyArray<{ id: string; label: string; from: string; to: string }> = [
  { id: 'ink', label: 'Ink', from: '#111a22', to: '#05070a' },
  { id: 'moss', label: 'Moss', from: '#0e4a30', to: '#04090b' },
  { id: 'ember', label: 'Ember', from: '#4a1f15', to: '#08060a' },
  { id: 'dusk', label: 'Dusk', from: '#222c52', to: '#05070c' },
  { id: 'violet', label: 'Violet', from: '#33184c', to: '#07060c' },
];

/**
 * How wide the percentage is, so the multiple can sit beside it.
 *
 * Measured with the same font it is drawn in and then restored, because
 * `measureText` reads whatever font the context happens to be carrying and the
 * badge landing on top of the number is the failure that produces.
 */
function measurePct(ctx: CanvasRenderingContext2D, pct: string): number {
  const previous = ctx.font;
  const spacing = ctx.letterSpacing;
  ctx.font = '800 132px Geist, system-ui, sans-serif';
  ctx.letterSpacing = '-6px';
  const width = ctx.measureText(pct).width;
  ctx.font = previous;
  ctx.letterSpacing = spacing;
  return width;
}

/**
 * How long an animated card runs.
 *
 * Five seconds. A picked GIF does not say how long its own loop is in any way a
 * page can read without decoding the whole file, so this records a fixed window
 * and lets the loop fall where it does. Long enough for any avatar-sized
 * animation to come round at least once, short enough to stay under every
 * timeline's patience and every upload limit.
 */
const CLIP_MS = 5_000;

/**
 * What to record into, best first.
 *
 * MP4 is first because it is what every timeline wants and what an iPhone can
 * open without being asked twice. Recent Chrome and Safari can produce it
 * directly; older ones cannot, and fall to WebM, which X also accepts. The list
 * is walked rather than assumed, because guessing wrong here throws inside the
 * recorder rather than at the point the choice was made.
 */
const CLIP_TYPES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function clipType(): string | null {
  /*
   * Both halves, not just the recorder. Safari shipped MediaRecorder well
   * before it shipped `captureStream` on a canvas, so checking only the first
   * offers a button that throws the moment it is pressed.
   */
  if (typeof MediaRecorder === 'undefined') return null;
  if (typeof HTMLCanvasElement === 'undefined') return null;
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null;
  return CLIP_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

const INK = '#07090b';
const SUNKEN = '#040506';
const LINE = '#1b232b';
const TEXT = '#eaecef';
const DIM = '#99a0ab';
const FAINT = '#727a86';
const GAIN = '#3fe08a';
const LOSS = '#ff5f56';

function sol(lamports: string): string {
  const value = Number(BigInt(lamports)) / 1e9;
  const abs = Math.abs(value);
  return `${value < 0 ? '-' : ''}${abs < 1 ? abs.toFixed(3) : abs.toFixed(2)}`;
}

function held(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

/** Cover-fit, so a picture of any shape fills its box without being squashed. */
function cover(
  ctx: CanvasRenderingContext2D,
  art: CanvasImageSource,
  aw: number,
  ah: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (aw <= 0 || ah <= 0) return;
  const scale = Math.max(w / aw, h / ah);
  const dw = aw * scale;
  const dh = ah * scale;
  ctx.drawImage(art, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Hand a blob to the browser as a download.
 *
 * The object URL is released on a later turn rather than immediately after the
 * click. Revoking it in the same tick races the download that was just started,
 * and the browsers where it loses are not the one this was written in: the file
 * simply never arrives, with nothing logged anywhere to say why.
 */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Whether a picked file actually moves.
 *
 * By its bytes, not by its type. Plenty of GIFs and WebPs hold a single frame,
 * and calling one of those animated puts a Download video button on a still
 * picture and a note under the card claiming it plays. A GIF that loops carries
 * a NETSCAPE2.0 application block; an animated WebP carries an ANIM chunk.
 * Both sit in the first few hundred bytes, so this reads the head of the file
 * rather than the whole of it.
 */
async function movesOnItsOwn(file: File): Promise<boolean> {
  if (file.type !== 'image/gif' && file.type !== 'image/webp') return false;
  try {
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    const text = String.fromCharCode(...head);
    return file.type === 'image/gif' ? text.includes('NETSCAPE2.0') : text.includes('ANIM');
  } catch {
    return false;
  }
}

export function ShareCard({ trade, onClose }: { trade: TradeCardData; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [picture, setPicture] = useState<HTMLImageElement | null>(null);
  const [pictureName, setPictureName] = useState<string | null>(null);
  const [animated, setAnimated] = useState(false);
  const [logo, setLogo] = useState<HTMLImageElement | null>(null);
  /** The token's own art, drawn as a badge beside its name. */
  const [art, setArt] = useState<HTMLImageElement | null>(null);
  const [background, setBackground] = useState(BACKGROUNDS[0]!);
  /*
   * The object URL behind the current picture, so the previous one can be let
   * go. It cannot be released when the image loads: the canvas redraws from
   * that image on every frame, and revoking it early blanks an animation
   * mid-clip. So it is held for exactly as long as the picture is the picture.
   */
  const pictureUrl = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Non-null while a clip is being recorded, as a countdown to show. */
  const [recording, setRecording] = useState<number | null>(null);

  // Whatever picture is being held goes with the card when it closes.
  useEffect(() => () => {
    if (pictureUrl.current) URL.revokeObjectURL(pictureUrl.current);
  }, []);

  /* The mark, loaded once. Everything else on the card is drawn. */
  useEffect(() => {
    const mark = new Image();
    mark.onload = () => setLogo(mark);
    mark.src = '/probatio-logo.png';
  }, []);

  /*
   * The token's own art, as a badge beside its name rather than as the
   * background. It says which coin this was at a glance, and it is the one
   * picture on the card nobody had to go and find.
   */
  useEffect(() => {
    if (!trade.image) return;
    const badge = new Image();
    badge.crossOrigin = 'anonymous';
    badge.onload = () => setArt(badge);
    badge.src = `/api/card-art?mint=${encodeURIComponent(trade.mint)}`;
  }, [trade.image, trade.mint]);

  const draw = useCallback(() => {
    const node = canvas.current;
    const ctx = node?.getContext('2d');
    if (!node || !ctx) return;

    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const up = trade.returnBps >= 0;
    const accent = up ? GAIN : LOSS;

    /*
     * The background is the whole card, not a panel on one side of it.
     *
     * The first version boxed the picture into the right third, which made every
     * card look like a form with a photo stapled to it. Full bleed with the
     * chrome laid over a scrim is what a card people actually repost looks like,
     * and it is the only arrangement where somebody's own picture is the thing
     * you see first.
     */
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, W, H);

    if (picture) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.clip();
      cover(ctx, picture, picture.naturalWidth, picture.naturalHeight, 0, 0, W, H);
      ctx.restore();
    } else {
      /*
       * Lit from the right, which is the half the text does not use.
       *
       * A corner-to-corner wash put its brightest point under the column of
       * copy, where the scrim then had to cover it up, so every preset looked
       * like the same near-black rectangle. Anchoring the light where nothing is
       * written means the colour somebody picked is the part of the card they
       * can actually see.
       */
      const wash = ctx.createRadialGradient(W * 0.82, H * 0.34, 40, W * 0.82, H * 0.34, W * 0.86);
      wash.addColorStop(0, background.from);
      wash.addColorStop(1, background.to);
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, W, H);
    }

    /*
     * The scrim. Two of them, because one cannot do both jobs: a left-to-right
     * fade so the column of text has ground under it whatever the picture is
     * doing, and a floor so the seal at the bottom never lands on a bright
     * patch. The parts that cannot be removed are exactly the parts that have to
     * stay legible over a picture nobody here chose.
     */
    const across = ctx.createLinearGradient(0, 0, W * 0.86, 0);
    across.addColorStop(0, 'rgba(5,7,9,0.96)');
    across.addColorStop(0.52, 'rgba(5,7,9,0.82)');
    across.addColorStop(1, 'rgba(5,7,9,0.10)');
    ctx.fillStyle = across;
    ctx.fillRect(0, 0, W, H);

    const floor = ctx.createLinearGradient(0, H - 210, 0, H);
    floor.addColorStop(0, 'rgba(5,7,9,0)');
    floor.addColorStop(1, 'rgba(5,7,9,0.92)');
    ctx.fillStyle = floor;
    ctx.fillRect(0, H - 210, W, 210);

    /*
     * The mark again, large and nearly invisible, where the copy does not go.
     *
     * Only when there is no picture. Without it the right half of a card with a
     * plain background is simply empty, and an empty half reads as a layout that
     * did not finish rather than as space. With a picture there, this would be
     * one thing too many.
     */
    if (!picture && logo) {
      const size = 460;
      const ratio = logo.naturalWidth / logo.naturalHeight;
      ctx.save();
      ctx.globalAlpha = 0.05;
      ctx.drawImage(logo, W - size * ratio + 96, H / 2 - size / 2, size * ratio, size);
      ctx.restore();
    }

    // ---- the mark, the wordmark, and the word that has to be there ----------
    let markRight = PAD;
    if (logo) {
      const lh = 38;
      const lw = (logo.naturalWidth / logo.naturalHeight) * lh;
      ctx.drawImage(logo, PAD, 46, lw, lh);
      markRight = PAD + lw;
    }
    ctx.fillStyle = TEXT;
    ctx.font = '600 15px "Geist Mono", ui-monospace, monospace';
    ctx.letterSpacing = '7px';
    ctx.fillText('PROBATIO', markRight + 18, 71);
    ctx.letterSpacing = '0px';

    /*
     * PAPER, level with the wordmark rather than tucked underneath it.
     *
     * This is the word that keeps the card honest when it is reposted with the
     * caption stripped off, so it sits in the same glance as the brand.
     */
    const paperX = markRight + 168;
    ctx.strokeStyle = 'rgba(234,236,239,0.24)';
    ctx.lineWidth = 1;
    roundRect(ctx, paperX, 47, 148, 30, 15);
    ctx.stroke();
    ctx.fillStyle = DIM;
    ctx.font = '500 12.5px "Geist Mono", ui-monospace, monospace';
    ctx.letterSpacing = '2.5px';
    ctx.fillText('PAPER MONEY', paperX + 17, 67);
    ctx.letterSpacing = '0px';

    // ---- the token ---------------------------------------------------------
    let nameX = PAD;
    if (art) {
      const size = 62;
      ctx.save();
      ctx.beginPath();
      ctx.arc(PAD + size / 2, 196 - size / 2 + 6, size / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      cover(ctx, art, art.naturalWidth, art.naturalHeight, PAD, 196 - size + 6, size, size);
      ctx.restore();
      ctx.strokeStyle = 'rgba(234,236,239,0.16)';
      ctx.beginPath();
      ctx.arc(PAD + size / 2, 196 - size / 2 + 6, size / 2, 0, Math.PI * 2);
      ctx.stroke();
      nameX = PAD + size + 20;
    }

    ctx.fillStyle = TEXT;
    ctx.font = '700 38px Geist, system-ui, sans-serif';
    ctx.fillText(trade.symbol.slice(0, 14), nameX, 182);
    ctx.fillStyle = FAINT;
    ctx.font = '500 18px Geist, system-ui, sans-serif';
    ctx.fillText(trade.name.slice(0, 32), nameX, 208);

    // ---- the number, which is what somebody came for -----------------------
    const pct = `${up ? '+' : ''}${(trade.returnBps / 100).toFixed(1)}%`;
    ctx.font = '800 132px Geist, system-ui, sans-serif';
    ctx.letterSpacing = '-6px';
    /*
     * A glow under the figure rather than around every element. It is the one
     * thing on the card allowed to shout, and on a busy picture it is also what
     * stops the number dissolving into whatever is behind it.
     */
    ctx.save();
    ctx.shadowColor = up ? 'rgba(63,224,138,0.42)' : 'rgba(255,95,86,0.38)';
    ctx.shadowBlur = 46;
    ctx.fillStyle = accent;
    ctx.fillText(pct, PAD - 4, 336);
    ctx.restore();
    ctx.letterSpacing = '0px';

    /*
     * The multiple, beside the percentage, because it is the shape people
     * actually say out loud. Only on a win: nobody describes a loss as 0.4x.
     */
    const multiple = Number(BigInt(trade.proceeds)) / Math.max(1, Number(BigInt(trade.invested)));
    if (up && multiple >= 1.1) {
      const label = `${multiple.toFixed(multiple >= 10 ? 0 : 1)}x`;
      ctx.font = '700 34px Geist, system-ui, sans-serif';
      const width = ctx.measureText(label).width;
      const boxX = PAD + ctx.measureText('').width + measurePct(ctx, pct) + 26;
      ctx.strokeStyle = 'rgba(63,224,138,0.42)';
      ctx.lineWidth = 1.5;
      roundRect(ctx, boxX, 288, width + 34, 50, 12);
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.fillText(label, boxX + 17, 324);
    }

    // ---- in, out, held -----------------------------------------------------
    const facts: [string, string][] = [
      ['IN', `${sol(trade.invested)} SOL`],
      ['OUT', `${sol(trade.proceeds)} SOL`],
      ['HELD', held(trade.heldMs)],
    ];
    facts.forEach(([key, value], index) => {
      const x = PAD + index * 172;
      ctx.fillStyle = FAINT;
      ctx.font = '500 12.5px "Geist Mono", ui-monospace, monospace';
      ctx.letterSpacing = '2px';
      ctx.fillText(key, x, 400);
      ctx.letterSpacing = '0px';
      ctx.fillStyle = TEXT;
      ctx.font = '600 28px Geist, system-ui, sans-serif';
      ctx.fillText(value, x, 436);
    });

    /*
     * What it cost to make, which is the half every other card leaves out.
     *
     * A card showing the multiple and hiding the exit describes a trade nobody
     * could have made. This line is the difference between a screenshot and a
     * record, so it is set in the trade's own colour rather than left as grey
     * small print.
     */
    ctx.strokeStyle = 'rgba(234,236,239,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, 476.5);
    ctx.lineTo(PAD + 620, 476.5);
    ctx.stroke();

    ctx.fillStyle = DIM;
    ctx.font = '500 19px Geist, system-ui, sans-serif';
    ctx.fillText(
      `After ${sol(trade.feesPaid)} SOL of fees and ${trade.worstImpactBps} bps of price impact`,
      PAD,
      512,
    );

    // ---- the seal ----------------------------------------------------------
    ctx.fillStyle = TEXT;
    ctx.font = '600 16px "Geist Mono", ui-monospace, monospace';
    ctx.fillText('probatiotrade.com/verify', PAD, 588);
    if (trade.leafHash) {
      ctx.fillStyle = FAINT;
      ctx.font = '500 13.5px "Geist Mono", ui-monospace, monospace';
      ctx.fillText(`sealed ${trade.leafHash.slice(0, 28)}`, PAD, 614);
    }
  }, [trade, picture, logo, art, background]);

  useEffect(() => {
    draw();
  }, [draw]);

  /*
   * An animated picture keeps moving, so what somebody picked is what they see,
   * and so there is something for the recorder below to record.
   *
   * A browser advances an animated image on its own and `drawImage` takes
   * whatever frame it is currently showing, so redrawing on a timer is the
   * whole of the animation. At thirty a second rather than the twelve this
   * started at: twelve is visibly choppy once it is a video somebody posts.
   */
  useEffect(() => {
    if (!animated || !picture) return;
    const timer = setInterval(draw, 1000 / FPS);
    return () => clearInterval(timer);
  }, [animated, picture, draw]);

  function release(): void {
    if (pictureUrl.current) URL.revokeObjectURL(pictureUrl.current);
    pictureUrl.current = null;
  }

  function choose(file: File | undefined): void {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const art = new Image();
    art.onload = () => {
      release();
      pictureUrl.current = url;
      setPicture(art);
      setPictureName(file.name);
      void movesOnItsOwn(file).then(setAnimated);
    };
    art.onerror = () => URL.revokeObjectURL(url);
    art.src = url;
  }

  const stem = `probatio-${trade.symbol.toLowerCase().replace(/[^a-z0-9]/g, '') || 'trade'}`;

  function download(): void {
    const node = canvas.current;
    if (!node) return;
    node.toBlob((blob) => {
      if (blob) saveBlob(blob, `${stem}.png`);
    }, 'image/png');
  }

  /*
   * The animated card, recorded off the canvas rather than re-encoded.
   *
   * The obvious route was to decode the picked GIF's frames, composite the card
   * onto each one and write a GIF back out. That was the wrong route twice
   * over: it is a decoder and an encoder to get right, and a GIF holds 256
   * colours a frame, which is nowhere near enough for the antialiased type this
   * card is mostly made of. The text would have come back speckled.
   *
   * Recording the canvas keeps the type exactly as drawn, costs no dependency,
   * and produces a file X plays inline. What it gives up is a true GIF, and
   * nothing on a timeline needs one.
   */
  function record(): void {
    const node = canvas.current;
    const type = clipType();
    if (!node || !type) return;

    const stream = node.captureStream(FPS);
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      setRecording(null);
      for (const track of stream.getTracks()) track.stop();
      if (chunks.length === 0) return;
      saveBlob(new Blob(chunks, { type }), `${stem}.${type.startsWith('video/mp4') ? 'mp4' : 'webm'}`);
    };

    setRecording(Math.ceil(CLIP_MS / 1000));
    const countdown = setInterval(() => {
      setRecording((left) => (left === null || left <= 1 ? left : left - 1));
    }, 1000);

    recorder.start();
    setTimeout(() => {
      clearInterval(countdown);
      if (recorder.state !== 'inactive') recorder.stop();
    }, CLIP_MS);
  }

  async function copy(): Promise<void> {
    const node = canvas.current;
    if (!node) return;
    try {
      await new Promise<void>((resolve, reject) => {
        node.toBlob((blob) => {
          if (!blob) return reject(new Error('no image'));
          navigator.clipboard
            .write([new ClipboardItem({ 'image/png': blob })])
            .then(() => resolve(), reject);
        }, 'image/png');
      });
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Not every browser allows an image on the clipboard. The download does.
      download();
    }
  }

  return (
    <div className="sharecard">
      <div className="sharecard-frame">
        <canvas ref={canvas} width={W * SCALE} height={H * SCALE} />
      </div>

      {/*
        Backgrounds first, because it is the change most people will make and
        the one that needs no file. A picture replaces the wash entirely.
      */}
      <div className="sharecard-backs">
        {BACKGROUNDS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={
              !picture && background.id === option.id ? 'sharecard-back on' : 'sharecard-back'
            }
            style={{ background: `linear-gradient(135deg, ${option.from}, ${option.to})` }}
            aria-label={option.label}
            title={option.label}
            onClick={() => {
              release();
              setPicture(null);
              setPictureName(null);
              setAnimated(false);
              setBackground(option);
            }}
          />
        ))}
      </div>

      <div className="sharecard-actions">
        <label className="btn-file">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            onChange={(event) => choose(event.target.files?.[0])}
          />
          {pictureName ? 'Change the picture' : 'Add a picture or GIF'}
        </label>

        {picture && (
          <button
            type="button"
            className="linklike"
            onClick={() => {
              release();
              setPicture(null);
              setPictureName(null);
              setAnimated(false);
            }}
          >
            back to a colour
          </button>
        )}

        <span className="sharecard-gap" />

        <button type="button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy image'}
        </button>
        <button type="button" onClick={download}>
          Download PNG
        </button>
        {animated && clipType() && (
          <button type="button" onClick={record} disabled={recording !== null}>
            {recording === null ? 'Download video' : `Recording ${recording}s`}
          </button>
        )}
        <button type="button" className="linklike" onClick={onClose}>
          close
        </button>
      </div>

      {animated && (
        <p className="dim sharecard-note">
          {clipType()
            ? 'Download video records five seconds of it, as MP4 where the browser can and WebM otherwise. Both play inline on X. Download PNG takes a still of the frame showing now.'
            : 'This browser cannot record video, so the card saves as a still of the frame showing now.'}
        </p>
      )}
    </div>
  );
}
