import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { launchByMint } from '@probatio/db';
import { Onboarding } from '@/components/onboarding';
import { TokenView } from '@/components/token-view';
import { db } from '@/lib/db';
import { knownImages, resolveLaunchImages } from '@/lib/token-images';
import { shortMint, tokenName } from '@/lib/token-name';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ mint: string }>;
}): Promise<Metadata> {
  const { mint } = await params;
  if (!MINT_PATTERN.test(mint)) return { title: 'Not found, Probatio' };

  const token = await tokenName(mint).catch(() => null);
  return { title: token?.known ? `${token.symbol ?? token.name}, Probatio` : 'Probatio' };
}

/**
 * Base58, and the length a Solana address actually is.
 *
 * Without this, any string at all rendered a full trading surface — chart,
 * buy and sell buttons, the lot — for a token that cannot exist. It would
 * never fill, but offering the controls at all is the wrong answer.
 */
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function TokenPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  if (!MINT_PATTERN.test(mint)) notFound();

  const client = await db();

  // Make sure this token's picture gets resolved, even one the feed never saw:
  // the resolver now falls back to the chain when there is no launch row. In the
  // background, so the page never waits on a stranger's image host.
  resolveLaunchImages([mint]);

  // Each of these reads the chain, an outside index, or the database, and none
  // of them is worth failing the whole page over. One that throws falls back to
  // its empty answer rather than taking the trading surface down with it — the
  // page is where somebody came to trade, and a missing name or picture is no
  // reason to deny them that. A page that crashed here surfaced as a server
  // render error with only a digest, impossible to read from the outside.
  /*
   * Three reads of our own, and nothing over the network to anybody else.
   *
   * Whether an outside index carries this pair used to be asked here as well,
   * which put a call to another company's server in front of every token page
   * on the site: the click did nothing at all until that answered, and it was
   * answering for a value that decides only which chart is selected first. The
   * native chart is the default now, and the browser already asks the same
   * question a moment after arriving and switches if the answer is yes. So the
   * page opens on its own data and finds that out afterwards, where waiting for
   * it costs nobody anything.
   */
  /*
   * A name is worth waiting a moment for and not worth waiting on.
   *
   * Resolving one for a token the feed never saw is a chain read, and a slow
   * node holds the whole page on a value that only fills a heading. Past a
   * second and a half the short mint stands in, which is what an unknown token
   * shows anyway.
   */
  const withinAMoment = <T,>(work: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([
      work,
      new Promise<T>((resolve) => {
        setTimeout(() => resolve(fallback), 1_500);
      }),
    ]);

  const [token, launch, images] = await Promise.all([
    withinAMoment(
      tokenName(mint).catch(() => ({ name: shortMint(mint), symbol: null, known: false }) as const),
      { name: shortMint(mint), symbol: null, known: false } as const,
    ),
    launchByMint(client, mint).catch(() => null),
    knownImages([mint]).catch(() => new Map<string, string>()),
  ]);
  const image = images.get(mint) ?? null;

  return (
    <main className="token-page wide">
      {/* The head is drawn by TokenView rather than here, so the live market
          cap can sit on the same row as the name. This page still resolves who
          the token is; it just hands the facts down. */}
      <TokenView
        mint={mint}
        dexIndexed={false}
        head={{
          name: token.name,
          symbol: token.symbol,
          image,
          launchedAt: launch?.launchedAt ?? null,
          shortMint: shortMint(mint),
        }}
      />

      {/* Below the trading surface, not above it. Somebody who navigated to a
          token came to trade it, and putting the explainer first pushed the
          chart and the panel off the screen they arrived at. */}
      <Onboarding compact />
    </main>
  );
}
