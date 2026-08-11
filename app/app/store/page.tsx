import type { Metadata } from 'next';
import { PRACTICE_TIERS, pricePerSol } from '@probatio/payments';
import { Store } from '@/components/store';
import { treasuryAddress } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Store, Probatio',
  description:
    'Buy practice balance for free play. Bigger sizes cost less per SOL. Ranked seasons start everyone on the same balance and cannot be topped up.',
};

export default function StorePage() {
  const tiers = PRACTICE_TIERS.map((tier) => ({
    sol: tier.sol,
    priceLamports: tier.priceLamports.toString(),
    perSol: pricePerSol(tier).toString(),
  }));

  return (
    <main className="wrap">
      <Store tiers={tiers} available={treasuryAddress() !== null} />
    </main>
  );
}
