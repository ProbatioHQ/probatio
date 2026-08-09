import { currentUser } from '@/lib/session';

export async function GET(): Promise<Response> {
  const user = await currentUser();
  return Response.json(
    user ? { pubkey: user.pubkey, expiresAt: user.expiresAt } : { pubkey: null },
  );
}
