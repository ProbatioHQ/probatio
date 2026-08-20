/**
 * Point Telegram at this deployment, and check it will work.
 *
 * Three things Telegram has to be told, and two it has to be asked.
 *
 * Told: where to deliver updates, what secret it will send with them, and what
 * commands to offer in the menu. Asked: whether inline mode is on and whether
 * privacy mode is off — the two settings that live in BotFather rather than in
 * the API, that half this bot depends on, and that fail silently when wrong.
 *
 * That last part is the reason this is a script and not a curl command in a
 * README. A bot with inline mode off does not error; it simply never appears
 * when somebody types its name, and the feature that was supposed to carry this
 * into other people's group chats is dead with nothing in any log to say so.
 * The same is true of privacy mode: leave it on and the bot cannot see the
 * message it is replying to, so reply-to-verify quietly stops finding wallets.
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
 *     npx tsx scripts/telegram-setup.mts https://probatiotrade.com
 *
 *   npx tsx scripts/telegram-setup.mts --check      (asks, changes nothing)
 *   npx tsx scripts/telegram-setup.mts --remove     (stops delivery)
 *
 * The token is read from the environment and never printed, not even in an
 * error. It is a bearer credential for the whole bot, and a URL containing one
 * has a way of ending up in a log.
 */
const BOLD = '[1m';
const DIM = '[2m';
const GOOD = '[32m';
const WARN = '[33m';
const BAD = '[31m';
const RESET = '[0m';

const token = process.env['TELEGRAM_BOT_TOKEN'];
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set. BotFather hands it to you with /newbot.');
  process.exit(1);
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const remove = args.includes('--remove');
const site = args.find((arg) => arg.startsWith('http'));

interface Reply<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/** One call. The token is in the URL, so no failure may ever print the URL. */
async function call<T>(method: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  const reply = (await response.json()) as Reply<T>;
  if (!reply.ok) throw new Error(`${method}: ${reply.error_code} ${reply.description}`);
  return reply.result as T;
}

/**
 * The menu Telegram shows when somebody types a slash.
 *
 * Kept in the same order as /help, because two lists of the same commands that
 * disagree is worse than one list. Descriptions are lower case and short:
 * Telegram renders them in a cramped row under the input box.
 */
const COMMANDS = [
  { command: 'start', description: 'what this is' },
  { command: 'help', description: 'everything I can do' },
  { command: 'verify', description: 'check anybody’s record' },
  { command: 'buy', description: 'buy a token' },
  { command: 'sell', description: 'sell a token' },
  { command: 'positions', description: 'what you hold' },
  { command: 'balance', description: 'what it is worth' },
  { command: 'season', description: 'the pot, the deadline, and where you stand' },
  { command: 'watch', description: 'a trader’s fills, here, as they land' },
  { command: 'unwatch', description: 'stop watching a trader' },
  { command: 'watching', description: 'who this chat follows' },
  { command: 'link', description: 'connect your Probatio account' },
  { command: 'unlink', description: 'disconnect it' },
];

interface Me {
  username?: string;
  first_name?: string;
  supports_inline_queries?: boolean;
  can_read_all_group_messages?: boolean;
}

interface Hook {
  url?: string;
  has_custom_certificate?: boolean;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
  allowed_updates?: string[];
}

/*
 * Who this token belongs to, and the first thing that can go wrong.
 *
 * A wrong or revoked token fails here, and Telegram's own wording for it says
 * nothing about a token because the token is in the path it could not match.
 * Caught so it reads as the one thing it can mean, rather than as a stack
 * trace ending in a line number.
 */
let me: Me;
try {
  me = await call<Me>('getMe');
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(
    `${BAD}Telegram would not accept that token.${RESET}\n` +
      `  ${DIM}${detail}${RESET}\n` +
      '  A refusal here means the token is wrong or has been revoked. It is the\n' +
      '  only thing this call depends on. Check TELEGRAM_BOT_TOKEN, or ask\n' +
      '  @BotFather for a fresh one with /token.',
  );
  process.exit(1);
}
console.log(`${BOLD}@${me.username ?? '?'}${RESET} ${DIM}(${me.first_name ?? ''})${RESET}\n`);

/*
 * The two BotFather settings, checked rather than assumed.
 *
 * Neither can be set through the API — they are toggles in a chat with
 * BotFather — so the most this can do is say plainly which one is wrong and
 * what to type. Which is enough: the whole failure mode is not knowing.
 */
let blocked = false;

