'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Writing a strategy, and watching it run.
 *
 * The rules here are the rules the backtester already answers questions about,
 * so a strategy can be tried against real history before a season is spent on
 * it. That is the whole argument for the form existing: the same shape, tested
 * one way and then run the other.
 *
 * Two things this deliberately shows rather than hides. The daily order cap, so
 * a strategy that has stopped trading says why instead of looking broken; and
 * the log of refusals, because "would have moved the price 812 bps, cap is 500"
 * is the most useful line this page can display and the one a tidier interface
 * would have thrown away.
 */

interface Rules {
  entry: {
    minAgeSeconds?: number | string;
    maxAgeSeconds?: number | string;
    minLiquidityLamports?: string;
    minMarketCapLamports?: string;
    maxMarketCapLamports?: string;
    minChangeBps?: number | string;
    maxChangeBps?: number | string;
    changeWindowSeconds?: number | string;
    venue?: string;
    requireTwitter?: boolean;
    requireWebsite?: boolean;
    maxCreatorLaunches?: number | string;
    maxCreatorHoldingBps?: number | string;
    maxBundleBps?: number | string;
    minHolders?: number | string;
    maxSocialReuse?: number | string;
  };
  size: { stakeLamports: string; minStakeLamports?: string; maxOpenPositions: number | string };
  exit: {
    takeProfitBps?: number | string;
    stopLossBps?: number | string;
    timeoutSeconds?: number | string;
  };
}

interface Event {
  at: number;
  kind: string;
  mint: string | null;
  detail: string;
}

interface Loaded {
  season: { id: number; ordinal: number; status: string; endsAt: number | null } | null;
  /** Whether they actually bought an entry. A strategy needs one, same as a click. */
  entered?: boolean;
  strategy: {
    id: number;
    name: string;
    rules: Rules;
    status: 'draft' | 'running' | 'stopped';
    stoppedReason: string | null;
  } | null;
  events: Event[];
  openPositions: number;
  limits: { automatedOrdersToday: number; dailyCap: number } | null;
}

/**
 * A replay of the exit rules over one token's real swaps.
 *
 * Only the exits. The entry conditions decide *which* token, and a replay is of
 * a token you have already picked, so there is nothing here for them to answer.
 * Said plainly on the panel rather than left for somebody to assume, because a
 * test that quietly covers half a strategy is worse than no test.
 */
interface Tested {
  ran: boolean;
  reason?: string;
  medianGapSeconds?: number;
  result?: {
    entered: boolean;
    reason: string;
    returnBps: number | null;
    onChartBps: number | null;
    worstBps: number | null;
    heldSeconds: number;
  };
}

