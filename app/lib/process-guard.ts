import 'server-only';

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
 *
 * Its own module, and imported dynamically, so `process.on` never reaches the
 * edge bundle. `instrumentation.ts` is compiled for both runtimes, and having
 * these calls in it made every build print Edge-runtime warnings about an API
 * that was already guarded and could never run there — noise that is how a
 * real warning later gets scrolled past.
 */
export function guardTheProcess(): void {
  const store = globalThis as { __probatioGuarded?: boolean };
  // `register` can fire more than once across dev reloads.
  if (store.__probatioGuarded) return;
  store.__probatioGuarded = true;

  process.on('unhandledRejection', (reason) => {
    console.error('[process] unhandled rejection, surviving it', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('[process] uncaught exception, exiting for a clean restart', error);
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

  /*
   * Being asked to stop is not crashing.
   *
   * Every deploy replaces this container, and the platform replaces it by
   * sending SIGTERM. Node's default action for a signal it has no handler for
   * is to die *by* that signal, which the supervisor reads as exit code 143 and
   * reports as a crash. So every single deploy produced a crash notice for a
   * shutdown that went exactly as intended, and the notice that would mean
   * something — a real one — looked identical to the eleven before it that did
   * not. An alarm that fires on every deploy is an alarm nobody reads.
   *
   * Handling it makes the exit code honest: asked to stop, stopped, code zero.
   * This cannot hide a genuine failure, because the only sender of SIGTERM here
   * is the supervisor doing the replacing. A crash still leaves by the path
   * above with code 1, and an out-of-memory kill is SIGKILL, which no handler
   * can intercept.
   *
   * THIS ONLY WORKS WITH `NEXT_MANUAL_SIG_HANDLE=1`, WHICH railway.json SETS.
   *
   * Next installs its own SIGTERM handler that ends with `process.exit(143)` on
   * purpose, so that a signal termination stays a signal termination. That
   * handler is registered before this one and reaches its exit first, so adding
   * this alone changed nothing: measured through the real start command, the
   * process still left with 143 while this very line printed to the log. The
   * environment variable is Next's own documented way to take the signals back,
   * and without it this code is decoration.
   */
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[process] ${signal} received, shutting down`);

    /*
     * A moment, not a graceful drain.
     *
     * There is no handle on the HTTP server from here — this runs inside
     * Next's instrumentation hook, which is handed no listener to close. What
     * this can do is stop immediately rather than hang: the platform's own
     * timeout kills anything still here after its grace period, and being
     * killed at the end of a shutdown is the crash notice all over again.
     *
     * Long-lived readers (a price stream, a chart) reconnect on their own,
     * which they already do across every deploy.
     */
    // Not unref'd, for the same reason the crash path above is not: the exit
    // code is the whole point, and a timer that does not hold the loop can be
    // beaten to it by the loop emptying.
    setTimeout(() => process.exit(0), 250);
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
