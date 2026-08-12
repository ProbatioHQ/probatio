export const metadata = {
  title: 'Roadmap, Probatio',
  description:
    'Where Probatio goes after launch: more to trade, and a track record that eventually earns real capital.',
};

/**
 * Where this goes after launch.
 *
 * Deliberately not a launch checklist. Launch is the start line, not the
 * finish, and this is the argument for why the thing is worth following past
 * it: the record you build here is meant to become worth something, and the
 * ground it can be built on keeps widening. Each phase is marked with how real
 * it is, because a roadmap that dresses a wish up as a commitment is the same
 * dishonesty the rest of the site exists to avoid.
 */

interface Item {
  readonly title: string;
  readonly detail: string;
}

interface Phase {
  readonly tag: string;
  readonly status: 'now' | 'next' | 'later' | 'exploring';
  readonly name: string;
  readonly summary: string;
  readonly items: readonly Item[];
}

const STATUS_LABEL: Record<Phase['status'], string> = {
  now: 'at launch',
  next: 'next',
  later: 'later',
  exploring: 'exploring',
};

const PHASES: readonly Phase[] = [
  {
    tag: '01',
    status: 'now',
    name: 'Prove it works',
    summary:
      'The core the whole thing rests on: an honest simulator, a record nobody can fake, and a season to win.',
    items: [
      {
        title: 'Honest fills on live tokens',
        detail:
          'Every fill quoted against the real pool at the moment you click, with real slippage and real delay. Measured against actual trades rather than asserted.',
      },
      {
        title: 'Records committed to Solana',
        detail:
          'Each trade hashed as it fills and written to the chain in batches, so your history can be checked by anyone without asking us.',
      },
      {
        title: 'Ranked seasons',
        detail:
          'Everyone starts on the same balance under the same rules, ranked by percentage return. The rules are published and hashed before the season runs.',
      },
      {
        title: 'A coach that reads your trades',
        detail:
          'Feedback drawn from your own round trips — what you keep doing, and what it costs you.',
      },
    ],
  },
  {
    tag: '02',
    status: 'next',
    name: 'More to trade',
    summary:
      'The skill you are proving should not be limited to one corner of one chain. This widens the ground.',
    items: [
      {
        title: 'Every Solana venue',
        detail:
          'Beyond pump.fun and PumpSwap to Raydium and the rest, so any Solana token is fair game, priced the same honest way.',
      },
      {
        title: 'Deeper charting and tooling',
        detail:
          'The indicators and drawing tools a serious trader expects, on the native chart, for the tokens no external chart has indexed yet.',
      },
      {
        title: 'Portfolio and history that reads like a terminal',
        detail:
          'Your positions, your realized and unrealized, your whole season at a glance — fast, clean, and built for people who stare at it all day.',
      },
    ],
  },
  {
    tag: '03',
    status: 'later',
    name: 'Beyond memecoins',
    summary:
      'A track record in one asset class is a narrow thing. These make it a broad one.',
    items: [
      {
        title: 'Prediction markets',
        detail:
          'Trade on outcomes, not just tokens — a different skill, measured the same honest way and added to the same record.',
      },
      {
        title: 'Tokenized equities',
        detail:
          'Stocks and indices as they arrive on chain, so the record you build here reflects more than one kind of market.',
      },
      {
        title: 'Perps and leverage, simulated honestly',
        detail:
          'Leverage is where most traders actually blow up. Practising it against real funding and real liquidation, with no real money at risk, is exactly what this is for.',
      },
    ],
  },
  {
    tag: '04',
    status: 'exploring',
    name: 'Get paid to be good',
    summary:
      'The point of proving you can trade is that being good should be worth something. This is where the record cashes in.',
    items: [
      {
        title: 'Real capital for proven traders',
        detail:
          'A track record of ranked seasons finishing near the top becomes the thing capital is allocated against. Trade fake money, prove you are good, get real money — the whole idea, made real.',
      },
      {
        title: 'Follow the people who can trade',
        detail:
          'When a record is unfakeable, following it means something. Surface the traders whose history holds up, and let people learn from or mirror them.',
      },
      {
        title: 'A credential you can take with you',
        detail:
          'A record checkable by anyone, anywhere, is a résumé for trading — usable off this site, not locked inside it.',
      },
    ],
  },
];

export default function RoadmapPage() {
  return (
    <main className="roadmap">
      <div className="page-head">
        <h1>Roadmap</h1>
        <p className="dim">
          Launch is the start line. This is where it goes after — what gets added, what gets
          better, and where a proven record eventually leads. Each phase is marked with how real
          it is: shipping at launch, coming next, or still an idea we are chasing.
        </p>
      </div>

      <ol className="phases">
        {PHASES.map((phase) => (
          <li key={phase.tag} className="phase">
            <div className="phase-rail" aria-hidden="true">
              <span className="phase-tag">{phase.tag}</span>
            </div>
            <div className="phase-body">
              <div className="phase-head">
                <h2>{phase.name}</h2>
                <span className={`phase-status s-${phase.status}`}>{STATUS_LABEL[phase.status]}</span>
              </div>
              <p className="dim phase-summary">{phase.summary}</p>
              <ul className="phase-items">
                {phase.items.map((item) => (
                  <li key={item.title}>
                    <span className="phase-item-title">{item.title}</span>
                    <span className="phase-item-detail dim">{item.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>

      <p className="dim roadmap-foot">
        Written to be honest about what is real. A phase marked <em>exploring</em> is a direction,
        not a promise — see <a href="/trust">what you have to trust</a> for the rest of that
        argument.
      </p>
    </main>
  );
}
