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
  return { title: `${name ?? shortAddressSafe(pubkey)} — Probatio` };
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
