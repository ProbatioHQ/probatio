import 'server-only';
import {
  CODE_TTL_MS,
  MAX_WATCHES_PER_CHAT,
  issueLinkCode,
  linkedWallet,
  unlinkTelegram,
  unwatchTrader,
  watchTrader,
  watchesFor,
} from '@probatio/db';
import { PUMPFUN_TOKEN_DECIMALS } from '@probatio/pools';
import { db } from '../db';
import { resolveTokenName } from '../token-name';
import { verifyCard, verdictLine } from './cards';
import type { Context, Command, Handlers } from './router';
import type { Telegram } from './transport';
import type { CallbackQuery, InlineQuery } from './types';
import { findWallet, looksLikeWallet, verifyWallet } from './verify';
import { b, code, html, lines, rows } from './format';
import {
  MINT_PATTERN,
  parsePercent,
  parseSol,
  portfolioFor,
  tradeFromChat,
} from './trade';
import {
  balanceCard,
  buyKeyboard,
  buyPrompt,
  matchesCard,
  matchesKeyboard,
  outcomeCard,
  parseAction,
  seasonCard,
  positionsCard,
  positionsKeyboard,
  sellKeyboard,
  sellPrompt,
  shortMint,
  type Found,
  type TokenLabel,
} from './trade-cards';
import { searchExternalTokens } from '../token-search';
import { seasonNow } from './season';

/**
 * What the bot can currently be asked.
 *
 * Two commands, because the rest of them need things that do not exist yet: an
 * account link, a verifier, a trading card. They arrive here one at a time, and
 * each one is a function of a context and a command, which is the whole reason
 * the router hands over those two things and nothing else.
 */

/*
 * The site this bot belongs to.
 *
 * Read from the environment rather than written down, because a bot pointed at
 * a staging deployment trades against that deployment's database. Hard-coded,
 * /link sent people to production to redeem a code issued here, and every fill
 * card linked to a record that does not contain the fill it was reporting.
 */
const SITE = process.env['PROBATIO_SITE'] ?? 'https://probatiotrade.com';

async function start(context: Context): Promise<void> {
  await context.telegram.sendMessage({
    chat_id: context.chatId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: lines(
      `${b('Probatio trades pump.fun with paper money and real prices.')}`,
      'The price moves while your order is in flight, your size costs you, and sometimes the trade simply fails, because that is what happens with real money.',
      'Every fill is sealed into a record anyone can recompute.',
      `Nothing to fund. ${SITE}`,
      'Try /help.',
    ),
  });
}

/*
 * The menu, as a list rather than as a table.
 *
 * It was laid out in columns padded with spaces, which lines nothing up in a
 * proportional font and only moves the ragged edge somewhere else. Each command
 * is bold and its description follows it on the same line, so the eye has
 * something to run down without needing the characters to be the same width.
 */
async function help(context: Context): Promise<void> {
  await context.telegram.sendMessage({
    chat_id: context.chatId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: lines(
      b('Trading'),
      rows(
        `${b('/buy')} &lt;token&gt; [SOL] by name or mint, or show sizes to pick from`,
        `${b('/sell')} &lt;token&gt; [%] by name or mint, or show sizes to pick from`,
        `${b('/positions')} what you hold`,
        `${b('/balance')} what it is worth`,
      ),
      b('Checking a record'),
      rows(
        `${b('/verify')} &lt;wallet&gt; recompute anybody’s record from its seals`,
        'Reply to somebody with /verify and I will check theirs.',
        'Type my name and a wallet in any chat, even one I have never been added to.',
      ),
      b('Following a trader'),
      rows(
        `${b('/watch')} &lt;wallet&gt; their fills, here, as they land`,
        `${b('/unwatch')} &lt;wallet&gt; stop`,
        `${b('/watching')} who this chat follows`,
      ),
      b('The season'),
      rows(
        `${b('/season')} the pot, the deadline, and where you stand`,
      ),
      b('Your account'),
      rows(
        `${b('/link')} connect your Probatio account`,
        `${b('/unlink')} disconnect it`,
      ),
      'Trades run the same engine as the site: the price moves while your order is in flight, and sometimes it fails.',
    ),
  });
}

