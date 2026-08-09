import { PriceChart } from '@/components/price-chart';

/**
 * A token's page.
 *
 * The chart for now; the trade panel and positions land here next.
 */
export default async function TokenPage({
  params,
}: {
  params: Promise<{ mint: string }>;
}) {
  const { mint } = await params;

  return (
    <main>
      <h1>{mint.slice(0, 4)}…{mint.slice(-4)}</h1>
      <p>Market cap, in SOL</p>
      <PriceChart mint={mint} timeframe="m1" unit="market-cap" />
    </main>
  );
}
