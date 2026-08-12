import { backfillFromCurve } from '@probatio/candles';
import { RpcClient, bondingCurveAddress, decodeBondingCurve } from '@probatio/pools';

const endpoint = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const rpc = new RpcClient({ endpoint, timeoutMs: 30_000, minIntervalMs: 160, maxRetries: 7 });

for (const mint of process.argv.slice(2)) {
  try {
    const curveAddr = bondingCurveAddress(mint);
    const [acct] = await rpc.getAccounts([curveAddr]);
    if (!acct) { console.log(mint.slice(0,8), 'no curve'); continue; }
    const curve = decodeBondingCurve(acct.data);
    const sigs = await rpc.getSignatures(curveAddr, { limit: 1000 });
    const started = Date.now();
    const result = await backfillFromCurve(rpc, mint, curveAddr, { maxTransactions: 400, concurrency: 2 });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${mint.slice(0,8)} complete=${curve.complete} | ${sigs.length} sigs on curve | backfill got ${result.observations.length} obs in ${secs}s (truncated=${result.truncated})`);
  } catch (e) {
    console.log(mint.slice(0,8), 'ERR', (e as Error).message);
  }
}