function short(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

/**
 * Connect a Telegram account to a wallet.
 *
 * The bot cannot do this on its own. It knows who is typing and has no idea
 * which wallet they own, and taking a pasted address on trust would let anybody
 * claim anybody's record, which on a site whose product is verifiable records is
 * the worst available mistake. So it hands out a code and the site asks for a
 * signature.
 *
 * Direct messages only. A code is a bearer token for the account, and posting
 * one into a group hands it to the room.
 */
async function link(context: Context): Promise<void> {
  if (!context.isPrivate) {
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      reply_to_message_id: context.messageId,
      text: 'Message me directly to link an account. A link code should not be posted in a group.',
    });
    return;
  }
  if (context.userId === null) return;

  const client = await db();
  const already = await linkedWallet(client, context.userId);
  if (already) {
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: lines(html`This Telegram is linked to ${short(already)}.`, 'Use /unlink to disconnect it.'),
    });
    return;
  }

  const { code: issued } = await issueLinkCode(client, context.userId, context.chatId, context.now);
  await context.telegram.sendMessage({
    chat_id: context.chatId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    // Monospace, so it is tap-to-copy rather than something to retype.
    text: lines(
      `Your code: ${code(issued)}`,
      `Open ${SITE}/link, sign in with the wallet you trade on, and enter it. Good for ${b(`${CODE_TTL_MS / 60_000} minutes`)}, once.`,
      'Keep it to yourself. Anyone holding it can attach their Telegram to your account.',
    ),
  });
}

/** Disconnect. Nothing about the record changes, only where orders may come from. */
async function unlink(context: Context): Promise<void> {
  if (context.userId === null) return;
  const client = await db();
  const wallet = await linkedWallet(client, context.userId);

  if (!wallet) {
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      text: 'This Telegram is not linked to anything.',
    });
    return;
  }

  await unlinkTelegram(client, wallet);
  await context.telegram.sendMessage({
    chat_id: context.chatId,
    parse_mode: 'HTML',
    text: lines(
      html`Disconnected from ${short(wallet)}.`,
      'Your record is untouched. Nothing can be traded from here until you link again.',
    ),
  });
}

/**
 * Check anybody's record, from anywhere.
 *
 * The command this bot exists for. Three ways of naming a wallet, because in
 * practice people have three different things in hand at the moment they want
 * to check something.
 *
 * Typed: /verify <wallet>, when they have the address.
 *
 * Replied: /verify with nothing, as a reply to the message they are sceptical
 * about. The wallet comes out of that message if it contains one, and otherwise
 * from the linked account of whoever sent it. This is the one that matters:
 * somebody posts a screenshot, somebody else replies with six characters, and
 * the argument is settled without either of them leaving the chat.
 *
 * Their own: /verify with nothing and no reply, in a direct message, which
 * means "check mine".
 */
async function verify(context: Context, command: Command): Promise<void> {
  const wallet = await walletFor(context, command);

  if (!wallet) {
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      reply_to_message_id: context.messageId,
      parse_mode: 'HTML',
      text: lines(
        'Give me a wallet to check.',
        '/verify &lt;wallet&gt;, or reply to somebody with /verify and I will check theirs.',
      ),
    });
    return;
  }

  const result = await verifyWallet(wallet);
  await context.telegram.sendMessage({
    chat_id: context.chatId,
    parse_mode: 'HTML',
    reply_to_message_id: context.messageId,
    disable_web_page_preview: true,
    text: verifyCard(result),
  });
}

