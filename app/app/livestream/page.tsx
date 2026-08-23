import type { Metadata } from 'next';
import { StreamBoardView } from '@/components/stream-board';
import { PHASES } from '@/lib/roadmap';

/**
 * The broadcast surface.
 *
 * Not linked from anywhere, and that is the whole specification: somebody types
 * the address or they do not arrive. It is a capture target for a stream rather
 * than a page on the site, so putting it in the navigation would offer every
 * visitor a screen built for a camera.
 *
 * `noindex` for the same reason. A search result leading here would put the
 * least useful version of the site in front of somebody looking for the real
 * one.
 */

export const metadata: Metadata = {
  title: 'Probatio, live',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function LivestreamPage() {
  // Phase one only. A broadcast card has room for one phase and the first is
  // the one with anything shipped in it.
  const phase = PHASES[0] ?? null;
  return <StreamBoardView phase={phase} />;
}
