import { endSession } from '@/lib/session';

export async function POST(): Promise<Response> {
  await endSession();
  return Response.json({ ok: true });
}
