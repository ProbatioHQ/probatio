'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The coach.
 *
 * Shows the last report and, when one is available, offers a new one. The
 * button is the only thing here that spends anything, so it says what it will
 * do and disables itself while it does it.
 */

interface Observation {
  metric: string;
  text: string;
}

interface Report {
  headline: string;
  focus: string | null;
  observations: Observation[];
  createdAt: number;
  tripsAtReport: number;
}

interface CoachState {
  tier: 'free' | 'ranked';
  trips: number;
  minimumTrips: number;
  report: Report | null;
  available: boolean;
  nextAvailableAt: number | null;
  reason: string | null;
}

function when(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function Coach() {
  const [state, setState] = useState<CoachState | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/coach');
      if (response.status === 401) {
        setState(null);
        return;
      }
      setState((await response.json()) as CoachState);
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function request(): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      const response = await fetch('/api/coach', { method: 'POST' });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? 'The coach could not be reached.');
      }
      await load();
    } catch {
      setError('The coach could not be reached.');
    } finally {
      setWorking(false);
    }
  }

  if (!state) return null;

  return (
    <section aria-label="Coach" className="term">
      <div className="term-bar">
        <span className="prompt">~/coach</span>
        <span>your trades</span>
        <span className="lights"><i /><i /><i /></span>
      </div>
      <div className="term-body">
      <h2>Coach</h2>

      {state.report ? (
        <article>
          <h3>{state.report.headline}</h3>
          <p>
            <span>
              On {state.report.tripsAtReport} closed{' '}
              {state.report.tripsAtReport === 1 ? 'trade' : 'trades'}
            </span>
            <span> · {when(state.report.createdAt)}</span>
          </p>
          <ul>
            {state.report.observations.map((observation) => (
              <li key={observation.metric}>{observation.text}</li>
            ))}
          </ul>
          {state.report.focus && (
            <p>
              <strong>Next:</strong> {state.report.focus}
            </p>
          )}
        </article>
      ) : (
        <p>
          {state.trips < state.minimumTrips
            ? `Close ${state.minimumTrips} trades and there will be enough of a pattern to review. ` +
              `You have ${state.trips}.`
            : 'No report yet.'}
        </p>
      )}

      {state.available ? (
        <button type="button" onClick={() => void request()} disabled={working}>
          {working ? 'Reading your trades…' : state.report ? 'New report' : 'Get a report'}
        </button>
      ) : (
        state.reason && <p>{state.reason}</p>
      )}

      {error && <p role="alert">{error}</p>}
    </div>
    </section>
  );
}
