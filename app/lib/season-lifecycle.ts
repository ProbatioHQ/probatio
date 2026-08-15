import 'server-only';
import { RpcClient } from '@probatio/pools';
import { AuthorityGateway, nextSeasonTransition, seasonAddress } from '@probatio/vault';
import { currentRankedSeason, seasonOnchainPubkey, setSeasonOnchain, setSeasonStatus } from '@probatio/db';
import { db } from './db';
import { rpcEndpoint } from './env';
import { authorityKeypair, keeperPublicKey, seasonParamsForRow } from './season-onchain';

/**
 * Puts a season on chain and walks it through its lifecycle.
 *
 * A ranked season lives in the database the moment it is created, but nothing
 * can be paid into it until it exists on chain: `record_entry` funds a vault,
 * and there is no vault until `init_season`. This worker is what creates it,
 * opens its entries, and starts it trading, on the schedule the season already
 * committed to.
 *
 * It runs only when an authority key is configured, exactly like the keeper
 * runs only with a keeper key. Without one the paid path stays closed rather
 * than half-open, which is the correct state to be in.
 *
 * The database status is advanced to mirror the chain. A transition that fails
 * because the chain is already past it is logged and left for the next tick;
 * the chain is the authority, this only follows it.
 */

const CYCLE_MS = 30_000;
let started = false;

export function startSeasonLifecycle(): void {
  if (started) return;

  const authority = authorityKeypair();
  if (!authority) {
    console.log('[season] no authority key: ranked seasons will not be created on chain');
    return;
  }
  const keeper = keeperPublicKey();
  if (!keeper) {
    console.log('[season] no keeper key: a season needs one named as its committer');
    return;
  }

  started = true;
  const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 30_000, minIntervalMs: 100 });
  const gateway = new AuthorityGateway({ rpc, authoritySecret: authority.secret });
  console.log(`[season] lifecycle running as authority ${gateway.authority}`);

  const tick = async (): Promise<void> => {
    const client = await db();
    const now = Date.now();

    const season = await currentRankedSeason(client, now);
    // Free play (a negative ordinal) has no vault and never needs any of this.
    if (!season || !season.ranked || season.ordinal < 0) return;

    const onchain = await seasonOnchainPubkey(client, season.id);
    const transition = nextSeasonTransition({
      onChain: onchain !== null,
      status: season.status,
      entryOpensAtMs: season.entryOpensAt,
      entryClosesAtMs: season.entryClosesAt,
      nowMs: now,
    });
    if (transition === 'none') return;

    try {
      if (transition === 'init') {
        const params = seasonParamsForRow(season, keeper);
        await gateway.createSeason(params);
        await setSeasonOnchain(client, {
          seasonId: season.id,
          onchainPubkey: seasonAddress(season.ordinal).address,
        });
        console.log(`[season] created season ${season.ordinal} on chain`);
      } else if (transition === 'open_entries') {
        await gateway.openEntries(season.ordinal);
        await setSeasonStatus(client, { seasonId: season.id, status: 'entry_open' });
        console.log(`[season] opened entries for season ${season.ordinal}`);
      } else if (transition === 'start_trading') {
        await gateway.startTrading(season.ordinal);
        await setSeasonStatus(client, { seasonId: season.id, status: 'running' });
        console.log(`[season] started trading for season ${season.ordinal}`);
      }
    } catch (error) {
      console.error(`[season] ${transition} for season ${season.ordinal} failed`, error);
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), CYCLE_MS);
  if (typeof timer.unref === 'function') timer.unref();
}
