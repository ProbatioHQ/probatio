/**
 * Runs once when the server starts.
 *
 * Only in the Node.js runtime — the edge runtime has no long-lived process to
 * hold a socket open, and starting one there would connect on every request.
 */

export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  // First, so it is already in place if anything below throws on the way up.
  // Dynamically imported like the workers below, so `process.on` never lands
  // in the edge bundle this file is also compiled into.
  const { guardTheProcess } = await import('./lib/process-guard');
  guardTheProcess();

  if (process.env['PROBATIO_DISABLE_FEED'] !== '1') {
    const { startLiveFeed } = await import('./lib/live-feed');
    startLiveFeed();
  }

  // Which lane a token sits in changes with its curve, not with its age, so
  // the curve accounts are polled. Tied to the feed switch because without a
  // feed there are no launches to watch.
  if (process.env['PROBATIO_DISABLE_FEED'] !== '1') {
    const { startCurveWatch } = await import('./lib/curve-watch');
    startCurveWatch();
  }

  // Probing runs even when the feed is disabled: knowing the chain is
  // unreachable matters more than the feed does.
  const { startProbing } = await import('./lib/health');
  startProbing();

  // Commits records to the chain. Does nothing without a key, and says so.
  const { startKeeper } = await import('./lib/keeper');
  startKeeper();

  // Measures the engine against real fills and takes farmable tokens off the
  // board. Tied to the feed switch only in the sense that both need the chain;
  // it is the one check that runs without anybody deciding to look.
  if (process.env['PROBATIO_DISABLE_DRIFT'] !== '1') {
    const { startDriftWatch } = await import('./lib/drift-watch');
    startDriftWatch();
  }
}
