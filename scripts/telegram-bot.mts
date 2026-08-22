/**
 * Drive the whole bot without Telegram.
 *
 * Type what somebody would type, and see what would be sent back. Every message
 * goes through the real router and the real handlers, which place real fills
 * through the same engine the website uses; only the transport is swapped for
 * one that prints.
 *
 * This is the last piece that does not need a token, and it exists because of
 * how the rest was ordered. The transport went behind an interface first
 * precisely so the bot could be finished and exercised before BotFather had
 * ever heard of it. The alternative was writing eleven commands untested and
 * finding out in a live chat, in public, with somebody's record attached.
 *
 * What it catches that the unit tests cannot: whether a card is worth reading.
 * A line break in the wrong place, a number with fourteen decimals, a refusal
 * phrased so it sounds like the bot broke. All of that passes every assertion
 * and is obvious the moment it is laid out the way a chat lays it out.
 *
 *   DATABASE_URL=file:./app/probatio.db npm run bot
 *   DATABASE_URL=file:./app/probatio.db npm run bot -- --replay
 *
 * /verify reads the record through the site's public proof endpoint, the same
 * way anybody else would, so it needs to be able to reach it. Set PROBATIO_SITE
 * to point somewhere else: a local server, or the host directly when a router
 * is caching a bad answer for the domain.
 *
 * Meta-commands start with a colon so they cannot collide with the bot's own.
 * `:help` lists them.
 */
import { createInterface } from 'node:readline/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrintingTelegram } from './telegram/transport.mts';
import { route } from '../app/lib/telegram/router.ts';
import { HANDLERS } from '../app/lib/telegram/handlers.ts';
import type { Update } from '../app/lib/telegram/types.ts';

const DIM = '[2m';
const BOLD = '[1m';
const WARN = '[33m';
const RESET = '[0m';

/*
 * Which database this is about to write to, said out loud before anything runs.
 *
 * /buy and /sell here are not a simulation of a fill, they are a fill: the same
 * `executeTrade` the website calls, writing a sealed trade to whatever database
 * is configured. Pointed at production by an environment left over from another
 * terminal, this would put real rows on a real trader's public record. So a
 * non-local database has to be asked for explicitly.
 */
const url = process.env['DATABASE_URL'] ?? 'file:./app/probatio.db';
const local = url.startsWith('file:');
const forced = process.argv.includes('--yes-really');

console.log(`${DIM}database ${url}${RESET}`);
if (!local && !forced) {
  console.error(
    `\n${WARN}That is not a local file, and /buy here writes real sealed fills.${RESET}\n` +
      'Point DATABASE_URL at a local copy, or pass --yes-really if you meant it.',
  );
  process.exit(1);
}
process.env['DATABASE_URL'] = url;

const telegram = new PrintingTelegram();

/** Who is typing, and where. Both changeable, because both change what happens. */
const session = {
  userId: 42,
  chatId: -100,
  chatType: 'private' as 'private' | 'group',
  /** The message being replied to, which is how /verify and /watch are used. */
  replyText: null as string | null,
  replyFrom: null as number | null,
};

let messageId = 100;
let updateId = 1;

function message(text: string): Update {
  messageId += 1;
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1_000),
      from: { id: session.userId, first_name: 'You' },
      chat: { id: session.chatId, type: session.chatType },
      text,
      ...(session.replyText === null
        ? {}
        : {
            reply_to_message: {
              message_id: messageId - 1,
              date: Math.floor(Date.now() / 1_000),
              chat: { id: session.chatId, type: session.chatType },
              text: session.replyText,
              ...(session.replyFrom === null
                ? {}
                : { from: { id: session.replyFrom, first_name: 'Them' } }),
            },
          }),
    },
  };
}

function tap(data: string): Update {
  updateId += 1;
  return {
    update_id: updateId,
    callback_query: {
      id: `tap-${updateId}`,
      from: { id: session.userId, first_name: 'You' },
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1_000),
        chat: { id: session.chatId, type: session.chatType },
        text: 'the card',
      },
    },
  };
}

function inline(query: string): Update {
  updateId += 1;
  return {
    update_id: updateId,
    inline_query: {
      id: `inline-${updateId}`,
      from: { id: session.userId, first_name: 'You' },
      query,
      offset: '',
    },
  };
}

async function deliver(update: Update): Promise<void> {
  await route(update, telegram, HANDLERS);
}

/*
 * Awkward shapes, recorded once.
 *
 * A reply in a group, an inline query from a chat the bot was never added to, a
 * tap from somebody the card does not belong to. Each is a payload that is
 * tedious to construct by hand and easy to get subtly wrong, and each is a case
 * where the bot is supposed to refuse or redirect rather than do the obvious
 * thing. Kept as files so they are replayed identically every time.
 */
const RECORDED = fileURLToPath(new URL('./telegram/updates', import.meta.url));

function recorded(): { name: string; update: Update }[] {
  try {
    return readdirSync(RECORDED)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => ({
        name: name.replace(/\.json$/, ''),
        update: JSON.parse(readFileSync(`${RECORDED}/${name}`, 'utf8')) as Update,
      }));
  } catch {
    return [];
  }
}