/** Which wallet a /verify is about. See the note on `verify`. */
async function walletFor(context: Context, command: Command): Promise<string | null> {
  const typed = command.args.trim();
  if (typed && looksLikeWallet(typed)) return typed;

  if (context.replyTo) {
    // Something they posted, first: an address in the message is what they are
    // claiming about, and it may not be a wallet they have linked.
    const inMessage = findWallet(context.replyTo.text);
    if (inMessage) return inMessage;

    const theirTelegram = context.replyTo.from?.id;
    if (theirTelegram !== undefined) {
      const linked = await linkedWallet(await db(), theirTelegram);
      if (linked) return linked;
    }
    return null;
  }

  // No argument and no reply, in a direct message, means their own.
  if (context.isPrivate && context.userId !== null) {
    return await linkedWallet(await db(), context.userId);
  }
  return null;
}

/**
 * The same check, in a chat this bot has never been added to.
 *
 * Inline mode is how the thing travels. Somebody in a group that has never
 * heard of Probatio types the bot's name and a wallet, and a verified record
 * appears in the conversation. No install, no permission, nobody has to be
 * convinced to add anything.
 *
 * Never cached. The answer is a claim about a record that can change, and
 * Telegram will happily serve a stale one to somebody else asking the same
 * question if allowed to.
 */
async function inline(telegram: Telegram, query: InlineQuery): Promise<void> {
  const wallet = findWallet(query.query);

  if (!wallet) {
    await telegram.answerInlineQuery({
      inline_query_id: query.id,
      cache_time: 0,
      is_personal: true,
      results: [
        {
          type: 'article',
          id: 'help',
          title: 'Paste a wallet address',
          description: 'I will recompute their record from the seals and post the result.',
          input_message_content: {
            message_text: `Probatio verifies a trading record from its seals. ${SITE}`,
          },
        },
      ],
    });
    return;
  }

  const result = await verifyWallet(wallet);
  await telegram.answerInlineQuery({
    inline_query_id: query.id,
    cache_time: 0,
    is_personal: true,
    results: [
      {
        type: 'article',
        id: `verify:${wallet}`,
        title: verdictLine(result),
        description: `${wallet.slice(0, 10)}… recomputed, not looked up`,
        input_message_content: { message_text: verifyCard(result), parse_mode: 'HTML' },
      },
    ],
  });
}

export const HANDLERS: Handlers = {
  commands: {
    start,
    help,
    link,
    unlink,
    verify,
    buy,
    sell,
    positions,
    balance,
    season,
    watch,
    unwatch,
    watching,
  },
  callbacks: { b: onSize, s: onSize, t: onSize },
  inline,
};

export type { Context, Command };

/**
 * Trading from a chat.
 *
 * Every fill here goes through `executeTrade`, the same sequence the website
 * and the free-play accounts run. The bot has no shortcut of its own, which is
 * the whole reason that sequence was lifted out of the trade route before any
 * of this was written.
 *
 * Two shapes for each command, because people arrive with different amounts of
 * certainty. With a size, it fills. Without one, it shows a card with sizes to
 * tap, which is what a phone is good at.
 */

/**
 * Every token traded here is a pump.fun mint, and pump.fun mints have six
 * decimals. Read from the pool where a pool is being read anyway; assumed where
 * reading one would mean an extra round trip to print a number of tokens.
 */
const DECIMALS = PUMPFUN_TOKEN_DECIMALS;

/**
 * The wallet whoever is typing has linked, or a nudge to link one.
 *
 * Returns the Telegram id alongside it because every card built after this
 * point stamps the owner into its buttons, and that id must be the real one:
 * a card whose owner is a placeholder is a card whose buttons refuse everybody.
 */
async function walletOf(
  context: Context,
): Promise<{ wallet: string; telegramId: number } | null> {
  const telegramId = context.userId;
  if (telegramId === null) return null;
  const wallet = await linkedWallet(await db(), telegramId);
  if (wallet) return { wallet, telegramId };

  await context.telegram.sendMessage({
    chat_id: context.chatId,
    reply_to_message_id: context.messageId,
    text: context.isPrivate
      ? 'Connect an account first. /link, and I will hand you a code.'
      : 'You have not connected an account. Send me /link in a direct message.',
  });
  return null;
}

