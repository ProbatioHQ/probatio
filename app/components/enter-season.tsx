'use client';

import { useState } from 'react';
import { getPhantomSigner, PHANTOM_INSTALL_URL } from '@/lib/phantom';

/**
 * Paying to enter a ranked season.
 *
 * Two steps, and the second one is the one that counts. The wallet returns a
 * signature; the server reads the chain. Until it has, nothing is claimed —
 * this component never tells a user they are entered on the strength of the
 * wallet saying so.
 */

type Stage = 'idle' | 'building' | 'signing' | 'confirming' | 'entered' | 'error';

interface IntentResponse {
  reference: string;
  message: string;
  lamports: string;
  season: { ordinal: number; name: string };
  error?: string;
}

export function EnterSeason({ free = false }: { free?: boolean }) {
  const [stage, setStage] = useState<Stage>('idle');
  const [message, setMessage] = useState<string | null>(null);

  /**
   * A season that costs nothing has no transaction to sign.
   *
   * Walking somebody through a wallet prompt for a zero-lamport transfer would
   * be asking for a signature to move nothing, which is the sort of thing that
   * teaches people to approve prompts without reading them.
   */
  async function enterFree(): Promise<void> {
    setStage('confirming');
    setMessage(null);

    let body: { error?: string; entered?: boolean; seasonName?: string };
    try {
      const response = await fetch('/api/season/enter', { method: 'POST' });
      body = (await response.json()) as typeof body;
      if (!response.ok || !body.entered) {
        setStage('error');
        setMessage(body.error ?? 'Could not enter.');
        return;
      }
    } catch {
      // A dropped connection or a non-JSON error page must not leave the button
      // stuck on "confirming" with nothing said. Entry is free, so there is
      // nothing to lose by trying again.
      setStage('error');
      setMessage('The network could not be reached. Try again in a moment.');
      return;
    }

    setStage('entered');
    setMessage(`You are in ${body.seasonName ?? 'the season'}.`);
  }

  async function enter(): Promise<void> {
    const signer = getPhantomSigner();
    if (!signer) {
      setStage('error');
      setMessage('Phantom is not installed.');
      return;
    }

    setStage('building');
    setMessage(null);

    let intent: IntentResponse;
    try {
      const intentResponse = await fetch('/api/pay/intent', { method: 'POST' });
      intent = (await intentResponse.json()) as IntentResponse;
      if (!intentResponse.ok) {
        setStage('error');
        setMessage(intent.error ?? 'Could not start the payment.');
        return;
      }
    } catch {
      // Nothing has been signed yet, so a failed intent is safe to surface and
      // retry. The alternative was a button frozen on "building" forever.
      setStage('error');
      setMessage('The network could not be reached. Nothing was charged; try again.');
      return;
    }

    let signature: string;
    try {
      setStage('signing');
      const result = await signer.request({
        method: 'signAndSendTransaction',
        params: { message: intent.message },
      });
      signature = result.signature;
    } catch {
      // Declining is not a failure worth an error message.
      setStage('idle');
      return;
    }

    setStage('confirming');
    setMessage('Waiting for the network to finalize it. This takes a few seconds.');

    // Finalization is not instant, and a single check would report "not yet"
    // as often as it reported success.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch('/api/pay/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reference: intent.reference, signature }),
        });
        const body = (await response.json()) as { error?: string; settled?: boolean };

        if (response.ok && body.settled) {
          setStage('entered');
          setMessage(`You are in ${intent.season.name}.`);
          return;
        }
        if (response.status !== 202) {
          setStage('error');
          setMessage(body.error ?? 'The payment could not be confirmed.');
          return;
        }
      } catch {
        // One failed poll is not the answer. The transaction is already signed
        // and sent, so keep asking rather than declaring a loss on a blip.
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }

    // The payment may well have landed. Saying so plainly beats claiming a
    // failure we have not established.
    setStage('error');
    setMessage(
      'Still waiting on the network. Your payment is not lost, reload in a minute and it will be picked up.',
    );
  }

  if (stage === 'entered') {
    return (
      <section aria-label="Season entry" style={{ gap: 12 }}>
        <h2>Entered</h2>
        <p>{message}</p>
      </section>
    );
  }

  return (
    // No heading of its own: this renders inside the season panel, which has
    // already said which season it is. A second heading there read as a
    // separate section attached to nothing.
    <section aria-label="Season entry" style={{ gap: 12 }}>
      <p>
        {free
          ? 'Free to enter. The prize is put up rather than paid for by entries, so nothing ' +
            'leaves your wallet and there is nothing to sign.'
          : 'Entry is paid once, from your wallet. It goes to the prize pool, and the whole ' +
            'pool is paid back out when the season closes.'}
      </p>

      <button
        type="button"
        onClick={() => void (free ? enterFree() : enter())}
        disabled={stage !== 'idle' && stage !== 'error'}
      >
        {stage === 'building' && 'Preparing…'}
        {stage === 'signing' && 'Approve in Phantom…'}
        {stage === 'confirming' && (free ? 'Entering…' : 'Confirming…')}
        {(stage === 'idle' || stage === 'error') &&
          (free ? 'Enter, free' : 'Enter the season')}
      </button>

      {message && <p role={stage === 'error' ? 'alert' : undefined}>{message}</p>}

      {stage === 'error' && !free && !getPhantomSigner() && (
        <p>
          <a href={PHANTOM_INSTALL_URL} target="_blank" rel="noreferrer noopener">
            Install Phantom
          </a>
        </p>
      )}
    </section>
  );
}
