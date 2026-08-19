'use client';

import { useState } from 'react';
import { getPhantomSigner, PHANTOM_INSTALL_URL } from '@/lib/phantom';
import { useWallet } from './wallet';

/**
 * Buying practice balance.
 *
 * Free play starts everybody at ten SOL of play money, and some people want to
 * practise at the size they actually trade. That is what this sells, and the
 * page says plainly what it does not: it is not an entry, it is not a stake,
 * and it cannot reach a ranked season.
 *
 * Being honest about that is not a disclaimer, it is the product. A season
 * ranks by percentage return, so at a glance buying more looks harmless — until
 * you ask when somebody would buy. Down fifty percent, five SOL left of ten,
 * buy a hundred: the season reads minus four instead of minus fifty. Anybody up
 * would never buy, because it dilutes their gain. Allowing it would make the
 * leaderboard a measure of spending, so the credit goes to the free-play
 * account and a ranked season keeps the fixed balance in its published ruleset.
 */

interface Tier {
  sol: number;
  priceLamports: string;
  perSol: string;
}

interface IntentResponse {
  reference: string;
  message: string;
  sol: number;
  error?: string;
}

type Stage = 'idle' | 'building' | 'signing' | 'confirming' | 'bought' | 'error';

const LAMPORTS = 1_000_000_000;

function sol(lamports: string, places = 3): string {
  return (Number(lamports) / LAMPORTS).toFixed(places);
}

export function Store({ tiers, available }: { tiers: Tier[]; available: boolean }) {
  const { status } = useWallet();
  const signedIn = status === 'signed-in';

  const [stage, setStage] = useState<Stage>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);

  const busy = stage === 'building' || stage === 'signing' || stage === 'confirming';

  async function buy(size: number): Promise<void> {
    const signer = getPhantomSigner();
    if (!signer) {
      setStage('error');
      setMessage('Phantom is not installed.');
      return;
    }

    setChosen(size);
    setStage('building');
    setMessage(null);

    let intent: IntentResponse;
    try {
      const intentResponse = await fetch('/api/store/intent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sol: size }),
      });
      intent = (await intentResponse.json()) as IntentResponse;
      if (!intentResponse.ok) {
        setStage('error');
        setMessage(intent.error ?? 'Could not start the purchase.');
        return;
      }
    } catch {
      // Nothing has been signed yet. A dropped request must surface as an error
      // to retry, not a button stuck on "building" with no explanation.
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
    } catch (error) {
      /*
       * Declining is a decision. Everything else is a failure.
       *
       * This swallowed both, so a wallet that was locked, or not connected to
       * this site, or that rejected the request outright, all looked exactly
       * like somebody changing their mind: the button reset and nothing was
       * said. The one report of this was "I click buy and nothing happens",
       * which is precisely what a silent catch produces.
       *
       * Phantom signals a real decline with 4001, the same code the sign-in
       * flow already checks for. Anything else is worth saying out loud.
       */
      const code = (error as { code?: number } | null)?.code;
      const detail = error instanceof Error ? error.message : String(error);
      if (code === 4001 || /user rejected|declined/i.test(detail)) {
        setStage('idle');
        return;
      }
      console.error('[store] the wallet refused the transaction', error);
      setStage('error');
      setMessage(`Your wallet could not send that: ${detail}`);
      return;
    }

    setStage('confirming');
    setMessage('Waiting for the network. This takes a few seconds.');

    // The balance is credited only once the transfer is verified on chain, so
    // this waits rather than reporting a purchase the chain has not confirmed.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch('/api/pay/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reference: intent.reference, signature }),
        });
        const body = (await response.json()) as { error?: string; settled?: boolean; sol?: number };

        if (response.ok && body.settled) {
          setStage('bought');
          setMessage(`${body.sol ?? size} SOL added to your free play balance.`);
          return;
        }
        if (response.status !== 202) {
          setStage('error');
          setMessage(body.error ?? 'The payment could not be confirmed.');
          return;
        }
      } catch {
        // The transfer is signed and sent; a single failed poll is a blip, not
        // a reason to stop waiting for the credit.
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }

    setStage('error');
    setMessage('The payment was sent but has not confirmed yet. It will be credited once it does.');
  }

  const cheapest = tiers.length > 0 ? Number(tiers[0]!.perSol) : 0;

  return (
    <section className="term">
      <div className="term-bar">
        <span className="prompt">~/store</span>
        <span>practice balance</span>
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
      </div>

      <div className="term-body">
        <h1 style={{ fontSize: 26 }}>Buy practice balance</h1>
        <p className="dim">
          Free play gives everyone 10 SOL of paper money. Buy more if you want to practise at
          the size you actually trade. Bigger sizes cost less per SOL.
        </p>

        <div className="store-grid">
          {tiers.map((tier) => {
            const discount =
              cheapest > 0 ? Math.round((1 - Number(tier.perSol) / cheapest) * 100) : 0;
            return (
              <button
                key={tier.sol}
                type="button"
                className="store-tier"
                disabled={!signedIn || !available || busy}
                onClick={() => void buy(tier.sol)}
              >
                <span className="store-size">{tier.sol} SOL</span>
                <span className="store-price">{sol(tier.priceLamports)} SOL</span>
                <span className="store-rate">
                  {discount > 0 ? `${discount}% cheaper per SOL` : 'practice balance'}
                </span>
                {busy && chosen === tier.sol && <span className="store-busy">{stage}…</span>}
              </button>
            );
          })}
        </div>

        {!available && (
          <p className="dim">
            The store is closed on this server. No payment address is configured, so nothing can
            be taken.
          </p>
        )}
        {available && !signedIn && <p className="dim">Connect your wallet to buy.</p>}
        {message && (
          <p className={stage === 'error' ? 'loss' : 'accent mono'} role="status">
            {message}
          </p>
        )}

        <hr />

        {/* One line, where somebody is deciding whether to buy.
            
            It was a paragraph arguing the case: that a season fixes everybody's
            balance, that buying in would let a trader down fifty percent buy
            the loss away, that the board would then measure spending. All true,
            and all reasoning about a decision already taken, sitting under a
            price list where the only question is what this money is for. The
            argument lives on the scoring page, where somebody asking why can
            find it. */}
        <p className="dim" style={{ fontSize: 13.5 }}>
          <strong>Free play only.</strong> Ranked seasons start everybody on the same balance, so
          none of this goes into one. <a href="/docs/scoring">Why</a>.
        </p>

        {!getPhantomSigner() && (
          <p className="dim">
            <a href={PHANTOM_INSTALL_URL} rel="noreferrer noopener" target="_blank">
              Get Phantom
            </a>{' '}
            to pay.
          </p>
        )}
      </div>
    </section>
  );
}