async function labelFor(mint: string): Promise<TokenLabel> {
  const named = await resolveTokenName(mint);
  return { mint, name: named.known ? named.name : shortMint(mint), symbol: named.symbol };
}

/**
 * What they typed after the command: a mint, or a name, and maybe a size.
 *
 * A mint is one word and unmistakable, so it splits cleanly. A name is not: it
 * can contain spaces, and the last word may or may not be a size. The rule is
 * that a trailing word which parses as a size is a size, and everything before
 * it is the query. "/buy baby doge 0.5" works and so does "/buy baby doge".
 */
function parts(args: string): { mint: string | null; query: string; size: string } {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';

  if (MINT_PATTERN.test(first)) {
    return { mint: first, query: '', size: words[1] ?? '' };
  }

  const last = words[words.length - 1] ?? '';
  const trailingSize = words.length > 1 && (parseSol(last) !== null || parsePercent(last) !== null);
  return {
    mint: null,
    query: (trailingSize ? words.slice(0, -1) : words).join(' '),
    size: trailingSize ? last : '',
  };
}

/**
 * A name, turned into something to tap.
 *
 * Best effort by design: the index is somebody else's and a slow one returning
 * nothing is a search that found nothing, which is a sentence rather than a
 * failure. Six is as many as fits on a phone without the card scrolling.
 */
const MATCHES = 6;

async function offerMatches(context: Context, owner: number, query: string): Promise<void> {
  const found: Found[] = (await searchExternalTokens(query, MATCHES)).map((token) => ({
    mint: token.mint,
    name: token.name,
    symbol: token.symbol,
    marketCapUsd: token.marketCapUsd,
  }));

  if (found.length === 0) {
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      parse_mode: 'HTML',
      reply_to_message_id: context.messageId,
      text: html`Nothing found for “${query}”. Paste the mint if you have it.`,
    });
    return;
  }

  await context.telegram.sendMessage({
    chat_id: context.chatId,
    parse_mode: 'HTML',
    reply_to_message_id: context.messageId,
    text: matchesCard(query, found),
    reply_markup: matchesKeyboard(found, owner),
  });
}

async function buy(context: Context, command: Command): Promise<void> {
  const { mint, query, size } = parts(command.args);
  if (!mint && query === '') {
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      reply_to_message_id: context.messageId,
      parse_mode: 'HTML',
      text: 'Give me a token. /buy bonk, or /buy &lt;mint&gt; 0.5 if you have the address.',
    });
    return;
  }

  const linked = await walletOf(context);
  if (!linked) return;

  /*
   * A name gets a list to tap rather than a guess.
   *
   * Picking the first match would be picking somebody's token for them, and a
   * name almost never picks out one token: there are a dozen called bonk and
   * most of them are worth nothing.
   */
  if (!mint) {
    await offerMatches(context, linked.telegramId, query);
    return;
  }

  // No size means show the card rather than guessing one. A bot that picks a
  // number for somebody has spent their money for them.
  if (size === '') {
    const [token, portfolio] = await Promise.all([
      labelFor(mint),
      portfolioFor(linked.wallet, context.now),
    ]);
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      reply_to_message_id: context.messageId,
      parse_mode: 'HTML',
      text: buyPrompt(token, portfolio.solBalance),
      reply_markup: buyKeyboard(linked.telegramId, mint),
    });
    return;
  }

  const lamports = parseSol(size);
  if (lamports === null) {
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      reply_to_message_id: context.messageId,
      parse_mode: 'HTML',
      text: html`I cannot read "${size}" as an amount of SOL.`,
    });
    return;
  }

  await settle(context, linked, mint, 'buy', lamports, context.messageId);
}

