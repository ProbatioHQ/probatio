import type { Metadata } from 'next';
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
    title: `${who} — Probatio`,
    description:
      'A trading record committed to Solana as it was made, so it cannot be edited ' +
      'afterwards. Check it yourself.',
  };
}

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ pubkey: string }>;
}) {
  const { pubkey } = await params;
  const name = await activeName(pubkey);

  return (
    <main>
      <h1>{name ?? shortAddressSafe(pubkey)}</h1>
      {/* The address is always shown. It is the identity; the name is not. */}
      <p>{pubkey}</p>
      <ProfileView pubkey={pubkey} />
    </main>
  );
}
