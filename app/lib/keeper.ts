import 'server-only';
import { readFileSync } from 'node:fs';
import { RpcClient } from '@probatio/pools';
import { Keeper, SolanaGateway, checkIdentity, runOnce } from '@probatio/keeper';
import { db } from './db';
import { rpcEndpoint } from './env';

/**
 * The loop that puts records on chain.
 *
 * Nothing above this ran in production before: the gateway was an interface
 * with only test doubles behind it, so no trade was ever committed and every
 * record read as unverified. This is what makes the claim on the front page
 * true rather than pending.
 *
 * Started only when a keeper key is configured. Unset, the app runs exactly as
 * it did — trades are recorded locally and reported honestly as uncommitted,
 * which is the state to be in rather than pretending otherwise.
 */

const CYCLE_MS = 60_000;
let started = false;

function keeperSecret(): Uint8Array | null {
  const path = process.env['KEEPER_KEYPAIR'];
  if (!path) return null;

  try {
    return Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
  } catch (error) {
    // A configured key that cannot be read is a misconfiguration, not an
    // absence, and silently falling back to committing nothing would look
    // identical to working.
    console.error('[keeper] KEEPER_KEYPAIR is set but could not be read', error);
    return null;
  }
}

export function startKeeper(): void {
  if (started) return;

  const secret = keeperSecret();
  if (!secret) {
    console.log('[keeper] no key configured: trades will be recorded but not committed');
    return;
  }

  started = true;

  const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 30_000, minIntervalMs: 100 });
  const gateway = new SolanaGateway({ rpc, keeperSecret: secret });
  console.log(`[keeper] committing as ${gateway.keeper}`);

  // One keeper across cycles, not one per cycle. A halt is remembered on the
  // instance, and rebuilding it every minute would forget that the chain holds
  // something we did not write — then fold honest batches into a poisoned
  // chain, once a minute, forever.
  let keeper: Keeper | null = null;

  const tick = async (): Promise<void> => {
    const client = await db();
    keeper ??= new Keeper(client, gateway);

    if (keeper.halted) {
      console.error(`[keeper] halted: ${keeper.halted}`);
      return;
    }

    const seasons = await client.execute('SELECT id, ordinal FROM seasons');
    const ordinals = new Map(
      seasons.rows.map((row) => [Number(row['id']), Number(row['ordinal'])]),
    );

    const result = await runOnce(client, keeper, {
      seasonOrdinalFor: (seasonId) => {
        const ordinal = ordinals.get(seasonId);
        if (ordinal === undefined) throw new Error(`no ordinal for season ${seasonId}`);
        return ordinal;
      },
    });

    /*
     * Anything that happened, including nothing working.
     *
     * This used to log only on a committed batch, a reconcile or a halt — so a
     * keeper failing every single cycle produced a completely silent log. That
     * is the worst possible shape for this particular failure: commits quietly
     * stop, every record stays uncommitted, the central claim of the product
     * stops being true, and the only signal is an absence of output that looks
     * exactly like a quiet, healthy system.
     */
    if (
      result.committed > 0 ||
      result.reconciled > 0 ||
      result.discarded > 0 ||
      result.failed > 0 ||
      result.halted
    ) {
      const line =
        `[keeper] committed ${result.committed} batch(es), ${result.tradesCommitted} trade(s), ` +
        `reconciled ${result.reconciled}, discarded ${result.discarded}, failed ${result.failed}` +
        (result.halted ? ` HALTED: ${result.halted}` : '');

      if (result.failed > 0 || result.halted) console.error(line);
      else console.log(line);

      // The reasons, not just the count. Bounded so a bad cycle cannot fill
      // the log with one line per trader.
      for (const message of result.errors.slice(0, 5)) {
        console.error(`[keeper]   ${message}`);
      }
      if (result.errors.length > 5) {
        console.error(`[keeper]   …and ${result.errors.length - 5} more`);
      }
    }
  };

  void tick().catch((error) => console.error('[keeper] first cycle failed', error));
  const timer = setInterval(() => {
    void tick().catch((error) => console.error('[keeper] cycle failed', error));
  }, CYCLE_MS);
  timer.unref?.();
}

export { checkIdentity };