async function sell(context: Context, command: Command): Promise<void> {
  const parsed = parts(command.args);
  const { query, size } = parsed;
  if (!parsed.mint && query === '') {
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      reply_to_message_id: context.messageId,
      parse_mode: 'HTML',
      text: 'Give me a token. /sell bonk 50, or /positions to see what you hold.',
    });
    return;
  }

  const linked = await walletOf(context);
  if (!linked) return;

  /*
   * A name here is matched against what they hold, not searched for.
   *
   * Selling is only ever about a position that already exists, so the answer is
   * in a list this bot already has. Searching an outside index for it would be
   * slower, would sometimes return a different token of the same name, and
   * could offer to sell something they do not own.
   */
  let mint = parsed.mint;
  if (!mint) {
    const holdings = (await portfolioFor(linked.wallet, context.now)).held;
    const named = await Promise.all(holdings.map((held) => labelFor(held.mint)));
    const wanted = query.toLowerCase();
    const hits = named.filter(
      (token) =>
        token.name.toLowerCase().includes(wanted) ||
        (token.symbol ?? '').toLowerCase().includes(wanted),
    );

    if (hits.length === 0) {
      await context.telegram.sendMessage({
        chat_id: context.chatId,
        parse_mode: 'HTML',
        reply_to_message_id: context.messageId,
        text: html`You do not hold anything called “${query}”. /positions shows what you do.`,
      });
      return;
    }
    if (hits.length > 1) {
      await context.telegram.sendMessage({
        chat_id: context.chatId,
        parse_mode: 'HTML',
        reply_to_message_id: context.messageId,
        text: lines(
          html`You hold ${hits.length} things matching “${query}”.`,
          rows(...hits.map((token) => `${b(token.symbol ?? token.name)}  ${code(token.mint)}`)),
          'Use the mint, or /positions to tap one.',
        ),
      });
      return;
    }
    mint = hits[0]!.mint;
  }

  if (size === '') {
    const [token, portfolio] = await Promise.all([
      labelFor(mint),
      portfolioFor(linked.wallet, context.now),
    ]);
    const held = portfolio.held.find((position) => position.mint === mint);
    if (!held) {
      await context.telegram.sendMessage({
        chat_id: context.chatId,
        reply_to_message_id: context.messageId,
        parse_mode: 'HTML',
        text: html`You do not hold ${token.name}.`,
      });
      return;
    }
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      reply_to_message_id: context.messageId,
      parse_mode: 'HTML',
      text: sellPrompt(token, held, DECIMALS),
      reply_markup: sellKeyboard(linked.telegramId, mint),
    });
    return;
  }

  const percent = parsePercent(size);
  if (percent === null) {
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      reply_to_message_id: context.messageId,
      parse_mode: 'HTML',
      text: html`I cannot read "${size}" as a share of your position. Try 50, or all.`,
    });
    return;
  }

  await settle(context, linked, mint, 'sell', percent, context.messageId);
}

/**
 * Place it and say what happened.
 *
 * The fill genuinely takes a moment: it reads the pool, waits out the season's
 * latency, and reads it again. Saying so first is not decoration, it is the
 * difference between a bot that looks stuck and one that is visibly doing the
 * thing that makes the fill honest.
 */
async function settle(
  context: Context,
  linked: { wallet: string; telegramId: number },
  mint: string,
  side: 'buy' | 'sell',
  amount: bigint | number,
  replyTo: number | undefined,
): Promise<void> {
  const [token, outcome] = await Promise.all([
    labelFor(mint),
    tradeFromChat({ pubkey: linked.wallet, mint, side, amount, now: context.now }),
  ]);

  await context.telegram.sendMessage({
    chat_id: context.chatId,
    disable_web_page_preview: true,
    ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }),
    parse_mode: 'HTML',
    text: outcomeCard(outcome, token, side, linked.wallet, DECIMALS),
    // Somebody who has just bought is one tap from being able to get out again,
    // which is the point of a fill card rather than a receipt.
    ...(outcome.status === 'filled' && side === 'buy'
      ? { reply_markup: sellKeyboard(linked.telegramId, mint) }
      : {}),
  });
}

