import { TokenView } from '@/components/token-view';
import { currentUser } from '@/lib/session';

export default async function TokenPage({
  params,
}: {
  params: Promise<{ mint: string }>;
}) {
  const { mint } = await params;
  const user = await currentUser();

  return (
    <main>
      <h1>
        {mint.slice(0, 4)}…{mint.slice(-4)}
      </h1>
      <p>Market cap, in SOL</p>
      <TokenView mint={mint} signedIn={user !== null} />
    </main>
  );
}
