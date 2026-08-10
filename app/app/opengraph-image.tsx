import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Probatio — trade fake money on real tokens, prove you are good';

/**
 * The card the site itself turns into when a link is pasted.
 *
 * Carries the one sentence rather than a logo, because the sentence is what
 * has to survive being repeated by somebody who is not selling anything. A
 * card that only shows a name asks the reader to click before they know
 * whether they care.
 */
export default function SiteCard() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          background: '#0b0d10',
          color: '#e6e8eb',
          padding: 90,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 30, color: '#8a8f98', letterSpacing: 3, marginBottom: 28 }}>
          PROBATIO
        </div>
        {/*
          Sized so each sentence holds its own line. At a larger size they wrap
          mid-phrase — "on real / tokens." — which reads as a mistake on the
          one image most people will ever see of this.
        */}
        <div style={{ fontSize: 60, fontWeight: 700, lineHeight: 1.25, display: 'flex' }}>
          Trade fake money on real tokens.
        </div>
        <div style={{ fontSize: 60, fontWeight: 700, lineHeight: 1.25, display: 'flex' }}>
          Prove you&apos;re good. Get real money.
        </div>
        <div style={{ fontSize: 30, color: '#8a8f98', marginTop: 44, display: 'flex' }}>
          Live pump.fun prices, real slippage and delay.
        </div>
        <div style={{ fontSize: 30, color: '#8a8f98', marginTop: 8, display: 'flex' }}>
          Every trade committed to Solana as you make it.
        </div>
      </div>
    ),
    size,
  );
}