async function positions(context: Context): Promise<void> {
  const linked = await walletOf(context);
  if (!linked) return;

  const portfolio = await portfolioFor(linked.wallet, context.now);
  const names = new Map<string, TokenLabel>();
  await Promise.all(
    portfolio.held.map(async (held) => void names.set(held.mint, await labelFor(held.mint))),
  );

  const keyboard = positionsKeyboard(portfolio, names, linked.telegramId);
  await context.telegram.sendMessage({
    chat_id: context.chatId,
    reply_to_message_id: context.messageId,
    parse_mode: 'HTML',
    text: positionsCard(portfolio, names),
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

async function balance(context: Context): Promise<void> {
  const linked = await walletOf(context);
  if (!linked) return;

  await context.telegram.sendMessage({
    chat_id: context.chatId,
    reply_to_message_id: context.messageId,
    disable_web_page_preview: true,
    parse_mode: 'HTML',
    text: balanceCard(await portfolioFor(linked.wallet, context.now)),
  });
}

/**
 * A tap on a size.
 *
 * The card belongs to whoever summoned it, and the owner is carried in the
 * button rather than inferred from the message. In a group anybody can tap
 * anybody's buttons, and without this a stranger's tap would place a real fill
 * on somebody else's public record. That is not a griefing problem to be
 * tolerated because the money is practice: the record is the product.
 *
 * The tap is answered before the fill is attempted. Telegram spins the button
 * until the callback is answered, and the fill deliberately takes seconds.
 */
async function onSize(context: Context, data: string, query: CallbackQuery): Promise<void> {
  const action = parseAction(data);
  if (!action) {
    await context.telegram.answerCallbackQuery({ callback_query_id: query.id });
    return;
  }

  if (query.from.id !== action.owner) {
    await context.telegram.answerCallbackQuery({
      callback_query_id: query.id,
      show_alert: true,
      text: 'This card is somebody else’s. Send /buy with the mint to get your own.',
    });
    return;
  }

  const wallet = await linkedWallet(await db(), query.from.id);
  if (!wallet) {
    await context.telegram.answerCallbackQuery({
      callback_query_id: query.id,
      show_alert: true,
      text: 'Connect an account first. Send me /link in a direct message.',
    });
    return;
  }

  /*
   * A pick from a search is not a trade. It opens the card the mint would have
   * opened, so the size is still chosen deliberately rather than inherited from
   * whichever button happened to be tapped to get here.
   */
  if (action.tag === 't') {
    await context.telegram.answerCallbackQuery({ callback_query_id: query.id });
    const [token, portfolio] = await Promise.all([
      labelFor(action.mint),
      portfolioFor(wallet, context.now),
    ]);
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      parse_mode: 'HTML',
      text: buyPrompt(token, portfolio.solBalance),
      reply_markup: buyKeyboard(query.from.id, action.mint),
    });
    return;
  }

  await context.telegram.answerCallbackQuery({
    callback_query_id: query.id,
    text: action.tag === 'b' ? `Buying ${action.amount} SOL…` : `Selling ${action.amount}%…`,
  });

  const amount = action.tag === 'b' ? parseSol(action.amount) : parsePercent(action.amount);
  if (amount === null) return;

  await settle(
    context,
    { wallet, telegramId: query.from.id },
    action.mint,
    action.tag === 'b' ? 'buy' : 'sell',
    amount,
    undefined,
  );
}

/**
 * What the season is doing.
 *
 * The bot could trade all day without ever mentioning that a competition is
 * running, which is the state it was in: somebody placing fills from a chat had
 * no idea there was a season, a deadline or a pot. That is the product going
 * unmentioned by the surface most likely to be their only contact with it.
 *
 * Works without an account. The pot, the deadline and the field are public, and
 * a person deciding whether to enter is exactly the person who has not linked
 * anything yet.
 */
async function season(context: Context): Promise<void> {
  const wallet = context.userId === null ? null : await linkedWallet(await db(), context.userId);
  const now = await seasonNow(wallet, context.now);

  await context.telegram.sendMessage({
    chat_id: context.chatId,
    parse_mode: 'HTML',
    reply_to_message_id: context.messageId,
    disable_web_page_preview: true,
    text: now
      ? seasonCard(now, context.now)
      : lines(
          'No ranked season is running.',
          `Free play is always open, so you can trade now and enter the next one when it opens. ${SITE}/season`,
        ),
  });
}

/**
 * A trader's fills, pushed into this chat as they land.
 *
 * The one thing the bot can do that the site cannot. A record on a page is
 * something you go and look at; a fill arriving in the room you are already in
 * is something you react to, and reacting is the whole activity.
 *
 * Keyed on the chat rather than on the person, unlike the account link. A watch
 * is a thing a room subscribes to: somebody sets one up in a group and everyone
 * in the group is meant to see it. Which also means anybody in the room can
 * remove it, and there is a ceiling so one member cannot fill the room up.
 *
 * Nothing here is private. A watch delivers fills that are already on a public
 * profile, which is why it does not ask the trader's permission and why it does
 * not need the watcher to have an account of their own.
 */
async function watch(context: Context, command: Command): Promise<void> {
  if (context.userId === null) return;

  const wallet = findWallet(command.args) ?? findWallet(context.replyTo?.text);
  if (!wallet) {
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      reply_to_message_id: context.messageId,
      parse_mode: 'HTML',
      text: 'Give me a wallet. /watch &lt;wallet&gt;, and their fills arrive here as they land.',
    });
    return;
  }

  const result = await watchTrader(await db(), {
    chatId: context.chatId,
    telegramUserId: context.userId,
    trader: wallet,
    now: context.now,
  });

  const said =
    result === 'added'
      ? lines(
          html`Watching ${short(wallet)}.`,
          'Their fills arrive here as they land, from now on. Nothing from before.',
          '/watching shows who else this chat follows.',
        )
      : result === 'already'
        ? html`Already watching ${short(wallet)}.`
        : lines(
            `This chat is already watching ${b(MAX_WATCHES_PER_CHAT)} traders, which is the limit.`,
            '/watching lists them, and /unwatch drops one.',
          );

  await context.telegram.sendMessage({
    chat_id: context.chatId,
    parse_mode: 'HTML',
    reply_to_message_id: context.messageId,
    text: said,
  });
}

