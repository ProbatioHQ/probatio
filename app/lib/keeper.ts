import 'server-only';
import { RpcClient } from '@probatio/pools';
import { Keeper, PROGRAM_ID, SolanaGateway, checkIdentity, runOnce } from '@probatio/keeper';
import { db } from './db';
import { rpcEndpoint } from './env';
import { parseSecretKey } from './season-onchain';

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

/** The programs that own a deployed BPF program's account. */
const LOADERS = new Set([
  'BPFLoader1111111111111111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
]);

function keeperSecret(): Uint8Array | null {
  const configured = process.env['KEEPER_KEYPAIR'];
  if (!configured) return null;

  try {
    // Accept the key as a JSON array, a base58 string (as Phantom exports it),
    // or a path to a keypair file — so a host with no persistent file can run
    // it from a variable in whichever form the operator has.
    return parseSecretKey(configured);
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

  const rpc = new RpcClient({
    endpoint: rpcEndpoint(),
    timeoutMs: 30_000,
    minIntervalMs: 100,
    priority: 'background',
  });
  const gateway = new SolanaGateway({ rpc, keeperSecret: secret });
  console.log(`[keeper] committing as ${gateway.keeper}`);

  // One keeper across cycles, not one per cycle. A halt is remembered on the
  // instance, and rebuilding it every minute would forget that the chain holds
  // something we did not write — then fold honest batches into a poisoned
  // chain, once a minute, forever.
  let keeper: Keeper | null = null;

  /*
   * Whether the program this writes to exists on the chain it is pointed at.
   *
   * It does not, and it is not going to: deploying it costs SOL that is not
   * being spent. Left alone the keeper built, signed and sent a transaction
   * every single cycle, had it rejected at simulation with "Attempt to load a
   * program that does not exist", discarded the intent, and did the whole thing
   * again a minute later. Forever, and loudly.
   *
   * Nothing was at risk — a discarded intent means the batch never landed and
   * is safely re-planned, so no trade is lost and nothing is double-written —
   * but an error every minute is an error that stops being read, which is how
   * a real failure gets missed later.
   *
   * So it is checked once, cheaply, before any of that. Absent, the keeper
   * stands down and says so once. Re-checked hourly rather than never, so
   * deploying the program later starts committing without a redeploy of this.
   */
  let programSeenAt = 0;
  let programMissing = false;
  const PROGRAM_RECHECK_MS = 60 * 60 * 1000;

  const programIsDeployed = async (): Promise<boolean> => {
    const now = Date.now();
    if (programMissing && now - programSeenAt < PROGRAM_RECHECK_MS) return false;
    try {
      const account = await rpc.getAccount(PROGRAM_ID);
      // Owned by a loader, not merely present. `getAccount` here does not carry
      // the executable flag, and an ordinary account sitting at that address
      // would accept no instruction, so it is as good as absent for this.
      const deployed = account !== null && LOADERS.has(account.owner);
      programSeenAt = now;
      if (!deployed && !programMissing) {
        programMissing = true;
        console.log(
          `[keeper] program ${PROGRAM_ID} is not deployed: standing down. ` +
            'Trades are still recorded and sealed locally, and will commit once it exists.',
        );
      }
      if (deployed && programMissing) {
        programMissing = false;
        console.log(`[keeper] program ${PROGRAM_ID} is live: committing again`);
      }
      return deployed;
    } catch (error) {
      // A failed lookup is not evidence of absence. Say so and try the work,
      // rather than standing down because one RPC call timed out.
      console.error('[keeper] could not check whether the program is deployed', error);
      return true;
    }
  };

  const tick = async (): Promise<void> => {
    if (!(await programIsDeployed())) return;

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

  // runOnce is only safe when its caller serializes it, and a bare setInterval
  // does not: a cycle can outlast CYCLE_MS (an unconfirmed commit alone can
  // block it for the confirm timeout), and a second concurrent tick would read
  // the same uncommitted trades and commit the same root twice, folding one
  // batch onto the other and halting the keeper on an accumulator it cannot
  // reconcile. A tick in flight makes the next one skip its turn.
  let running = false;
  const guarded = (label: string): void => {
    if (running) return;
    running = true;
    void tick()
      .catch((error) => console.error(`[keeper] ${label} failed`, error))
      .finally(() => {
        running = false;
      });
  };

  guarded('first cycle');
  const timer = setInterval(() => guarded('cycle'), CYCLE_MS);
  timer.unref?.();
}

export { checkIdentity };
