/**
 * End-to-end proof that the payout path works against the real program.
 *
 * Drives the whole loop on a cluster: create a season, open it, enter it, start
 * it, finalize it, and claim the prize -- signing each step the way the app
 * would, with the same @probatio/vault encoders. It asserts the winner's
 * balance actually rose and the on-chain entry is marked claimed.
 *
 * Runs against whatever RPC_URL points at, defaulting to a local validator. To
 * verify on devnet, point RPC_URL at devnet and fund the payer it prints.
 *
 *   solana-test-validator --reset \
 *     --bpf-program HRGEAiqX4qw7B1fgNsR64oRAKF4QwkjkZFx9YXDFxaXA program/target/deploy/probatio.so
 *   npx tsx scripts/e2e-payout.mts
 */
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { RpcClient } from '@probatio/pools';
import { compileMessage, encodeCompactU16, encodeMessage, type Instruction } from '@probatio/payments';
import {
  AuthorityGateway,
  claimPrize,
  decodeEntry,
  entryAddress,
  recordEntry,
  seasonAddress,
  seasonParamsFrom,
} from '@probatio/vault';
import { rulesetFor, rulesetHashHex } from '@probatio/seasons';
import { buildFinalization } from '@probatio/scoring';
import { EMPTY_ACCUMULATOR, fromHex, toHex } from '@probatio/commit';

const URL = process.env['RPC_URL'] ?? 'http://127.0.0.1:8899';

