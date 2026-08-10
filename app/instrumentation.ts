/**
 * Runs once when the server starts.
 *
 * Only in the Node.js runtime — the edge runtime has no long-lived process to
 * hold a socket open, and starting one there would connect on every request.
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  if (process.env['PROBATIO_DISABLE_FEED'] !== '1') {
    const { startLiveFeed } = await import('./lib/live-feed');
    startLiveFeed();
  }

  // Probing runs even when the feed is disabled: knowing the chain is
  // unreachable matters more than the feed does.
  const { startProbing } = await import('./lib/health');
  startProbing();

  // Commits records to the chain. Does nothing without a key, and says so.
  const { startKeeper } = await import('./lib/keeper');
  startKeeper();
}
