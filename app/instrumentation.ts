/**
 * Runs once when the server starts.
 *
 * Only in the Node.js runtime — the edge runtime has no long-lived process to
 * hold a socket open, and starting one there would connect on every request.
 */

/**
 * Boot one worker without letting its failure take the others down.
 *
 * The starts used to run in a bare sequence, so a synchronous throw in an early
 * one (a malformed RPC_URL rejected while opening the feed socket, say) rejected
 * register() and every later worker never ran. Worst of all, health probing sat
 * near the end of that sequence, so a boot failure left the server reporting
 * itself healthy while the feed, keeper, and drift monitor were all absent.
 * Each start is isolated here, and probing is started first below.
 */
function safely(label: string, start: () => void): void {
  try {
    start();
  } catch (error) {
    console.error(`[boot] ${label} failed to start`, error);
  }
}

export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  // First, so it is already in place if anything below throws on the way up.
  // Dynamically imported like the workers below, so `process.on` never lands
  // in the edge bundle this file is also compiled into.
  const { guardTheProcess } = await import('./lib/process-guard');
  guardTheProcess();

  // Health probing goes up first, so that whatever else fails to start, the
  // server can still tell the truth about it. Knowing the chain is unreachable
  // matters more than any single worker.
  const { startProbing } = await import('./lib/health');
  safely('health probing', startProbing);

  if (process.env['PROBATIO_DISABLE_FEED'] !== '1') {
    const { startLiveFeed } = await import('./lib/live-feed');
    safely('launch feed', startLiveFeed);

    // Which lane a token sits in changes with its curve, not its age, so the
    // curve accounts are polled. Tied to the feed switch because without a feed
    // there are no launches to watch.
    const { startCurveWatch } = await import('./lib/curve-watch');
    safely('curve watch', startCurveWatch);
  }

  // Pushes a price the moment a watched token's market moves. Independent of
  // the launch feed: somebody can be looking at a chart on a server that is not
  // watching for launches at all.
  if (process.env['PROBATIO_DISABLE_PRICE_STREAM'] !== '1') {
    const { startPriceStream } = await import('./lib/price-stream');
    safely('price stream', startPriceStream);
  }

  // Commits records to the chain. Does nothing without a key, and says so.
  const { startKeeper } = await import('./lib/keeper');
  safely('keeper', startKeeper);

  // Pays the winners out of the prize wallet when a season ends. Does nothing
  // without a prize key.
  const { startSeasonPayout } = await import('./lib/season-payout');
  safely('season payout', startSeasonPayout);

  // Drops chart candles too old to draw and reclaims the space, so the one
  // table that grows on a timer cannot fill the disk and take the database down.
  const { startRetention } = await import('./lib/retention');
  safely('retention', startRetention);

  // Measures the engine against real fills and takes farmable tokens off the
  // board. Tied to the feed switch only in the sense that both need the chain;
  // it is the one check that runs without anybody deciding to look.
  if (process.env['PROBATIO_DISABLE_DRIFT'] !== '1') {
    const { startDriftWatch } = await import('./lib/drift-watch');
    safely('drift watch', startDriftWatch);
  }
}
