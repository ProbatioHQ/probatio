import type { Metadata } from 'next';
import { Spectate } from '@/components/spectate';

export const metadata: Metadata = {
  title: 'Watching, Probatio',
  description:
    'Fills from the traders you follow, as they land. Every one of them sealed and checkable.',
};

/**
 * The feed of everybody you follow.
 *
 * Deliberately only the fills. A profile is where a record is read; this is
 * where it is watched happening, and mixing the two would make this page a
 * worse version of both.
 */
export default function WatchingPage() {
  return (
    <main>
      <div className="page-head">
        <h1>Watching</h1>
        <p className="dim">
          Fills from the traders you follow, as they land. Every one carries the price impact it
          actually caused and the delay it actually took, because those are recorded with the fill
          rather than written about it afterwards.
        </p>
      </div>

      <Spectate mode="following" />

      <p className="dim" style={{ fontSize: 13 }}>
        Follow a trader from their record page. Anything they fill turns up here.{' '}
        <a href="/season">The standings</a> are a reasonable place to find somebody worth
        watching.
      </p>
    </main>
  );
}
