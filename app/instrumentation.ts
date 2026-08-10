/**
 * Runs once when the server starts.
 *
 * Only in the Node.js runtime — the edge runtime has no long-lived process to
 * hold a socket open, and starting one there would connect on every request.
 */

/**
 * Keep one stray rejection from taking the site down.
 *
 * This process holds a websocket, a server-sent stream per reader, and four
 * background loops that run for as long as the server does. Every one of them
 * catches its own errors today — but "today" is the operative word, and since
 * Node 15 an unhandled rejection anywhere, including inside a dependency,
 * terminates the process. Losing the whole site because one image fetch
 * rejected in a corner nobody had a `catch` on is the wrong trade.
 *
 * The two cases are handled differently on purpose. A rejected promise is
 * almost always one task failing and the rest of the process being fine, so it
 * is logged loudly and survived. An uncaught exception unwound a stack that
 * expected to finish, so the process may now be holding a half-written
 * transaction or a broken invariant — that one is logged and then handed to
 * the supervisor to restart cleanly, because continuing on is how a crash
 * becomes corruption.
 */
function guardTheProcess(): void {
  // `register` can fire more than once across dev reloads.
  if ((globalThis as { __probatioGuarded?: boolean }).__probatioGuarded) return;
  (globalThis as { __probatioGuarded?: boolean }).__probatioGuarded = true;

  process.on('unhandledRejection', (reason) => {
    console.error('[process] unhandled rejection — surviving it', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('[process] uncaught exception — exiting for a clean restart', error);
    /*
     * Not unref'd, deliberately.
     *
     * An unref'd timer does not hold the event loop open, so if the loop
     * happened to be empty at that moment the process would exit on its own
     * with code 0 — reporting a clean shutdown after a crash, which is exactly
     * the signal that stops a supervisor restarting it. Holding the loop for
     * the flush guarantees the exit code is the one that means "restart me".
     */
    setTimeout(() => process.exit(1), 100);
  });
}

export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  // First, so it is already in place if anything below throws on the way up.
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
}