if (me.supports_inline_queries) {
  console.log(`${GOOD}inline mode on${RESET}  ${DIM}/verify works in chats that never added the bot${RESET}`);
} else {
  blocked = true;
  console.log(
    `${BAD}inline mode OFF${RESET}\n` +
      `  Nothing will error. The bot simply never appears when somebody types its\n` +
      `  name, and the feature meant to carry this into other people's chats is dead.\n` +
      `  ${BOLD}Fix:${RESET} message @BotFather, /setinline, pick @${me.username ?? 'yourbot'},\n` +
      `  and give it a placeholder like "paste a wallet address".`,
  );
}

if (me.can_read_all_group_messages) {
  console.log(`${GOOD}privacy mode off${RESET} ${DIM}the bot can see the message a /verify replies to${RESET}`);
} else {
  blocked = true;
  console.log(
    `${BAD}privacy mode ON${RESET}\n` +
      `  In a group the bot cannot read the message it is replying to, so\n` +
      `  reply-to-verify finds no wallet and quietly asks for one instead.\n` +
      `  ${BOLD}Fix:${RESET} message @BotFather, /setprivacy, pick @${me.username ?? 'yourbot'}, Disable.`,
  );
}

if (check) {
  const hook = await call<Hook>('getWebhookInfo');
  console.log(
    `\n${BOLD}delivery${RESET}\n` +
      `  url            ${hook.url || `${DIM}none — Telegram is delivering nowhere${RESET}`}\n` +
      `  pending        ${hook.pending_update_count ?? 0}\n` +
      `  allowed        ${(hook.allowed_updates ?? []).join(', ') || 'all'}` +
      (hook.last_error_message
        ? `\n  ${WARN}last error    ${hook.last_error_message}${RESET}` +
          `\n  ${DIM}at            ${new Date((hook.last_error_date ?? 0) * 1_000).toISOString()}${RESET}`
        : ''),
  );
  process.exit(blocked ? 1 : 0);
}

if (remove) {
  // Dropping what is queued as well. Anything Telegram is still holding was
  // meant for a deployment that is no longer listening, and delivering a
  // day-old /buy to a new one is worse than losing it.
  await call('deleteWebhook', { drop_pending_updates: true });
  console.log(`\n${GOOD}delivery stopped${RESET} ${DIM}and the queue dropped${RESET}`);
  process.exit(0);
}

if (!site) {
  console.error(
    '\nGive me the site to deliver to, or --check to look without changing anything.\n' +
      '  npx tsx scripts/telegram-setup.mts https://probatiotrade.com',
  );
  process.exit(1);
}

const secret = process.env['TELEGRAM_WEBHOOK_SECRET'];
if (!secret) {
  console.error(
    '\nTELEGRAM_WEBHOOK_SECRET is not set.\n' +
      'The webhook refuses everything without one, so registering a URL now would\n' +
      'point Telegram at an endpoint that answers 404 to every update. Generate one\n' +
      'with `openssl rand -hex 32`, put it in Railway, then run this.',
  );
  process.exit(1);
}

await call('setMyCommands', { commands: COMMANDS });
console.log(`\n${GOOD}menu set${RESET} ${DIM}${COMMANDS.length} commands${RESET}`);

await call('setWebhook', {
  url: `${site.replace(/\/$/, '')}/api/telegram/webhook`,
  secret_token: secret,
  /*
   * Only what is handled, named explicitly.
   *
   * Telegram's default is a set that grows as they add features, and every
   * unhandled type is a delivery this app claims, dedupes and discards. Asking
   * for three means the three the router actually routes.
   */
  allowed_updates: ['message', 'callback_query', 'inline_query'],
  // Anything queued was meant for whatever was listening before. A /buy from an
  // hour ago should not fill now because a webhook was re-pointed.
  drop_pending_updates: true,
});
console.log(`${GOOD}delivery set${RESET} ${DIM}${site}/api/telegram/webhook${RESET}`);

const hook = await call<Hook>('getWebhookInfo');
if (hook.last_error_message) {
  console.log(`\n${WARN}Telegram's last delivery failed:${RESET} ${hook.last_error_message}`);
  console.log(`${DIM}That may be from before this run. Send the bot /start and check again.${RESET}`);
}

console.log(
  blocked
    ? `\n${WARN}Registered, but fix the BotFather settings above before anybody uses it.${RESET}`
    : `\n${GOOD}Ready.${RESET} Send it /start.`,
);
process.exit(blocked ? 1 : 0);