interface KeyRow {
  id: number;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** SOL in the boxes, lamports on the wire. Nobody thinks in lamports. */
function toLamports(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return '';
  return BigInt(Math.round(parsed * 1e9)).toString();
}

function toSol(lamports: string | undefined): string {
  if (!lamports) return '';
  const parsed = Number(lamports);
  return Number.isFinite(parsed) ? String(parsed / 1e9) : '';
}

/** Percentages in the boxes, basis points on the wire. */
function toBps(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed !== 0 ? String(Math.round(parsed * 100)) : '';
}

function toPercent(bps: number | string | undefined): string {
  if (bps === undefined || bps === '') return '';
  const parsed = Number(bps);
  return Number.isFinite(parsed) ? String(parsed / 100) : '';
}

function when(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* Ticked or not, rather than a value. Kept apart from the text fields because
   an unticked box is a condition nobody set, not a condition set to false. */
const BLANK_TICKS = { twitter: false, website: false };

const BLANK = {
  minAge: '',
  maxAge: '90',
  minLiquidity: '20',
  minCap: '',
  maxCap: '',
  minChange: '',
  maxChange: '',
  window: '300',
  venue: 'any',
  maxLaunches: '',
  maxDevHold: '',
  maxBundle: '',
  minHolders: '',
  maxReuse: '',
  stake: '0.25',
  minStake: '',
  maxOpen: '3',
  takeProfit: '120',
  stopLoss: '40',
  timeout: '600',
};

export function StrategyBuilder() {
  const [form, setForm] = useState({ ...BLANK });
  const [ticks, setTicks] = useState({ ...BLANK_TICKS });
  const [name, setName] = useState('my strategy');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [minted, setMinted] = useState<{ key: string; note: string } | null>(null);
  const [keyName, setKeyName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saying, setSaying] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testMint, setTestMint] = useState('');
  const [tested, setTested] = useState<Tested | null>(null);
  const [testing, setTesting] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  const set = (field: keyof typeof BLANK, value: string): void =>
    setForm((current) => ({ ...current, [field]: value }));

  const read = useCallback(async (): Promise<void> => {
    const response = await fetch('/api/strategy', { cache: 'no-store' });
    /*
     * A 401 is the answer, not a failure to get one. Left as "still loading" it
     * showed a signed-out visitor a complete form whose only feedback was a
     * refusal after they had filled it in.
     */
    if (response.status === 401) {
      setSignedIn(false);
      return;
    }
    setSignedIn(true);
    if (!response.ok) return;
    const body = (await response.json()) as Loaded;
    setLoaded(body);
    if (body.strategy) {
      setName(body.strategy.name);
      const rules = body.strategy.rules;
      setForm({
        minAge: String(rules.entry.minAgeSeconds ?? ''),
        maxAge: String(rules.entry.maxAgeSeconds ?? ''),
        minLiquidity: toSol(rules.entry.minLiquidityLamports),
        minCap: toSol(rules.entry.minMarketCapLamports),
        maxCap: toSol(rules.entry.maxMarketCapLamports),
        minChange: toPercent(rules.entry.minChangeBps),
        maxChange: toPercent(rules.entry.maxChangeBps),
        window: String(rules.entry.changeWindowSeconds ?? '300'),
        venue: String(rules.entry.venue ?? 'any'),
        maxLaunches: String(rules.entry.maxCreatorLaunches ?? ''),
        maxDevHold: toPercent(rules.entry.maxCreatorHoldingBps),
        maxBundle: toPercent(rules.entry.maxBundleBps),
        minHolders: String(rules.entry.minHolders ?? ''),
        maxReuse: String(rules.entry.maxSocialReuse ?? ''),
        stake: toSol(rules.size.stakeLamports),
        minStake: rules.size.minStakeLamports ? toSol(rules.size.minStakeLamports) : '',
        maxOpen: String(rules.size.maxOpenPositions),
        takeProfit: toPercent(rules.exit.takeProfitBps),
        stopLoss: toPercent(rules.exit.stopLossBps),
        timeout: String(rules.exit.timeoutSeconds ?? ''),
      });
      setTicks({
        twitter: rules.entry.requireTwitter === true,
        website: rules.entry.requireWebsite === true,
      });
    }
  }, []);

  const readKeys = useCallback(async (): Promise<void> => {
    const response = await fetch('/api/strategy-keys', { cache: 'no-store' });
    if (!response.ok) return;
    setKeys(((await response.json()) as { keys: KeyRow[] }).keys);
  }, []);

  useEffect(() => {
    void read();
    void readKeys();
    // A running strategy is doing things while this page is open, and a log that
    // only updates on reload is a screenshot.
    const timer = setInterval(() => void read(), 10_000);
    return () => clearInterval(timer);
  }, [read, readKeys]);

  function rules(): Rules {
    const entry: Rules['entry'] = {};
    if (form.minAge) entry.minAgeSeconds = Number(form.minAge);
    if (form.maxAge) entry.maxAgeSeconds = Number(form.maxAge);
    if (form.minLiquidity) entry.minLiquidityLamports = toLamports(form.minLiquidity);
    if (form.minCap) entry.minMarketCapLamports = toLamports(form.minCap);
    if (form.maxCap) entry.maxMarketCapLamports = toLamports(form.maxCap);
    if (form.minChange) entry.minChangeBps = Number(toBps(form.minChange));
    if (form.maxChange) entry.maxChangeBps = Number(toBps(form.maxChange));
    if (form.minChange || form.maxChange) entry.changeWindowSeconds = Number(form.window);
    if (form.venue !== 'any') entry.venue = form.venue;
    // Only when ticked. False would read as "only tokens with no X account".
    if (ticks.twitter) entry.requireTwitter = true;
    if (ticks.website) entry.requireWebsite = true;
    if (form.maxLaunches) entry.maxCreatorLaunches = Number(form.maxLaunches);
    if (form.maxDevHold) entry.maxCreatorHoldingBps = Number(toBps(form.maxDevHold));
    if (form.maxBundle) entry.maxBundleBps = Number(toBps(form.maxBundle));
    if (form.minHolders) entry.minHolders = Number(form.minHolders);
    if (form.maxReuse) entry.maxSocialReuse = Number(form.maxReuse);

    const exit: Rules['exit'] = {};
    if (form.takeProfit) exit.takeProfitBps = Number(toBps(form.takeProfit));
    if (form.stopLoss) exit.stopLossBps = Number(toBps(form.stopLoss));
    if (form.timeout) exit.timeoutSeconds = Number(form.timeout);

    return {
      entry,
      size: {
        stakeLamports: toLamports(form.stake),
        ...(form.minStake.trim() === '' ? {} : { minStakeLamports: toLamports(form.minStake) }),
        maxOpenPositions: Number(form.maxOpen),
      },
      exit,
    };
  }

  async function save(): Promise<boolean> {
    setError(null);
    setSaying(null);
    const response = await fetch('/api/strategy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, rules: rules() }),
    });
    if (!response.ok) {
      setError(((await response.json()) as { error?: string }).error ?? 'could not save that');
      return false;
    }
    await read();
    return true;
  }