async function replay(): Promise<void> {
  const all = recorded();
  if (all.length === 0) {
    console.error('nothing recorded to replay');
    process.exit(1);
  }
  for (const { name, update } of all) {
    console.log(`\n${BOLD}== ${name.replace(/^\d+-/, '').replace(/-/g, ' ')}${RESET}`);
    await deliver(update);
  }
  console.log('');
}

const HELP = [
  '',
  `${BOLD}Type anything to send it as a message.${RESET}`,
  '',
  ':help            this',
  ':who             who you are and where you are typing',
  ':as <id>         type as a different Telegram account',
  ':chat private    a direct message',
  ':chat group      a group, which is where the interesting refusals live',
  ':reply <text>    make the next message a reply to this text',
  ':reply from <id> and say who wrote it',
  ':reply off       stop replying',
  ':tap <n>         press a button from the last card',
  ':inline <query>  as if typed in a chat that never added the bot',
  ':replay          run every recorded update',
  ':quit',
  '',
].join('\n');

function who(): void {
  console.log(
    `${DIM}user ${session.userId}, ${session.chatType} chat ${session.chatId}` +
      (session.replyText === null
        ? ''
        : `, replying to ${JSON.stringify(session.replyText)}` +
          (session.replyFrom === null ? '' : ` from ${session.replyFrom}`)) +
      RESET,
  );
}

/** A meta-command, or null when the line is something to send to the bot. */
async function meta(line: string): Promise<boolean> {
  if (!line.startsWith(':')) return false;
  const [command = '', ...rest] = line.slice(1).split(/\s+/);
  const args = rest.join(' ');

  switch (command) {
    case 'help':
      console.log(HELP);
      return true;
    case 'who':
      who();
      return true;
    case 'as': {
      const id = Number(args);
      if (!Number.isSafeInteger(id) || id <= 0) console.log('give me a Telegram id');
      else session.userId = id;
      who();
      return true;
    }
    case 'chat':
      if (args === 'group' || args === 'private') {
        session.chatType = args;
        // Telegram's group ids are negative and its private ids are the user's,
        // and some of this bot's rules key on the chat, so they must differ.
        session.chatId = args === 'group' ? -100 : session.userId;
      } else console.log('either group or private');
      who();
      return true;
    case 'reply':
      if (args === 'off' || args === '') {
        session.replyText = null;
        session.replyFrom = null;
      } else if (args.startsWith('from ')) {
        const id = Number(args.slice(5));
        session.replyFrom = Number.isSafeInteger(id) && id > 0 ? id : null;
      } else {
        session.replyText = args;
      }
      who();
      return true;
    case 'tap': {
      const index = Number(args);
      const button = telegram.buttons[index - 1];
      if (!button) {
        console.log(
          telegram.buttons.length === 0
            ? 'no buttons on the last message'
            : `pick 1 to ${telegram.buttons.length}`,
        );
        return true;
      }
      console.log(`${DIM}you tap "${button.label}"${RESET}`);
      await deliver(tap(button.data));
      return true;
    }
    case 'inline':
      await deliver(inline(args));
      return true;
    case 'replay':
      await replay();
      return true;
    case 'quit':
    case 'exit':
      process.exit(0);
    // eslint-disable-next-line no-fallthrough
    default:
      console.log(`no such thing as :${command}. Try :help`);
      return true;
  }
}

if (process.argv.includes('--replay')) {
  await replay();
  process.exit(0);
}

console.log(HELP);
who();

const readline = createInterface({ input: process.stdin, output: process.stdout });

/*
 * Iterated rather than prompted in a loop, so a file of commands works.
 *
 * `question()` in a `for(;;)` reads fine from a terminal and mishandles a pipe:
 * the input ends the moment every line is buffered, and the loop is then either
 * waiting on a prompt nobody will answer or racing a close handler that fires
 * before the lines are consumed. Iterating drains what was sent and then stops,
 * which is what both a person and a script want. Scripting it is a fair way to
 * use this, since it is how the replay of a bug report gets written down.
 */
readline.setPrompt('\n> ');

/*
 * A prompt after the input has closed throws, and a piped file closes stdin
 * while there are still buffered lines to work through. So the prompt is only
 * ever drawn while there is somebody left to read it.
 */
let closed = false;
readline.on('close', () => {
  closed = true;
});

const prompt = (): void => {
  if (!closed) readline.prompt();
};

prompt();

for await (const raw of readline) {
  const line = raw.trim();
  if (line !== '') {
    try {
      if (!(await meta(line))) await deliver(message(line));
    } catch (error) {
      /*
       * The router does not throw, so anything landing here is the harness or
       * the database rather than the bot. Printed and carried on, because
       * losing a session to a typo is worse than seeing a stack trace.
       */
      console.error(`${WARN}harness error${RESET}`, error);
    }
  }
  prompt();
}

console.log('');
process.exit(0);
