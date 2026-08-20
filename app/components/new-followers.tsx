'use client';

import { useEffect, useState } from 'react';

/**
 * How many people started following you since you last looked.
 *
 * Gaining an audience used to happen in silence, which is a strange way to
 * treat the thing this feature exists for. This is the smallest honest version:
 * a count, a link to the list, and nothing that needs dismissing.
 *
 * It disappears by being read. Opening your follower list is what marks them
 * seen, so there is no dismiss button to press and no state that can disagree
 * with whether you have actually looked.
 */
export function NewFollowers({ pubkey }: { pubkey: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // POST because it answers about the session rather than the URL, and a
    // cached GET on a per-user answer is the kind of thing that shows one
    // trader another's number.
    void fetch('/api/follow/list', { method: 'POST', cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<{ newFollowers: number }>) : null))
      .then((body) => {
        if (!cancelled && body) setCount(body.newFollowers);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (count === 0) return null;

  return (
    <a className="new-followers" href={`/p/${pubkey}`}>
      <b>{count}</b> new {count === 1 ? 'follower' : 'followers'}
      <span className="new-followers-go">see who</span>
    </a>
  );
}