  async function act(action: 'start' | 'stop'): Promise<void> {
    setBusy(true);
    try {
      if (action === 'start' && !(await save())) return;
      const response = await fetch('/api/strategy', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        setError(((await response.json()) as { error?: string }).error ?? 'could not do that');
        return;
      }
      await read();
    } finally {
      setBusy(false);
    }
  }

  async function backtest(): Promise<void> {
    setError(null);
    setTested(null);
    setTesting(true);
    try {
      const exit = rules().exit;
      const response = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mint: testMint.trim(),
          stake: toLamports(form.stake),
          ...(exit.takeProfitBps === undefined ? {} : { takeProfitBps: exit.takeProfitBps }),
          ...(exit.stopLossBps === undefined ? {} : { stopLossBps: exit.stopLossBps }),
          ...(exit.timeoutSeconds === undefined ? {} : { timeoutSeconds: exit.timeoutSeconds }),
        }),
      });
      const body = (await response.json()) as Tested & { error?: string };
      if (!response.ok) {
        setError(body.error ?? 'could not run that');
        return;
      }
      setTested(body);
    } finally {
      setTesting(false);
    }
  }

  async function mint(): Promise<void> {
    setError(null);
    const response = await fetch('/api/strategy-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: keyName || 'my program' }),
    });
    const body = (await response.json()) as { key?: string; note?: string; error?: string };
    if (!response.ok || !body.key) {
      setError(body.error ?? 'could not mint a key');
      return;
    }
    setMinted({ key: body.key, note: body.note ?? '' });
    setKeyName('');
    await readKeys();
  }

  async function revoke(id: number): Promise<void> {
    await fetch(`/api/strategy-keys?id=${id}`, { method: 'DELETE' });
    await readKeys();
  }

  const running = loaded?.strategy?.status === 'running';
  const out = signedIn === false;
  // Told up front rather than discovered by pressing run and being refused.
  const needsEntry = loaded?.season !== null && loaded?.entered === false;
  const live = keys.filter((key) => key.revokedAt === null);

  return (
    <>
      <section className="panel strategy-panel">
        <div className="panel-head">
          <h2>The rules</h2>
          <span className={running ? 'pill live' : 'pill closed'}>
            {running ? 'running' : (loaded?.strategy?.status ?? 'not saved')}
          </span>
        </div>

        <p className="dim panel-note">
          It trades the account you already entered with, on the same clock and the same fills as
          a click. Leave a box empty and that condition is not checked.
        </p>

        {out && (
          <p className="strategy-error">
            Connect your wallet to write a strategy. It trades your account, so it needs to know
            whose account that is.
          </p>
        )}

        {needsEntry && (
          <p className="strategy-error">
            You are not entered in this season yet. A strategy trades the account you entered with,
            so it needs an entry the same as trading by hand does.{' '}
            <a className="linklike" href="/season">
              enter the season
            </a>
          </p>
        )}

        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
        </label>

        <h3 className="strategy-section">Enter when</h3>
        <div className="strategy-grid">
          <label className="field">
            <span>Age at least (seconds)</span>
            <input inputMode="numeric" value={form.minAge} onChange={(e) => set('minAge', e.target.value)} placeholder="any" />
          </label>
          <label className="field">
            <span>Age at most (seconds)</span>
            <input inputMode="numeric" value={form.maxAge} onChange={(e) => set('maxAge', e.target.value)} placeholder="any" />
          </label>
          <label className="field">
            <span>Liquidity at least (SOL)</span>
            <input inputMode="decimal" value={form.minLiquidity} onChange={(e) => set('minLiquidity', e.target.value)} placeholder="any" />
          </label>
          <label className="field">
            <span>Venue</span>
            <select value={form.venue} onChange={(e) => set('venue', e.target.value)}>
              <option value="any">any</option>
              <option value="curve">still on the curve</option>
              <option value="graduated">graduated</option>
            </select>
          </label>
          <label className="field">
            <span>Market cap at least (SOL)</span>
            <input inputMode="decimal" value={form.minCap} onChange={(e) => set('minCap', e.target.value)} placeholder="any" />
          </label>
          <label className="field">
            <span>Market cap at most (SOL)</span>
            <input inputMode="decimal" value={form.maxCap} onChange={(e) => set('maxCap', e.target.value)} placeholder="any" />
          </label>
          <label className="field">
            <span>Moved at least (%)</span>
            <input inputMode="decimal" value={form.minChange} onChange={(e) => set('minChange', e.target.value)} placeholder="any" />
          </label>
          <label className="field">
            <span>Over the last (seconds)</span>
            <input inputMode="numeric" value={form.window} onChange={(e) => set('window', e.target.value)} />
          </label>
        </div>

        <h3 className="strategy-section">Who launched it</h3>
        <div className="strategy-grid">
          <label className="field tickbox">
            <input
              type="checkbox"
              checked={ticks.twitter}
              onChange={(event) => setTicks((now) => ({ ...now, twitter: event.target.checked }))}
            />
            <span>Names an X account</span>
          </label>
          <label className="field tickbox">
            <input
              type="checkbox"
              checked={ticks.website}
              onChange={(event) => setTicks((now) => ({ ...now, website: event.target.checked }))}
            />
            <span>Names a website</span>
          </label>
          <label className="field">
            <span>Creator has launched, at most</span>
            <input
              inputMode="numeric"
              value={form.maxLaunches}
              onChange={(e) => set('maxLaunches', e.target.value)}
              placeholder="any"
            />
          </label>
          <label className="field">
            <span>Creator still holds, at most (%)</span>
            <input
              inputMode="decimal"
              value={form.maxDevHold}
              onChange={(e) => set('maxDevHold', e.target.value)}
              placeholder="any"
            />
          </label>
          <label className="field">
            <span>Bundled in the launch slot, at most (%)</span>
            <input
              inputMode="decimal"
              value={form.maxBundle}
              onChange={(e) => set('maxBundle', e.target.value)}
              placeholder="any"
            />
          </label>
          <label className="field">
            <span>Holders, at least</span>
            <input
              inputMode="numeric"
              value={form.minHolders}
              onChange={(e) => set('minHolders', e.target.value)}
              placeholder="any"
            />
          </label>
          <label className="field">
            <span>Its X account is on, at most</span>
            <input
              inputMode="numeric"
              value={form.maxReuse}
              onChange={(e) => set('maxReuse', e.target.value)}
              placeholder="any"
            />
          </label>
        </div>
        <p className="dim panel-note">
          Launches are counted across what this site has indexed, so it is a floor on how many they
          have made rather than their whole history. A token whose metadata has not been read yet
          matches neither of the boxes above, rather than being let through on a guess.
          The last three are read from the chain, so they are only checked for tokens that have
          already passed everything else, and a read that fails counts as unmet rather than as
          clean. The bundle figure is what was bought in the same slot the token was created in,
          which is what a creator gets when they land the launch and their own buys together; it
          never changes, so it is read once per token and remembered. Holders counts wallets with
          a balance rather than token accounts, since a wallet that sold out usually leaves its
          account behind. The last box counts how many tokens here name the same X account,
          including this one: it cannot see what an account posted and deleted, but it can see the
          same account attached to a dozen other launches.
        </p>

        <h3 className="strategy-section">Size</h3>
        <div className="strategy-grid">
          <label className="field">
            <span>Per position, at most (SOL)</span>
            <input inputMode="decimal" value={form.stake} onChange={(e) => set('stake', e.target.value)} />
          </label>
          <label className="field">
            <span>Per position, at least (SOL)</span>
            <input
              inputMode="decimal"
              value={form.minStake}
              onChange={(e) => set('minStake', e.target.value)}
              placeholder="same every time"
            />
          </label>
          <label className="field">
            <span>Open at once, at most</span>
            <input inputMode="numeric" value={form.maxOpen} onChange={(e) => set('maxOpen', e.target.value)} />
          </label>
        </div>
        <p className="dim panel-note">
          Leave the second box empty and every entry is the same size, which is how this worked
          before. Fill it in and the position lands between the two according to how comfortably
          the token cleared your conditions: everything passed by a mile gets the top of the
          range, something that scraped past the last condition gets the bottom. Only the numeric
          conditions count toward that, because there is no such thing as clearing &ldquo;names an
          X account&rdquo; by a mile.
        </p>
        <p className="dim panel-note">
          A bigger position is also capped at two percent of what the pool actually holds, and
          that cap can only ever pull it down toward your floor. Exits here are priced out of real
          reserves and a take profit fires exactly when a position is largest against its pool,
          which is the moment leaving costs the most, so betting more on conviction without that
          cap would turn your best entries into your worst exits. A pool whose depth is not known
          here is sized at the floor rather than guessed at.
        </p>

        <h3 className="strategy-section">Leave when</h3>
        <div className="strategy-grid">
          <label className="field">
            <span>Take profit (%)</span>
            <input inputMode="decimal" value={form.takeProfit} onChange={(e) => set('takeProfit', e.target.value)} placeholder="never" />
          </label>
          <label className="field">
            <span>Stop loss (%)</span>
            <input inputMode="decimal" value={form.stopLoss} onChange={(e) => set('stopLoss', e.target.value)} placeholder="never" />
          </label>
          <label className="field">
            <span>Give up after (seconds)</span>
            <input inputMode="numeric" value={form.timeout} onChange={(e) => set('timeout', e.target.value)} placeholder="never" />
          </label>
        </div>

        <p className="dim panel-note">
          These fire on what a real sell would actually fetch, not on the chart. A take profit
          triggers when a position is big against its pool, which is exactly when leaving costs the
          most, so a rule checked against the line fires at a price nobody could have got.
        </p>

        {error && <p className="strategy-error" role="alert">{error}</p>}
        {saying && <p className="dim">{saying}</p>}

        <div className="strategy-actions">
          {running ? (
            <button type="button" onClick={() => void act('stop')} disabled={busy}>
              Stop it
            </button>
          ) : (
            <button type="button" onClick={() => void act('start')} disabled={busy || needsEntry || out}>
              Run it for the season
            </button>
          )}
          <button
            type="button"
            className="linklike"
            disabled={busy || running || out}
            onClick={() => void save().then((ok) => ok && setSaying('saved'))}
          >
            just save it
          </button>
        </div>

        {running && (
          <p className="dim panel-note">
            Stopping ends the entering. Anything it is holding stays open and stays yours to close.
          </p>
        )}
      </section>

      <section className="panel strategy-panel">
        <div className="panel-head">
          <h2>Try the exits on real history</h2>
        </div>
        <p className="dim panel-note">
          Replays your take profit, stop loss and timeout over one token’s actual recorded swaps,
          priced at what a real sell would have fetched out of the reserves at each moment rather
          than at the chart. It answers what your exits would have done, not which tokens the entry
          conditions would have found: a replay is of a token you have already picked. It is run at
          the largest position you allow, since a replay has no conditions to score and so no
          conviction to size by.
        </p>

        <div className="strategy-actions">
          <label className="field">
            <span>Token address</span>
            <input
              value={testMint}
              onChange={(event) => setTestMint(event.target.value)}
              placeholder="paste a mint"
              spellCheck={false}
            />
          </label>
          <button type="button" onClick={() => void backtest()} disabled={testing || !testMint.trim()}>
            {testing ? 'Replaying' : 'Backtest'}
          </button>
        </div>

        {tested && !tested.ran && (
          <p className="dim">
            No usable history for that token yet, so there is nothing to replay over.
          </p>
        )}

        {tested?.ran && tested.result && (
          <ul className="strategy-limits">
            <li>
              <strong>{tested.result.entered ? 'It entered.' : 'It never entered.'}</strong>{' '}
              {tested.result.entered
                ? `Ended on ${tested.result.reason.replace('_', ' ')} after ${Math.round(tested.result.heldSeconds / 60)} minutes.`
                : 'No moment in the window could take the position under the impact cap.'}
            </li>
            {tested.result.returnBps !== null && (
              <li>
                <strong>{(tested.result.returnBps / 100).toFixed(1)}% at a real exit.</strong>{' '}
                {tested.result.onChartBps !== null && (
                  <>
                    The chart says {(tested.result.onChartBps / 100).toFixed(1)}%. The gap is the
                    fee and your own order moving the pool, and it is the number every other paper
                    trader hides from you.
                  </>
                )}
              </li>
            )}
            {tested.result.worstBps !== null && (
              <li>
                <strong>Worst it got: {(tested.result.worstBps / 100).toFixed(1)}%.</strong> Whether
                a rule is survivable matters as much as whether it pays.
              </li>
            )}
            {tested.medianGapSeconds !== undefined && (
              <li className="dim">
                Checked at recorded swaps roughly {tested.medianGapSeconds}s apart, so a level is
                acted on at the next swap after it was crossed rather than exactly at it.
              </li>
            )}
          </ul>
        )}
      </section>

      {loaded?.limits && (
        <section className="panel strategy-panel">
          <div className="panel-head">
            <h2>Today</h2>
            <span className="dim">
              {loaded.limits.automatedOrdersToday} of {loaded.limits.dailyCap} orders
            </span>
          </div>
          <p className="dim panel-note">
            Every fill reads the chain twice, so there is a ceiling on how often a program or a
            strategy can trade. Reaching it stops the entering until the day rolls forward. It is
            far above anything a working strategy does and far below what a loop with no wait in it
            produces.
          </p>
        </section>
      )}

      {loaded && loaded.events.length > 0 && (
        <section className="panel strategy-panel">
          <div className="panel-head">
            <h2>What it did</h2>
            <span className="dim">{loaded.openPositions} open</span>
          </div>
          <ul className="strategy-log">
            {loaded.events.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <span className="strategy-log-at">{when(event.at)}</span>
                <span className={`strategy-log-kind k-${event.kind}`}>{event.kind}</span>
                <span className="strategy-log-detail">
                  {event.mint && (
                    <a href={`/t/${event.mint}`} className="linklike">
                      {event.mint.slice(0, 4)}…{event.mint.slice(-4)}
                    </a>
                  )}{' '}
                  {event.detail}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel strategy-panel">
        <div className="panel-head">
          <h2>Keys</h2>
          <a className="linklike" href="/api-docs">
            how to use one
          </a>
        </div>
        <p className="dim panel-note">
          For running your own program instead. A key places orders on this same account, through
          the same engine. Your program has to be running for it to trade, which is the one thing
          the form above does not ask of you.
        </p>

        {minted && (
          <div className="strategy-minted">
            <code>{minted.key}</code>
            <p className="dim">{minted.note}</p>
          </div>
        )}

        <div className="strategy-actions">
          <label className="field">
            <span>What is it for</span>
            <input
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              placeholder="my program"
              maxLength={40}
            />
          </label>
          <button type="button" onClick={() => void mint()} disabled={out}>
            Mint a key
          </button>
        </div>

        {live.length > 0 && (
          <ul className="strategy-keys">
            {live.map((key) => (
              <li key={key.id}>
                <code>{key.prefix}…</code>
                <span>{key.name}</span>
                <span className="dim">
                  {key.lastUsedAt ? `last used ${when(key.lastUsedAt)}` : 'never used'}
                </span>
                <button type="button" className="linklike" onClick={() => void revoke(key.id)}>
                  revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
