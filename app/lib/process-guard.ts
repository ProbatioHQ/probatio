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
}
