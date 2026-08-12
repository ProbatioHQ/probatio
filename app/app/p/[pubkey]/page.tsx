import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { activeName, shortAddressSafe } from '@/lib/profile-data';
import { ProfileView } from '@/components/profile-view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ pubkey: string }>;
}): Promise<Metadata> {
  const { pubkey } = await params;
  const name = await activeName(pubkey);
  const who = name ?? shortAddressSafe(pubkey);

  // The description is the preview text under the card. It carries the reason
  // the link is worth opening rather than repeating the title.
  return {
    title: `${who} · Probatio`,
    description:
      // The page itself reports how many trades have reached the chain. The
      // description that travels with the link should not promise more than
      // the page it links to.
      'A trading record hashed as it was made and committed to Solana in batches, so it ' +
      'cannot be edited afterwards. Check it yourself.',
  };
}

/** The same shape a Solana address has. See the token page. */
const PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ pubkey: string }>;
}) {
  const { pubkey } = await params;
  // A record page for something that cannot be a wallet is not a record page.
  if (!PUBKEY_PATTERN.test(pubkey)) notFound();
  const name = await activeName(pubkey);

  return (
    <main>
      <div className="record-head">
        <div className="page-head">
          <h1>{name ?? shortAddressSafe(pubkey)}</h1>
          {/* The address is always shown. It is the identity; the name is not. */}
          <p className="mono dim record-addr">{pubkey}</p>
        </div>
        <span className="record-badge mono">public record</span>
      </div>
      <ProfileView pubkey={pubkey} />
    </main>
  );
}
