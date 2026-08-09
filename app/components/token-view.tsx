'use client';

import { useState } from 'react';
import { PriceChart } from '@/components/price-chart';
import { Positions } from '@/components/positions';
import { TradePanel } from '@/components/trade-panel';

/**
 * Ties the panel to the position table.
 *
 * A trade has to refresh the positions beside it, or a trader is left looking
 * at a balance that is already wrong.
 */
export function TokenView({ mint, signedIn }: { mint: string; signedIn: boolean }) {
  const [tradeCount, setTradeCount] = useState(0);

  return (
    <>
      <PriceChart mint={mint} timeframe="m1" unit="market-cap" />
      <TradePanel mint={mint} signedIn={signedIn} onTraded={() => setTradeCount((n) => n + 1)} />
      {signedIn && <Positions refreshKey={tradeCount} />}
    </>
  );
}
