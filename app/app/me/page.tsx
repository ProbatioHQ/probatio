import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Coach } from '@/components/coach';
import { NameClaim } from '@/components/name-claim';
import { Positions } from '@/components/positions';
import { currentUser } from '@/lib/session';

export const metadata: Metadata = {
  title: 'Your account, Probatio',
  description: 'Your balance, your positions, your trade log, and what the coach makes of them.',
};

/**
 * Everything about you, in one place.
 *
 * These pieces existed but were scattered down the front page, under the
 * sections explaining the product to somebody who had never seen it — so a
 * trader who had signed in and made trades had nowhere to go and look at them.
 * The coach in particular was invisible: it only says anything after a number
 * of round trips, and nothing told you where it would appear when it did.
 *
 * Server-guarded rather than a client-side empty state. A page whose entire
 * content requires a session should not render its own furniture to somebody
 * who cannot see any of it.
 */
export default async function AccountPage() {
  const user = await currentUser();
  if (!user) redirect('/');

  return (
    <main>
      <div className="page-head">
        <h1>Your account</h1>
        {/* Says what the log shows rather than asserting the outcome. Whether
            a trade reached the chain is a fact about the keeper, and the table
            below reports it per trade instead of being promised here. */}
        <p className="dim">
          Practice money, real prices. Every trade below is hashed as it fills and committed to
          Solana in batches. The log says which have landed.{' '}
          <a href={`/p/${user.pubkey}`}>Your public record</a> is the same data, checkable by
          anyone.
        </p>
      </div>

      <Positions refreshKey={0} />
      <Coach />
      <NameClaim />
    </main>
  );
}
