import { describe, expect, it } from 'vitest';
import { PoolReader } from '../src/reader';
import { RpcClient } from '../src/rpc';
import {
  PUMPFUN_TOKEN_TOTAL_SUPPLY,
  PUMP_PROGRAM_ID,
  bondingCurveAddress,
  decodeBondingCurve,
} from '../src/pumpfun';

/**
 * Validation against live mainnet accounts.
 *
 * A binary layout that is subtly wrong does not throw — it produces plausible
 * numbers that simply are not the market. Fixtures cannot catch that on their
 * own, because a fixture is only ever as correct as the decoder that captured
 * it. Reading real accounts and asserting the invariants the venue itself
 * guarantees is the only check that can fail when the layout drifts.
 *
 * This also validates PDA derivation: if the derived curve address were wrong,
 * there would be no account at it.
 *
 * Skipped by default so the suite stays offline and deterministic. To run:
 *
 *   RPC_VALIDATION=1 npx vitest run packages/pools/test/mainnet.test.ts
 *
 * Optionally set RPC_URL; the public endpoint is heavily rate-limited.
 */

const ENABLED = process.env['RPC_VALIDATION'] === '1';
const RPC_URL = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';

// Live pump.fun mints. Any of these may graduate over time, which the reader
// handles as a first-class outcome rather than a failure.
const GRADUATED_MINT = 'J5reXJehdCV86HPHg2ewbeGYfMkxQT2YmLcg4DVfpump';

const MINTS = [
  '5CKuyx8kqzwHVZKoRMstBih9wteTv4XoSBq48j7Zpump',
  '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump',
  'BepXrvvfoFohZBSRTLnesHMpjy7EkRjyUVAA39rZpump',
  'J5reXJehdCV86HPHg2ewbeGYfMkxQT2YmLcg4DVfpump',
];

describe.skipIf(!ENABLED)('decoders against mainnet', () => {
  const rpc = new RpcClient({ endpoint: RPC_URL, timeoutMs: 30_000 });
  const reader = new PoolReader(rpc);

  it.each(MINTS)('decodes the bonding curve for %s', async (mint) => {
    const curveAddress = bondingCurveAddress(mint);
    const account = await rpc.getAccount(curveAddress);

    // The derived address existing at all is the PDA check.
    expect(account, `no account at derived curve address ${curveAddress}`).not.toBeNull();
    expect(account!.owner).toBe(PUMP_PROGRAM_ID);

    const curve = decodeBondingCurve(account!.data);

    // Holds whatever the curve's state — the supply is minted once and fixed,
    // so a wrong offset shows up here immediately.
    expect(curve.tokenTotalSupply).toBe(PUMPFUN_TOKEN_TOTAL_SUPPLY);
    expect(curve.creator.length).toBeGreaterThanOrEqual(32);

    if (curve.complete) {
      // Graduation drains the curve into the AMM, so every reserve reads zero.
      // That is the correct value, not a decode failure.
      expect(curve.virtualSolReserves).toBe(0n);
      expect(curve.virtualTokenReserves).toBe(0n);
      expect(curve.realTokenReserves).toBe(0n);
      return;
    }

    // Invariants a live curve guarantees. A violation means an offset is
    // wrong, not that the market is unusual.
    expect(curve.virtualSolReserves).toBeGreaterThan(0n);
    expect(curve.virtualTokenReserves).toBeGreaterThan(0n);
    expect(curve.realTokenReserves).toBeLessThanOrEqual(curve.tokenTotalSupply);
    expect(curve.realTokenReserves).toBeLessThanOrEqual(curve.virtualTokenReserves);

    // A curve is seeded with ~30 SOL of virtual liquidity and grows from
    // there, so this should never read as dust or as an absurd number.
    expect(curve.virtualSolReserves).toBeGreaterThan(1_000_000_000n);
    expect(curve.virtualSolReserves).toBeLessThan(10_000_000_000_000n);

    // Implied market cap should land somewhere a real market could be.
    const price = Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves);
    const marketCapSol = (Number(curve.tokenTotalSupply) * price) / 1e9;
    expect(marketCapSol).toBeGreaterThan(0);
    expect(marketCapSol).toBeLessThan(1_000_000);
  });

  it.each(MINTS)('resolves %s through the reader', async (mint) => {
    const resolution = await reader.resolve(mint);
    expect(resolution.slot).toBeGreaterThan(0);

    if (resolution.venue.kind === 'unlisted') {
      // Graduated with no successor pool found. Nothing is quotable, and the
      // reader says so rather than pricing a dead curve.
      expect(resolution.pool).toBeNull();
      return;
    }

    const pool = resolution.pool!;
    expect(pool).not.toBeNull();
    expect(pool.tokenDecimals).toBe(6);
    expect(pool.solReserve).toBeGreaterThan(0n);
    expect(pool.tokenReserve).toBeGreaterThan(0n);

    if (resolution.venue.kind === 'pumpfun-curve') {
      expect(pool.source).toBe('pumpfun-curve');
      // A curve can deliver less than it prices against.
      expect(pool.deliverableTokens).toBeLessThanOrEqual(pool.tokenReserve);
    } else {
      // Graduated tokens must follow through to the live AMM rather than
      // returning the drained curve.
      expect(resolution.venue.graduated).toBe(true);
      expect(pool.source).toBe('pumpswap');
      // An AMM holds its reserves outright, so everything is deliverable.
      expect(pool.deliverableTokens).toBe(pool.tokenReserve);
    }
  });

  it('follows a known graduated token through to its PumpSwap pool', async () => {
    const resolution = await reader.resolve(GRADUATED_MINT);
    expect(resolution.venue.kind).toBe('pumpswap');
    expect(resolution.pool!.source).toBe('pumpswap');
    expect(resolution.pool!.solReserve).toBeGreaterThan(0n);
  });

  it('finds the PumpSwap pool for a graduated mint', async () => {
    const pools = await reader.findPumpSwapPools(GRADUATED_MINT);
    expect(pools.length).toBeGreaterThan(0);
    expect(pools[0]!.pool.baseMint).toBe(GRADUATED_MINT);
  });

  it('reports a slot', async () => {
    expect(await rpc.getSlot()).toBeGreaterThan(300_000_000);
  });
});
