import type { Metadata } from 'next';
import { launchByMint } from '@probatio/db';
import { Onboarding } from '@/components/onboarding';
import { TokenView } from '@/components/token-view';
import { db } from '@/lib/db';
import { knownImages } from '@/lib/token-images';
import { shortMint, tokenName } from '@/lib/token-name';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ mint: string }>;
}): Promise<Metadata> {
  const { mint } = await params;
  const token = await tokenName(mint);
  return { title: token.known ? `${token.symbol ?? token.name}, Probatio` : 'Probatio' };
}

export default async function TokenPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  const client = await db();

  const [token, launch, images] = await Promise.all([
    tokenName(mint),
    launchByMint(client, mint),
    knownImages([mint]),
  ]);
  const image = images.get(mint) ?? null;

  return (
    <main className="token-page">
      <div className="token-head">
        {image ? (
          // Not next/image: an arbitrary host chosen by whoever launched the
          // token, rendered by the browser and never fetched by this server.
          <img className="token-hero" src={image} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="token-hero placeholder" aria-hidden="true" />
        )}

        <div className="token-title">
          <h1>
            {token.symbol ?? token.name}
            {token.symbol && token.name !== token.symbol && (
              <span className="dim"> {token.name}</span>
            )}
          </h1>
          <p className="mono dim token-meta">
            <span>{shortMint(mint)}</span>
            {launch && (
              <>
                <span className="sep" aria-hidden="true" />
                <span>launched {new Date(launch.launchedAt * 1_000).toLocaleDateString()}</span>
              </>
            )}
            <span className="sep" aria-hidden="true" />
            <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noopener noreferrer">
              pump.fun
            </a>
          </p>
        </div>
      </div>

      <TokenView mint={mint} />

      {/* Below the trading surface, not above it. Somebody who navigated to a
          token came to trade it, and putting the explainer first pushed the
          chart and the panel off the screen they arrived at. */}
      <Onboarding compact />
    </main>
  );
}
