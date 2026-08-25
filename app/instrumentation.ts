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
    /*
     * Launches come from pump.fun's own list by default, not from the chain.
     *
     * The socket version subscribed to every transaction touching the pump.fun
     * program, which is thousands a minute, to pick out the handful that are
     * launches. On a metered endpoint that was the single most expensive thing
     * the site owned, it ran whether or not anybody was here, and it emptied a
     * month of credits in six days.
     *
     * The socket is still here and still carries every trade, which is the one
     * thing polling cannot do. It is opt-in now, for an endpoint where a
     * firehose is free.
     */
    if (process.env['PROBATIO_FEED_SOURCE'] === 'stream') {
      const { startLiveFeed } = await import('./lib/live-feed');
      safely('launch feed', startLiveFeed);
    } else {
      const { startPolledFeed } = await import('./lib/polled-feed');
      safely('launch feed', startPolledFeed);
    }

    // Which lane a token sits in changes with its curve, not its age, so the
    // curve accounts are polled. Tied to the feed switch because without a feed
    // there are no launches to watch.
    const { startCurveWatch } = await import('./lib/curve-watch');
    safely('curve watch', startCurveWatch);
  }

  // Pushes a price the moment a watched token's market moves. Independent of
  // the launch feed: somebody can be looking at a chart on a server that is not
  // watching for launches at all.
  /*
   * Prices from pump.fun, always. It costs no RPC credits and it defers to the
   * subscription below whenever that is running, so it is the floor rather than
   * a replacement: with the subscription off, a chart moves; with it on, this
   * says nothing.
   */
  const { startPolledPrices } = await import('./lib/polled-prices');
  safely('polled prices', startPolledPrices);

  if (process.env['PROBATIO_DISABLE_PRICE_STREAM'] !== '1') {
    const { startPriceStream } = await import('./lib/price-stream');
    safely('price stream', startPriceStream);
  }

  /*
   * Runs the strategies people wrote in the form, so a season does not require
   * them to keep a machine awake for a fortnight.
   *
   * Started after the price sources on purpose. It screens its exits against the
   * last known price and only pays for a chain read when that screen says a level
   * is near, so a runner started before anything is pricing would spend a read on
   * every open position on its first pass.
   */
  const { startStrategyRunner } = await import('./lib/strategy-runner');
  safely('strategies', startStrategyRunner);

  /*
   * Scores duels whose window has closed.
   *
   * A duel ends at a time, and a time is not an event anything watches. Settling
   * on page view instead would mean a duel nobody opens is never scored, and the
   * loser choosing the moment they are measured by staying away.
   */
  const { startDuelSettler } = await import('./lib/duel-settle');
  safely('duels', startDuelSettler);

  // Commits records to the chain. Does nothing without a key, and says so.
  const { startKeeper } = await import('./lib/keeper');
  safely('keeper', startKeeper);

  // Pays the winners out of the prize wallet when a season ends. Does nothing
  // without a prize key.
  const { startSeasonPayout } = await import('./lib/season-payout');
  safely('season payout', startSeasonPayout);

  // Opens each season after the first, on the operator's weekly hours.
  const { startSeasonRollover } = await import('./lib/season-rollover');
  safely('season rollover', startSeasonRollover);

  /*
   * Reads the X link on every stored token down to the account behind it.
   *
   * A one-off that converges and then stops. It was a script, and a script is
   * an instruction to a person: every deploy that ran the migration and forgot
   * the script would leave the account-reuse condition counting a serial
   * promoter as a first-timer, with nothing anywhere saying so.
   */
  const { startHandleBackfill } = await import('./lib/handle-backfill');
  safely('handle backfill', startHandleBackfill);

  // Drops chart candles too old to draw and reclaims the space, so the one
  // table that grows on a timer cannot fill the disk and take the database down.
  const { startRetention } = await import('./lib/retention');
  safely('retention', startRetention);

  // The other half of retention. Raising the caps stops history being deleted;
  // this is what fetches history that was never there, so the largest tokens
  // open instantly instead of the first visitor waiting through eight requests.
  // Started after the pruner, whose budget it deliberately sits under.
  const { startChartWarm } = await import('./lib/chart-warm');
  safely('chart warm', startChartWarm);

  // Fills the real-trader board by walking pools on a schedule. Without it that
  // board waits for somebody to open exactly the right token and stays empty.
  const { startTraderWarm } = await import('./lib/trader-warm');
  safely('trader warm', startTraderWarm);

  // Keeps a price on every token somebody holds. Without it a position nobody
  // is looking at has no recent price, gets marked at cost, and the whole
  // leaderboard sits on its starting balance whatever anybody does.
  const { startMarkPrices } = await import('./lib/mark-prices');
  safely('mark prices', startMarkPrices);

  // House accounts trading free play through the real engine, so a fresh
  // deploy shows the simulator working rather than an empty board.
  const { startHouseTraders } = await import('./lib/house-traders');
  safely('house traders', startHouseTraders);

  // Pushes watched traders' fills into the chats that asked for them. Does
  // nothing without a bot token, and says so rather than querying every twenty
  // seconds for a result it would throw away.
  const { startWatchNotifier } = await import('./lib/telegram/notify');
  safely('telegram watches', startWatchNotifier);

  // Measures the engine against real fills and takes farmable tokens off the
  // board. Tied to the feed switch only in the sense that both need the chain;
  // it is the one check that runs without anybody deciding to look.
  if (process.env['PROBATIO_DISABLE_DRIFT'] !== '1') {
    const { startDriftWatch } = await import('./lib/drift-watch');
    safely('drift watch', startDriftWatch);
  }
}
