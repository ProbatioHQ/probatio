/**
 * Runs once when the server starts.
 *
 * Only in the Node.js runtime — the edge runtime has no long-lived process to
 * hold a socket open, and starting one there would connect on every request.
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  if (process.env['PROBATIO_DISABLE_FEED'] === '1') return;

  const { startLiveFeed } = await import('./lib/live-feed');
  startLiveFeed();
}
