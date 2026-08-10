import type { Metadata } from 'next';
import { Onboarding } from '@/components/onboarding';
import { TokenView } from '@/components/token-view';
import { currentUser } from '@/lib/session';
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

export default async function TokenPage({
  params,
}: {
  params: Promise<{ mint: string }>;
}) {
  const { mint } = await params;
  const [user, token] = await Promise.all([currentUser(), tokenName(mint)]);

  return (
    <main>
      <h1>
        {token.symbol ?? token.name}
        {token.symbol && token.name !== token.symbol && (
          <span className="dim" style={{ fontWeight: 400 }}> {token.name}</span>
        )}
      </h1>
      <p className="mono dim" style={{ fontSize: 13 }}>
        {shortMint(mint)} · market cap in SOL
      </p>
      {/* Compact here: someone on a token page has already found one. */}
      <Onboarding compact />
      <TokenView mint={mint} signedIn={user !== null} />
    </main>
  );
}
