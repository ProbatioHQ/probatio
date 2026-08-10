/**
 * Prove the keeper can actually commit.
 *
 * Everything above the gateway was written against an interface, so this path
 * had never once run against a Solana runtime. This drives it end to end: a
 * season on chain, a batch committed through the real gateway, and the
 * accumulator read back and compared against the value computed locally.
 *
 * The comparison is the point. If the two agree, the encoding, the signing, the
 * address derivation and the account decoding are all correct — and if they
 * disagree, one of them is wrong and no amount of unit testing would say which.
 *
 *   npx tsx scripts/gateway-drill.mts [rpcUrl]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { RpcClient, findProgramAddress } from '@probatio/pools';
import { EMPTY_ACCUMULATOR, extendChain, fromHex, toHex } from '@probatio/commit';
import { compileMessage, encodeCompactU16, encodeMessage, type Instruction } from '@probatio/payments';
import {
  PROGRAM_ID,
  SolanaGateway,
  anchorDiscriminator,
  recordAddress,
  seasonAddress,
} from '@probatio/keeper';

const endpoint = process.argv[2] ?? 'http://127.0.0.1:8899';
const rpc = new RpcClient({ endpoint, timeoutMs: 30_000, commitment: 'confirmed' });

const authority = keypairFrom(`${homedir()}/.config/solana/id.json`);
const keeper = authority; // one key wears both hats in a drill

console.log(`endpoint   ${endpoint}`);
console.log(`program    ${PROGRAM_ID}`);
console.log(`authority  ${bs58.encode(authority.subarray(32))}\n`);

const ORDINAL = 7;
const season = seasonAddress(ORDINAL).address;
const trader = bs58.encode(new Uint8Array(32).fill(11));

// ---------------------------------------------------------------- init_season

const existing = await rpc.getAccount(season);
if (!existing) {
  const now = Math.floor(Date.now() / 1000);
  const params = encodeSeasonParams({
    ordinal: ORDINAL,
    keeper: keeper.subarray(32),
    startsAt: BigInt(now - 60),
    endsAt: BigInt(now + 7 * 24 * 3600),
    entryClosesAt: BigInt(now + 2 * 24 * 3600),
    startingBalance: 10_000_000_000n,
    entryCost: 0n,
    houseBps: 1000,
    houseThreshold: 1_000_000_000n,
    latencyMs: 600,
    slippageBps: 1000,
    maxPriceImpactBps: 5000,
    engineVersion: 1,
    scoringFormulaHash: new Uint8Array(32).fill(1),
  });

  const vault = seasonVault(season);
  await send(
    {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: bs58.encode(authority.subarray(32)), isSigner: true, isWritable: true },
        { pubkey: season, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false },
      ],
      data: concat(anchorDiscriminator('init_season'), params),
    },
    authority,
  );
  console.log(`season ${ORDINAL} created at ${season}`);
} else {
  console.log(`season ${ORDINAL} already exists at ${season}`);
}

// ---------------------------------------------------------------- commit_root

const gateway = new SolanaGateway({ rpc, keeperSecret: keeper });
console.log(`keeper     ${gateway.keeper}\n`);

const before = await gateway.readRecord(ORDINAL, trader);
console.log(`record before  ${before ? before.accumulator.slice(0, 16) + '…' : 'none'}`);

const roots = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)];
let expected = before ? fromHex(before.accumulator) : EMPTY_ACCUMULATOR;

for (const [index, root] of roots.entries()) {
  const leaves = 3 + index;
  const receipt = await gateway.commitRoot({
    seasonOrdinal: ORDINAL,
    trader,
    merkleRoot: root,
    leaves,
    engineVersion: 1,
  });
  expected = extendChain(expected, fromHex(root), leaves, 1);
  console.log(`  committed ${root.slice(0, 8)}… (${leaves} leaves)  slot ${receipt.slot}`);
}

const after = await gateway.readRecord(ORDINAL, trader);
if (!after) {
  console.error('\nno record on chain after committing — the gateway wrote nothing');
  process.exit(1);
}

console.log(`\nrecord address   ${recordAddress(season, trader).address}`);
console.log(`commits          ${after.commitCount}`);
console.log(`leaves           ${after.leafCount}`);
console.log(`chain says       ${after.accumulator}`);
console.log(`we computed      ${toHex(expected)}`);

const agrees = after.accumulator === toHex(expected);
console.log(
  agrees
    ? '\nThe chain and the local computation agree. The gateway works.'
    : '\nMISMATCH — one of the two is wrong and unit tests cannot say which.',
);
process.exit(agrees ? 0 : 1);

// --------------------------------------------------------------------- helpers

function keypairFrom(path: string): Uint8Array {
  return Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function seasonVault(seasonAddr: string): string {
  // The same derivation the program uses.
  const seed = new TextEncoder().encode('vault');
  return findProgramAddress([seed, bs58.decode(seasonAddr)], PROGRAM_ID).address;
}

function encodeSeasonParams(p: {
  ordinal: number;
  keeper: Uint8Array;
  startsAt: bigint;
  endsAt: bigint;
  entryClosesAt: bigint;
  startingBalance: bigint;
  entryCost: bigint;
  houseBps: number;
  houseThreshold: bigint;
  latencyMs: number;
  slippageBps: number;
  maxPriceImpactBps: number;
  engineVersion: number;
  scoringFormulaHash: Uint8Array;
}): Uint8Array {
  const bytes = new Uint8Array(2 + 32 + 8 * 3 + 8 * 2 + 2 + 8 + 4 + 2 + 2 + 4 + 32);
  const view = new DataView(bytes.buffer);
  let o = 0;
  view.setInt16(o, p.ordinal, true); o += 2;
  bytes.set(p.keeper, o); o += 32;
  view.setBigInt64(o, p.startsAt, true); o += 8;
  view.setBigInt64(o, p.endsAt, true); o += 8;
  view.setBigInt64(o, p.entryClosesAt, true); o += 8;
  view.setBigUint64(o, p.startingBalance, true); o += 8;
  view.setBigUint64(o, p.entryCost, true); o += 8;
  view.setUint16(o, p.houseBps, true); o += 2;
  view.setBigUint64(o, p.houseThreshold, true); o += 8;
  view.setUint32(o, p.latencyMs, true); o += 4;
  view.setUint16(o, p.slippageBps, true); o += 2;
  view.setUint16(o, p.maxPriceImpactBps, true); o += 2;
  view.setUint32(o, p.engineVersion, true); o += 4;
  bytes.set(p.scoringFormulaHash, o);
  return bytes;
}

async function send(instruction: Instruction, signer: Uint8Array): Promise<string> {
  const payer = bs58.encode(signer.subarray(32));
  const { blockhash } = await rpc.getLatestBlockhash();
  const message = encodeMessage(compileMessage(payer, blockhash, [instruction]));
  const signature = ed25519.sign(message, signer.subarray(0, 32));

  const tx = concat(encodeCompactU16(1), signature, message);
  const sent = await rpc.sendTransaction(Buffer.from(tx).toString('base64'));
  const settled = await rpc.confirmSignature(sent, { timeoutMs: 30_000 });
  if (!settled.confirmed) throw new Error(`transaction ${sent} did not confirm: ${JSON.stringify(settled.err)}`);
  return sent;
}
