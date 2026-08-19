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
 * the address and points the band at the coin; nothing else moves.
 *
 * No client component and no state: this is a marquee and a link, and the
 * motion is CSS. It briefly carried a copy button, which was the only reason
 * any of this shipped JavaScript to a browser.
 */

/**
 * The contract address.
 *
 * Verified against pump.fun's own record before it went in here: the mint
 * returns name "Probatio", symbol "PROB". This string is the reason the strip
 * exists, so it is checked rather than pasted.
 */
const CONTRACT: string | null = 'CzSDyFGHgZQP6HB1f32xuZybn8gtSSYfHj23xVgpump';

/** Where the strip sends you. The launchpad's own page for the mint above. */
const COIN_URL = `https://pump.fun/coin/${CONTRACT}`;

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
          <span>Official contract</span>
        </>
      )}
      <span className="strip-dot">·</span>
    </span>
  );
}

export function TokenStrip() {
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

  /*
    The whole band is the link.

    There is one thing to do with a contract address in a header, which is to
    go and look at the coin, so the band does that and the entire width is the
    target. A copy button sat at the right for a while and was removed: it
    fought the link for the same tap, and a reader who wants the string can
    take it from the page it opens.
  */
  return (
    <a
      className="token-strip live"
      href={COIN_URL}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`The official ${TICKER} contract address is ${CONTRACT}. Opens it on pump.fun.`}
    >
      {track}
    </a>
  );
}
