'use client';

import { useEffect, useState } from 'react';

/**
 * What is broken, said before somebody has to work it out.
 *
 * The degraded modes were built and then left invisible: trading stops when
 * prices cannot be read, the leaderboard values positions at cost, the feed
 * stops growing — and a user saw none of that, only a site behaving oddly.
 *
 * Silence during an outage is how a careful product gets mistaken for a broken
 * one. It shows nothing at all when everything is working, because a permanent
 * green badge is furniture that people stop reading.
 */

interface Capability {
  capability: string;
  level: 'degraded' | 'unavailable';
  note: string;
}

interface Health {
  status: 'ok' | 'degraded' | 'unavailable';
  capabilities: Capability[];
}

/** Our health shape, not a proxy's error body that happens to be JSON. */
export function isHealth(body: unknown): body is Health {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { status?: unknown }).status === 'string' &&
    Array.isArray((body as { capabilities?: unknown }).capabilities)
  );
}

export function StatusBanner() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async (): Promise<void> => {
      try {
        const response = await fetch('/api/health');
        const body = (await response.json()) as unknown;
        // Only our own health shape counts. A proxy's 502 body during a deploy
        // is JSON too, with a `status` but no `capabilities`, and taking it at
        // face value put `undefined.length` in the render on every page.
        if (!cancelled) setHealth(isHealth(body) ? body : null);
      } catch {
        // A status check that cannot reach the server says nothing rather than
        // claiming an outage it has not established.
        if (!cancelled) setHealth(null);
      }
    };

    void check();
    const timer = setInterval(() => void check(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!health || health.status === 'ok' || !Array.isArray(health.capabilities)) return null;
  if (health.capabilities.length === 0) return null;

  const stopped = health.capabilities.filter((entry) => entry.level === 'unavailable');
  const worst = stopped[0] ?? health.capabilities[0]!;

  return (
    <div className={`status-banner ${stopped.length > 0 ? 'stopped' : ''}`} role="status">
      <div className="shell">
        <span className={`pill ${stopped.length > 0 ? 'closed' : ''}`}>
          {stopped.length > 0 ? 'degraded' : 'reduced'}
        </span>
        <span>{worst.note}</span>
      </div>
    </div>
  );
}