async function unwatch(context: Context, command: Command): Promise<void> {
  const wallet = findWallet(command.args);
  if (!wallet) {
    await context.telegram.sendMessage({
      chat_id: context.chatId,
      reply_to_message_id: context.messageId,
      text: 'Give me a wallet. /watching lists what this chat follows.',
    });
    return;
  }

  const dropped = await unwatchTrader(await db(), context.chatId, wallet);
  await context.telegram.sendMessage({
    chat_id: context.chatId,
    reply_to_message_id: context.messageId,
    parse_mode: 'HTML',
    text: dropped
      ? html`Stopped watching ${short(wallet)}.`
      : html`This chat was not watching ${short(wallet)}.`,
  });
}

async function watching(context: Context): Promise<void> {
  const watches = await watchesFor(await db(), context.chatId);

  await context.telegram.sendMessage({
    chat_id: context.chatId,
    reply_to_message_id: context.messageId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text:
      watches.length === 0
        ? 'This chat is not watching anybody. /watch &lt;wallet&gt; to start.'
        : lines(
            `Watching ${b(`${watches.length} of ${MAX_WATCHES_PER_CHAT}`)}`,
            rows(...watches.map((row) => `<a href="${SITE}/p/${row.trader}">${short(row.trader)}</a>`)),
          ),
  });
}
