import { PriceChart } from '@/components/price-chart';
import { TradePanel } from '@/components/trade-panel';
import { currentUser } from '@/lib/session';

/**
 * A token's page: the chart, and the panel that trades against it.
 */
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
      <PriceChart mint={mint} timeframe="m1" unit="market-cap" />
      <TradePanel mint={mint} signedIn={user !== null} />
    </main>
  );
}
