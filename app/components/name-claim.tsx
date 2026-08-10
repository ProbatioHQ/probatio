'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Choosing a display name.
 *
 * Kept quiet about what it is: a label over a wallet address, not an account.
 * The address is what results belong to, and the copy says so, because a name
 * that felt like an identity would make losing one feel like losing a record.
 */

export function NameClaim() {
  const [current, setCurrent] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch('/api/name');
    if (response.status === 401) {
      setSignedIn(false);
      return;
    }
    const body = (await response.json()) as { name: string | null };
    setSignedIn(true);
    setCurrent(body.name);
  }, []);

  useEffect(() => {
    void load().catch(() => setSignedIn(false));
  }, [load]);

  if (!signedIn) return null;

  async function submit(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: draft }),
      });
      const body = (await response.json()) as { error?: string; name?: string };
      if (!response.ok) {
        setMessage(body.error ?? 'That name could not be set.');
        return;
      }
      setDraft('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Display name" className="panel">
      <h2>Display name</h2>
      {current ? (
        <p>You appear as {current}.</p>
      ) : (
        <p>You appear as your wallet address.</p>
      )}

      <label>
        {current ? 'Change it' : 'Pick one'}
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="3–20 letters, digits, _ or -"
          spellCheck={false}
        />
      </label>

      <button type="button" onClick={() => void submit()} disabled={busy || draft.trim() === ''}>
        {busy ? 'Saving…' : 'Save'}
      </button>

      {message && <p role="alert">{message}</p>}

      <p>
        <small>
          A name is a label over your wallet address. Your record belongs to the address, so
          changing or losing a name never changes a result.
        </small>
      </p>
    </section>
  );
}
