'use client';

import { useState } from 'react';

/**
 * The band above the header, saying which token is this site's.
 *
 * A site like this one attracts tokens claiming to be it, and they appear
 * before the real one does. Someone arriving here has no way to tell a genuine
 * contract from an impostor's, and the answer has to be somewhere they will
 * actually look, which is the top of every page rather than a link in a footer.
 *
 * So this says the same thing at both stages of the token's life. Before it
 * exists: there is no contract, and anything presenting itself as one is fake.
 * After: the address, published by the site itself, which is the one thing an
 * impostor cannot forge. Both are the same claim, and the second is credible
 * because the first was there first.
 *
 * Deliberately one constant to change. Setting `CONTRACT` swaps the warning for
 * the address and turns the strip into a copy control; nothing else moves.
 */

/**
 * The contract address, once there is one.
 *
 * Null until the token launches. Set it to the mint and the strip changes over
 * on the next deploy. Nothing else in this file needs touching.
 */
const CONTRACT: string | null = null;

const TICKER = '$PROB';

/**
 * How many times the phrase is repeated inside one run.
 *
 * The loop holds two identical runs and slides exactly one run's width, so the
 * seam lands where the second copy begins and is never on screen. That only
 * holds while a single run is at least as wide as the display: if it is
 * narrower the track runs out and a gap crosses the page. Ten is sized for 4K,
 * where the phrase is roughly 450px and a run therefore roughly 4,500.
 */
const REPEATS = 10;

function Phrase() {
  return (
    <span className="strip-phrase">
      <span className="strip-ticker">{TICKER}</span>
      <span className="strip-dot">·</span>
      {CONTRACT === null ? (
        <>
          <span>No contract yet</span>
          <span className="strip-dot">·</span>
          <span>Any token claiming to be Probatio is fake</span>
        </>
      ) : (
        <>
          <span className="strip-ca">{CONTRACT}</span>
          <span className="strip-dot">·</span>
          <span>Official contract, tap to copy</span>
        </>
      )}
      <span className="strip-dot">·</span>
    </span>
  );
}

export function TokenStrip() {
  const [copied, setCopied] = useState(false);

  /*
    Read once, scrolled twice.

    A screen reader should be handed the sentence, not a marquee of it ten
    times over. The track is hidden from assistive technology entirely and the
    same words are given once: as off-screen text while there is no contract,
    and as the button's own label once there is.
  */
  const track = (
    <span className="strip-track" aria-hidden="true">
      <span className="strip-run">
        {Array.from({ length: REPEATS }, (_, index) => (
          <Phrase key={index} />
        ))}
      </span>
      <span className="strip-run">
        {Array.from({ length: REPEATS }, (_, index) => (
          <Phrase key={index} />
        ))}
      </span>
    </span>
  );

  if (CONTRACT === null) {
    return (
      <div className="token-strip">
        {track}
        <p className="strip-say">
          {TICKER} has no contract address yet. Any token claiming to be Probatio is not ours.
        </p>
      </div>
    );
  }

  const copy = (): void => {
    void navigator.clipboard
      .writeText(CONTRACT)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_600);
      })
      .catch(() => undefined);
  };

  /*
    The whole band is the control once there is an address.

    The thing worth tapping is the address, and it is moving, so aiming at it
    would be a game. The strip takes the tap instead: anywhere on it copies.
  */
  return (
    <button
      type="button"
      className="token-strip live"
      onClick={copy}
      aria-label={
        copied
          ? `Copied. The ${TICKER} contract address is ${CONTRACT}`
          : `Copy the official ${TICKER} contract address, ${CONTRACT}`
      }
    >
      {track}
      <span className={copied ? 'strip-flash shown' : 'strip-flash'} aria-hidden="true">
        Copied
      </span>
    </button>
  );
}
