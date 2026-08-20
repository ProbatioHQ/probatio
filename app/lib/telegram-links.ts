/**
 * Where Probatio is on Telegram.
 *
 * One place, because these end up in a page, a footer, a bot message and
 * whatever comes next, and three copies of a username is three things to
 * remember when one of them changes.
 *
 * A `url` of null is how a place that does not exist yet says so, and the page
 * marks it as coming rather than linking nowhere. All three exist today; the
 * branch stays because the next one will not.
 *
 * Not `server-only`: the page that renders these is a client component, and a
 * username is the least secret thing in the repository.
 */

export interface TelegramPlace {
  readonly name: string;
  readonly handle: string;
  /** Null until it exists. The page says "soon" rather than linking nowhere. */
  readonly url: string | null;
  readonly what: string;
}

export const TELEGRAM_BOT: TelegramPlace = {
  name: 'The bot',
  handle: '@ProbatioTradingBot',
  url: 'https://t.me/ProbatioTradingBot',
  what:
    'Trade from a chat, check anybody’s record, and follow a trader’s fills as they land. ' +
    'The same engine as the site, so a fill placed here is the same fill.',
};

/*
 * Checked rather than assumed, after one of these was a guess and the guess was
 * wrong.
 *
 * t.me answers for any username at all, so a dead handle looks like a working
 * link right up until somebody taps it. The two are distinguishable only by
 * what the page returns: a real channel gives its own name and its description,
 * an unclaimed one gives "Telegram: Contact @whatever" and nothing else.
 */
export const TELEGRAM_CHANNEL: TelegramPlace = {
  name: 'Announcements',
  handle: '@probatiopublic',
  url: 'https://t.me/probatiopublic',
  what: 'Development updates, releases, roadmap progress and season results. Read only.',
};

/*
 * Named for what it is, not for what its username says.
 *
 * The handle reads like the announcements channel and the room is the community
 * one. The label is the thing somebody is choosing between, so it wins; the
 * handle is shown underneath anyway, which is what they will see when they
 * arrive and is worth not being a surprise.
 */
export const TELEGRAM_COMMUNITY: TelegramPlace = {
  name: 'Community',
  handle: '@probatio_Trade',
  url: 'https://t.me/probatio_Trade',
  what: 'Where traders talk. Ask anything, post a record, argue about a fill.',
};

export const TELEGRAM_PLACES: readonly TelegramPlace[] = [
  TELEGRAM_BOT,
  TELEGRAM_CHANNEL,
  TELEGRAM_COMMUNITY,
];