interface Keypair {
  readonly secret: Uint8Array;
  readonly publicKey: string;
}
function keypair(): Keypair {
  const seed = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(seed);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(pub, 32);
  return { secret, publicKey: bs58.encode(pub) };
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function airdrop(pubkey: string, lamports: number): Promise<void> {
  const sig = await rpcCall<string>('requestAirdrop', [pubkey, lamports]);
  for (let i = 0; i < 40; i += 1) {
    const status = await rpcCall<{ value: ({ confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[sig]]);
    const s = status.value[0];
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return;
    await sleep(250);
  }
  throw new Error('airdrop did not confirm');
}

async function balance(pubkey: string): Promise<bigint> {
  const result = await rpcCall<{ value: number }>('getBalance', [pubkey, { commitment: 'confirmed' }]);
  return BigInt(result.value);
}

/** Send a single-instruction transaction signed by one wallet. */
async function send(rpc: RpcClient, signer: Keypair, instruction: Instruction): Promise<string> {
  const { blockhash } = await rpc.getLatestBlockhash();
  const message = encodeMessage(compileMessage(signer.publicKey, blockhash, [instruction]));
  const signature = ed25519.sign(message, signer.secret.subarray(0, 32));
  const tx = new Uint8Array(1 + 64 + message.length);
  tx.set(encodeCompactU16(1), 0);
  tx.set(signature, 1);
  tx.set(message, 65);
  const sent = await rpc.sendTransaction(Buffer.from(tx).toString('base64'));
  const settled = await rpc.confirmSignature(sent, { timeoutMs: 30_000 });
  if (!settled.confirmed) throw new Error(`transaction failed: ${JSON.stringify(settled.err)}`);
  return sent;
}

/** The cluster's own clock, which a test validator drifts from wall time. */
async function onChainSeconds(): Promise<number> {
  const slot = await rpcCall<number>('getSlot', [{ commitment: 'confirmed' }]);
  const time = await rpcCall<number | null>('getBlockTime', [slot]);
  return time ?? Math.floor(Date.now() / 1000);
}

async function waitOnChainUntil(targetSec: number): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    if ((await onChainSeconds()) > targetSec) return;
    await sleep(500);
  }
  throw new Error(`on-chain clock never reached ${targetSec}`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function main(): Promise<void> {
  const rpc = new RpcClient({ endpoint: URL, timeoutMs: 30_000, minIntervalMs: 0 });
  const authority = keypair();
  const keeper = keypair();
  const trader = keypair();

  console.log(`RPC ${URL}`);
  console.log(`authority ${authority.publicKey}`);
  await airdrop(authority.publicKey, 5_000_000_000);
  await airdrop(trader.publicKey, 2_000_000_000);

  const gateway = new AuthorityGateway({ rpc, authoritySecret: authority.secret });

  // The admin has to exist before any season can be created. The authority is
  // the admin here.
  await gateway.initConfig(authority.publicKey);
  console.log('  init_config ok (admin set)');

  const ordinal = 1;
  const ruleset = rulesetFor(ordinal);
  const nowSec = await onChainSeconds();
  const entryClosesSec = nowSec + 5;
  const endsSec = nowSec + 12;

  const params = seasonParamsFrom({
    ordinal,
    keeper: keeper.publicKey,
    startsAtMs: nowSec * 1000,
    endsAtMs: endsSec * 1000,
    entryClosesAtMs: entryClosesSec * 1000,
    startingBalance: ruleset.startingBalance,
    entryCost: ruleset.entryCost,
    houseBps: ruleset.houseBps,
    houseThreshold: ruleset.houseThreshold,
    latencyMs: ruleset.latencyMs,
    slippageBps: ruleset.slippageBps,
    maxPriceImpactBps: ruleset.maxPriceImpactBps,
    engineVersion: ruleset.engineVersion,
    scoringFormulaHashHex: rulesetHashHex(ruleset),
  });

  await gateway.createSeason(params);
  console.log('  init_season ok');
  await gateway.openEntries(ordinal);
  console.log('  open_entries ok');

  await send(rpc, trader, recordEntry({ trader: trader.publicKey, ordinal }));
  console.log('  record_entry ok (fee into the vault)');

  await waitOnChainUntil(entryClosesSec);
  await gateway.startTrading(ordinal);
  console.log('  start_trading ok');

  await waitOnChainUntil(endsSec);

  const finalization = buildFinalization({
    seasonOrdinal: ordinal,
    rulesetHash: rulesetHashHex(ruleset),
    ruleset,
    potLamports: ruleset.entryCost,
    houseBaseLamports: ruleset.entryCost,
    entrants: [
      {
        standing: {
          trader: trader.publicKey,
          enteredAt: nowSec * 1000,
          startingBalance: ruleset.startingBalance,
          finalEquity: ruleset.startingBalance * 2n,
          tradeCount: 1,
        },
        accumulator: toHex(EMPTY_ACCUMULATOR),
      },
    ],
  });

  await gateway.finalizeSeason(ordinal, fromHex(finalization.resultsRoot));
  console.log(`  finalize_season ok (root ${finalization.resultsRoot.slice(0, 12)}...)`);

  const row = finalization.rows[0]!;
  assert(row.payoutLamports > 0n, 'the winner has a payout');

  const before = await balance(trader.publicKey);
  await send(
    rpc,
    trader,
    claimPrize({
      payer: trader.publicKey,
      trader: trader.publicKey,
      ordinal,
      claim: {
        rank: row.rank,
        startingBalance: row.startingBalance,
        finalEquity: row.finalEquity,
        returnBps: row.returnBps,
        tradeCount: row.tradeCount,
        payoutLamports: row.payoutLamports,
      },
      proof: row.proof,
    }),
  );
  const after = await balance(trader.publicKey);
  console.log(`  claim_prize ok (payout ${row.payoutLamports} lamports)`);

  const entryPda = entryAddress(seasonAddress(ordinal).address, trader.publicKey).address;
  const account = await rpc.getAccount(entryPda);
  assert(account !== null, 'the entry exists');
  assert(decodeEntry(account!.data).claimed, 'the entry is marked claimed');
  // The balance rose by the payout minus the claim transaction fee (~5000).
  assert(after > before, `balance rose: ${before} -> ${after}`);

  console.log('\nE2E PAYOUT OK: entry funded the vault, and the winner was paid from it.');
}

main().catch((error) => {
  console.error('\nE2E PAYOUT FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
