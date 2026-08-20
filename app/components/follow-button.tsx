'use client';

import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@/components/wallet';

/**
 * Follow, unfollow, and the two numbers that come with it.
 *
 * The state is read from the server rather than assumed, because the same
 * profile can be open on a phone and a desktop and a button that guesses is
 * wrong on one of them the moment the other is pressed.
 *
 * Optimistic on press, corrected by the response. A follow is a row in a table
 * with no consequences worth waiting on, so making somebody watch a spinner for
 * it would be the wrong trade. If the write fails, the previous state is put
 * back and the reason is shown.
 */

interface FollowState {
  readonly counts: { readonly followers: number; readonly following: number };
  readonly following: boolean;
  readonly self: boolean;
}

interface Entry {
  readonly pubkey: string;
  readonly name: string | null;
  readonly followedAt: number;
}

type ListKind = 'followers' | 'following';

function short(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

export function FollowButton({ pubkey }: { pubkey: string }) {
  const { status, signIn } = useWallet();
  const [state, setState] = useState<FollowState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /*
   * Which list is open, and what is in it.
   *
   * Expanded in place rather than in a dialog. The list is short, it is read
   * next to the record it belongs to, and a dialog would take over a phone
   * screen to show eight names.
   */
  const [open, setOpen] = useState<ListKind | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);

  const show = useCallback(
    (kind: ListKind): void => {
      if (open === kind) {
        setOpen(null);
        return;
      }
      setOpen(kind);
      setEntries(null);
      void fetch(`/api/follow/list?pubkey=${encodeURIComponent(pubkey)}&kind=${kind}`, {
        cache: 'no-store',
      })
        .then((response) => (response.ok ? (response.json() as Promise<{ entries: Entry[] }>) : null))
        .then((body) => setEntries(body?.entries ?? []))
        .catch(() => setEntries([]));
    },
    [open, pubkey],
  );

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/follow?pubkey=${encodeURIComponent(pubkey)}`, { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<FollowState>) : null))
      .then((body) => {
        if (!cancelled && body) setState(body);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  const toggle = useCallback((): void => {
    if (!state || busy) return;
    if (status !== 'signed-in') {
      void signIn();
      return;
    }

    const next = !state.following;
    const previous = state;
    // Moved by one straight away. The number is the thing being changed, so
    // leaving it stale until the round trip lands makes the press feel ignored.
    setState({
      ...state,
      following: next,
      counts: {
        ...state.counts,
        followers: Math.max(0, state.counts.followers + (next ? 1 : -1)),
      },
    });
    setBusy(true);
    setNote(null);

    void fetch('/api/follow', {
      method: next ? 'POST' : 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey }),
    })
      .then(async (response) => {
        const body = (await response.json()) as Partial<FollowState> & { error?: string };
        if (!response.ok) {
          setState(previous);
          setNote(body.error ?? 'that did not work');
          return;
        }
        if (body.counts && typeof body.following === 'boolean') {
          setState({ counts: body.counts, following: body.following, self: previous.self });
        }
      })
      .catch(() => {
        setState(previous);
        setNote('that did not work');
      })
      .finally(() => setBusy(false));
  }, [state, busy, status, signIn, pubkey]);

  // Nothing at all until the state is known, rather than a button that flips
  // under somebody's finger a moment after it renders.
  if (!state) return null;

  return (
    <div className="follow">
      <span className="follow-counts">
        {/* Buttons rather than text, because the numbers open something. A
            count nobody can click is a count nobody can check. */}
        <button type="button" className="follow-count" onClick={() => show('followers')}>
          <b>{state.counts.followers}</b>{' '}
          {state.counts.followers === 1 ? 'follower' : 'followers'}
        </button>
        <span className="follow-dot">·</span>
        <button type="button" className="follow-count" onClick={() => show('following')}>
          <b>{state.counts.following}</b> following
        </button>
      </span>

      {/* Your own record has the numbers but no button: following yourself is
          not a relationship, and the server refuses it anyway. */}
      {!state.self && (
        <button
          type="button"
          className={state.following ? 'follow-btn on' : 'follow-btn'}
          onClick={toggle}
          disabled={busy}
          aria-pressed={state.following}
        >
          {state.following ? 'Following' : 'Follow'}
        </button>
      )}

      {note && (
        <span className="follow-note" role="status">
          {note}
        </span>
      )}

      {open && (
        <div className="follow-list">
          {entries === null ? (
            <p className="dim">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="dim">
              {open === 'followers' ? 'Nobody is following this trader yet.' : 'Not following anybody yet.'}
            </p>
          ) : (
            <ul>
              {entries.map((entry) => (
                <li key={entry.pubkey}>
                  <a href={`/p/${entry.pubkey}`}>
                    <span className="follow-who">{entry.name ?? short(entry.pubkey)}</span>
                    {entry.name && <span className="follow-addr">{short(entry.pubkey)}</span>}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
