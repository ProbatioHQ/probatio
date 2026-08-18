import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Probatio: trade fake money on real tokens, prove you are good';

/**
 * The card the site itself turns into when a link is pasted.
 *
 * Carries the sentence rather than only a name, because the sentence is what
 * has to survive being repeated by somebody who is not selling anything, and a
 * card showing only a name asks a reader to click before they know whether they
 * care. The mark is there so the thing they arrive at looks like the thing they
 * were shown.
 *
 * Rendered from the same palette the site is: the near-black it sits on, the
 * one green a gain is marked in, and the same steel for everything supporting.
 * A share card in colours the site does not use reads as somebody else's.
 */

/**
 * The mark, inlined.
 *
 * This runs where there is no request and no origin to fetch from, so a URL
 * would resolve against nothing. Read off disk and carried in the image.
 */
const mark = `data:image/png;base64,${readFileSync(
  join(process.cwd(), 'public', 'probatio-logo.png'),
).toString('base64')}`;

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
          position: 'relative',
          // The ground, lit from the top left the way the site is.
          backgroundColor: '#07090b',
          backgroundImage:
            'radial-gradient(900px 500px at 12% -10%, rgba(63,224,138,0.16), rgba(7,9,11,0) 60%)',
          color: '#e6e8eb',
          padding: 84,
          fontFamily: 'sans-serif',
        }}
      >
        {/* The mark and the name, as the header carries them. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, marginBottom: 46 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mark} alt="" width={72} height={72} />
          <div style={{ fontSize: 30, color: '#99a0ab', letterSpacing: 4 }}>PROBATIO</div>
        </div>

        {/*
          Each sentence holds its own line. Larger and they wrap mid-phrase, on
          "on real / tokens.", which reads as a mistake on the one image most
          people will ever see of this.
        */}
        <div style={{ fontSize: 62, fontWeight: 700, lineHeight: 1.22, display: 'flex' }}>
          Trade fake money on real tokens.
        </div>
        <div
          style={{
            fontSize: 62,
            fontWeight: 700,
            lineHeight: 1.22,
            display: 'flex',
            color: '#3fe08a',
          }}
        >
          Prove you&apos;re good. Get real money.
        </div>

        {/* A rule in the accent, so the claim and the detail are separate things. */}
        <div
          style={{
            width: 132,
            height: 4,
            borderRadius: 999,
            backgroundColor: '#3fe08a',
            marginTop: 44,
            marginBottom: 30,
          }}
        />

        <div style={{ fontSize: 29, color: '#99a0ab', display: 'flex' }}>
          Live pump.fun prices, real slippage and real delay.
        </div>
        {/*
          The card is the claim most people see and the one nobody can click
          through to qualify, so it says what actually happens to a fill. It
          used to end "and checkable", which is a promise about a chain that is
          not being written to yet.
        */}
        <div style={{ fontSize: 29, color: '#99a0ab', marginTop: 10, display: 'flex' }}>
          Every fill recorded at the price the market was at that moment.
        </div>
      </div>
    ),
    size,
  );
}
