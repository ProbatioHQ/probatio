/**
 * Where this goes after launch.
 *
 * Held here rather than inside the page because two surfaces render it now: the
 * roadmap itself and the broadcast board. Two copies of a plan is two plans, and
 * the one on the stream would be the one nobody remembers to update.
 *
 * Each phase is marked with how real it is, because a roadmap that dresses a
 * wish up as a commitment is the dishonesty the rest of the site exists to
 * avoid.
 */

export interface Item {
  readonly title: string;
  readonly detail: string;
}

export interface Phase {
  readonly tag: string;
  readonly status: 'now' | 'next' | 'later' | 'exploring';
  readonly name: string;
  readonly summary: string;
  readonly items: readonly Item[];
}

export const STATUS_LABEL: Record<Phase['status'], string> = {
  now: 'at launch',
  next: 'next',
  later: 'later',
  exploring: 'exploring',
};

export const PHASES: readonly Phase[] = [
  {
    tag: '01',
    status: 'next',
    name: 'A competitive arena',
    summary: 'Solo practice is the start. This turns a private simulator into somewhere you compete and get watched.',
    items: [
      {
        title: 'Head to head duels',
        detail:
          'One against one, the same tokens over the same window, both records sealed. Put a stake on it and the winner takes the pot.',
      },
      {
        title: 'Automated strategies that get ranked',
        detail:
          'Write an algorithm, connect it to the simulator, and let it trade a season under the same fills and the same clock as everyone else. A bot that can prove itself is a trader too.',
      },
      {
        title: 'Backtesting on real history',
        detail:
          'Replay a token through the exact reserves it actually traded against and see how a strategy would have done, before you risk a season on it.',
      },
      {
        title: 'Live spectating and a following',
        detail:
          'Watch a top trader fill in real time, and let a record people trust gather an audience the way a real one does.',
      },
    ],
  },
  {
    tag: '02',
    status: 'next',
    name: 'Teams and tournaments',
    summary: 'One trader against one is the start. This is the whole scene: squads, brackets, and prizes worth showing up for.',
    items: [
      {
        title: 'Guilds and team seasons',
        detail:
          'Trade as a squad, pool your records, and rank against other guilds. A season your friends are in is a season you come back to.',
      },
      {
        title: 'Bracketed tournaments',
        detail:
          'Knockout rounds with a real prize pool, seeded by record, run to a final anyone can watch.',
      },
      {
        title: 'Creator and streamer tools',
        detail:
          'Overlays, embeds and a shareable live record, so a trader can build an audience here the way they do everywhere else.',
      },
      {
        title: 'Rivalries that carry',
        detail:
          'A head to head history between two traders that follows them season to season, not just one duel and forget.',
      },
    ],
  },
  {
    tag: '03',
    status: 'later',
    name: 'An edge worth having',
    summary: 'The market leaves a trail. This turns that trail into things that make you a better trader.',
    items: [
      {
        title: 'On-chain intelligence',
        detail:
          'Whale wallets, smart money and fresh liquidity surfaced as they move, so you see what is happening while it still matters.',
      },
      {
        title: 'Alerts that reach you',
        detail:
          'Set the conditions that matter to you and get told the moment they happen, wherever you are.',
      },
      {
        title: 'An AI sparring partner',
        detail:
          'A model that trades the same tokens beside you and tells you afterwards where it went a different way, and why.',
      },
      {
        title: 'Your own numbers, deeper',
        detail:
          'Drawdown, timing, which setups actually pay for you. The coach, but with your whole history behind it.',
      },
    ],
  },
  {
    tag: '04',
    status: 'later',
    name: 'Beyond memecoins',
    summary: 'A record in one market is narrow. These make it broad, and each one is measured the same honest way.',
    items: [
      {
        title: 'Prediction markets',
        detail:
          'Trade outcomes rather than tokens. A different skill, priced from real markets, added to the same verifiable record.',
      },
      {
        title: 'Tokenized stocks and indices',
        detail:
          'Equities as they arrive, so a track record here reflects more than one corner of one market.',
      },
      {
        title: 'Perpetuals and leverage, simulated honestly',
        detail:
          'Leverage is where most traders actually blow up. Practising it against real funding rates and real liquidation, with nothing at stake but your record, is exactly what this is for.',
      },
      {
        title: 'The same engine on other chains',
        detail:
          'Hyperliquid, Base, Ethereum. One honest fill engine, pointed wherever the liquidity is.',
      },
    ],
  },
  {
    tag: '05',
    status: 'exploring',
    name: 'Get paid to be good',
    summary: 'The reason to prove anything is that being good should be worth something. This is where the record cashes in.',
    items: [
      {
        title: 'Real capital for proven traders',
        detail:
          'A record of ranked seasons finishing near the top becomes the thing real money is allocated against, on a profit share. Trade paper money, prove you are good, get real money. The whole idea, made real.',
      },
      {
        title: 'Strategy vaults',
        detail:
          'A strategy with a record that holds up becomes something other people can back. The capital flows in and the creator earns a cut.',
      },
      {
        title: 'Back a trader',
        detail:
          'When a record cannot be faked, staking on one means something. Put money behind a verified trader and share their upside.',
      },
      {
        title: 'A credential you can take anywhere',
        detail:
          'A record checkable by anyone, off this site as easily as on it. A resume for trading that no employer or allocator has to take on faith.',
      },
    ],
  },
];

