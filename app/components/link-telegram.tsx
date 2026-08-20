'use client';

import { useState } from 'react';

/**
 * Enter the code the bot gave you.
 *
 * Deliberately plain. The interesting part of this flow happened before the
 * page loaded, which is that the wallet had to sign in, and there is nothing to
 * add here beyond taking eight characters and reporting exactly what went wrong
 * if they do not work.
 */
export function LinkTelegram() {
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (state === 'sending') return;
    setState('sending');
    setProblem(null);

    try {
      const response = await fetch('/api/telegram/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = (await response.json()) as { error?: string };
      if (response.ok) {
        setState('done');
        return;
      }
      setProblem(body.error ?? 'That did not work.');
      setState('idle');
    } catch {
      setProblem('Could not reach the site. Try again.');
      setState('idle');
    }
  }

  if (state === 'done') {
    return (
      <p className="dim">
        Linked. Your Telegram now trades this account, and the bot has told you so in the chat you
        started from.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="board-shell" style={{ maxWidth: 380 }}>
      <label className="field">
        <span>Code from the bot</span>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder="8 characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={12}
        />
      </label>

      <button type="submit" disabled={state === 'sending' || code.trim().length < 4}>
        {state === 'sending' ? 'Linking…' : 'Link'}
      </button>

      {problem && <p className="dim">{problem}</p>}
    </form>
  );
}
