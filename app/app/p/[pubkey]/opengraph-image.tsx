import { ImageResponse } from 'next/og';
import { activeName, shortAddressSafe } from '@/lib/profile-data';
import { cardFor } from '@/lib/card';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'A trading record on Probatio';

/**
 * The card a profile turns into when its link is pasted anywhere.
 *
 * This is the whole free distribution channel. There is no Twitter API and no
 * email list, so the only way this travels is somebody choosing to paste a
 * link — which means the card has to be worth pasting on its own.
 *
 * What makes it worth pasting is not the number. Everyone in this market has
 * seen a screenshot of a huge gain and nobody believes any of them, because
 * screenshots are free to fabricate. The card says the number and then says
 * where to check it, which is the one thing a faked screenshot cannot do.
 *
 * So the verify address is on the card itself rather than in the surrounding
 * post. A skeptic who saves the image still has the means to disprove it.
 */
export default async function ProfileCard({
  params,
}: {
  params: Promise<{ pubkey: string }>;
}) {
  const { pubkey } = await params;
  const [name, card] = await Promise.all([activeName(pubkey), cardFor(pubkey)]);
  const display = name ?? shortAddressSafe(pubkey);

  const positive = card.returnBps !== null && card.returnBps > 0;
  const accent = card.returnBps === null ? '#8a8f98' : positive ? '#3fb950' : '#f85149';

  // Strings built here rather than interpolated in the markup. The image
  // renderer requires an explicit display on any element with more than one
  // child, and a template expression beside a literal is two children — which
  // fails at render time rather than at build time, so the card would have
  // been broken only where it mattered.
  const returnText =
    card.returnBps === null
      ? ''
      : `${positive ? '+' : ''}${(card.returnBps / 100).toFixed(1)}%`;
  const tradesText = `${card.trips} closed ${card.trips === 1 ? 'trade' : 'trades'}`;
  const rankText = card.rank === null ? '' : `Rank ${card.rank} of ${card.entrants}`;
  // What the card can honestly say about the record: every fill carries a seal
  // anyone can recompute. It used to count how many trades had reached a chain,
  // which was a number that was always zero and read as a product that had not
  // shipped.
  const sealedText = 'Every fill sealed with a hash anyone can recompute';
  // Not the address again, and never a truncated one. The full key is already
  // on the card above; a shortened one in a URL is an instruction nobody can
  // follow, which defeats the only reason this line exists.
  const verifyText = 'Check it yourself at probatiotrade.com/verify';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#0b0d10',
          color: '#e6e8eb',
          padding: 72,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 28, color: '#8a8f98', letterSpacing: 2 }}>PROBATIO</div>
          <div style={{ fontSize: 64, fontWeight: 700 }}>{display}</div>
          <div style={{ fontSize: 24, color: '#8a8f98' }}>{pubkey}</div>
        </div>

        {card.returnBps === null ? (
          <div style={{ fontSize: 44, color: '#8a8f98', display: 'flex' }}>
            No closed trades yet
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 40 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 28, color: '#8a8f98' }}>Return</div>
              <div
                style={{
                  display: 'flex',
                  fontSize: 140,
                  fontWeight: 700,
                  color: accent,
                  lineHeight: 1,
                }}
              >
                {returnText}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 18 }}>
              <div style={{ fontSize: 30, color: '#8a8f98', display: 'flex' }}>{tradesText}</div>
              {rankText !== '' && (
                <div style={{ fontSize: 30, color: '#8a8f98', display: 'flex' }}>{rankText}</div>
              )}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* The claim and the means to disprove it, on the image itself. */}
          <div
            style={{
              display: 'flex',
              fontSize: 30,
              color: '#99a0ab',
            }}
          >
            {sealedText}
          </div>
          <div style={{ display: 'flex', fontSize: 26, color: '#8a8f98' }}>{verifyText}</div>
        </div>
      </div>
    ),
    size,
  );
}
