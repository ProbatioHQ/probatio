import { TELEGRAM_PLACES } from '@/lib/telegram-links';

export const metadata = {
  title: 'Telegram, Probatio',
  description:
    'Trade from a chat, check anybody’s record, and follow a trader’s fills as they land.',
};

/**
 * The three places Probatio is on Telegram.
 *
 * One page rather than three links dropped into a footer, because they do
 * different things and the difference matters: one of them places real fills on
 * your record, one is read only, and one is a room full of people. Somebody
 * arriving from a chat should be able to tell which is which before they tap.
 *
 * The community chat does not exist yet. It is listed as coming rather than
 * hidden, because a list of three with one marked "shortly" is more honest than
 * a list of two that quietly grows later, and because it is the thing people
 * ask for first.
 */
export default function TelegramPage() {
  return (
    <main className="prose page-prose">
      <h1>Probatio on Telegram</h1>

      <p>
        The bot trades the same accounts as this site, through the same engine. A fill placed
        from a chat waits out the same latency, is quoted against the same pool, and is sealed
        into the same record as one placed here.
      </p>

      <div className="tg-list">
        {TELEGRAM_PLACES.map((place) => {
          const body = (
            <>
              <span className="tg-name">
                {place.name}
                {place.handle ? <span className="tg-handle">{place.handle}</span> : null}
              </span>
              <span className="tg-what">{place.what}</span>
            </>
          );

          return place.url ? (
            <a
              key={place.name}
              className="tg-item"
              href={place.url}
              target="_blank"
              rel="noreferrer"
            >
              {body}
              <span className="tg-go" aria-hidden="true" />
            </a>
          ) : (
            /* Not a link, and not styled like one. A disabled anchor still
               looks tappable on a phone, and tapping something that does
               nothing is worse than it plainly not being ready. */
            <div key={place.name} className="tg-item tg-soon">
              {body}
              <span className="tg-badge">Soon</span>
            </div>
          );
        })}
      </div>

      <h2>Every command</h2>
      <table>
        <thead>
          <tr>
            <th>Command</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>/start</code></td>
            <td>What this is</td>
          </tr>
          <tr>
            <td><code>/help</code></td>
            <td>The list, in the chat</td>
          </tr>
          <tr>
            <td><code>/verify</code></td>
            <td>Recompute anybody’s record from its seals. Typed, replied, or inline</td>
          </tr>
          <tr>
            <td><code>/buy</code></td>
            <td>Buy a token by name or by mint, with a size or from a card of sizes</td>
          </tr>
          <tr>
            <td><code>/sell</code></td>
            <td>Sell a share of a position by name or mint: a percentage, or <code>all</code></td>
          </tr>
          <tr>
            <td><code>/positions</code></td>
            <td>What you hold, with sell sizes on each</td>
          </tr>
          <tr>
            <td><code>/balance</code></td>
            <td>Free SOL, total including positions, and your return</td>
          </tr>
          <tr>
            <td><code>/season</code></td>
            <td>The pot, the deadline, and where you stand in it</td>
          </tr>
          <tr>
            <td><code>/watch</code></td>
            <td>A trader’s fills, in this chat, as they land</td>
          </tr>
          <tr>
            <td><code>/unwatch</code></td>
            <td>Stop following one</td>
          </tr>
          <tr>
            <td><code>/watching</code></td>
            <td>Who this chat follows</td>
          </tr>
          <tr>
            <td><code>/link</code></td>
            <td>Connect your Probatio account. Direct messages only</td>
          </tr>
          <tr>
            <td><code>/unlink</code></td>
            <td>Disconnect it. The record is untouched</td>
          </tr>
        </tbody>
      </table>

      <h2>Checking a record</h2>
      <p>
        <code>/verify</code> is the one this bot exists for. It fetches somebody’s sealed fills
        and recomputes every hash with the same open source code anybody else can run, then
        reports what the arithmetic says. It does not look an answer up and repeat it.
      </p>
      <p>There are three ways to name a wallet, because people arrive with different things in hand:</p>
      <ul>
        <li>
          <code>/verify &lt;wallet&gt;</code> when you have the address.
        </li>
        <li>
          <code>/verify</code> as a <strong>reply</strong> to somebody’s message. It takes the
          address out of that message, and if there is none it uses the linked account of whoever
          wrote it. Somebody posts a claim, somebody else replies with seven characters, and the
          argument is over without either of them leaving the chat.
        </li>
        <li>
          <code>/verify</code> on its own in a direct message, which means yours.
        </li>
      </ul>
      <p>
        It also runs <strong>inline</strong>. Type the bot’s name followed by a wallet in any
        chat, including ones it has never been added to, and a verified record appears in the
        conversation. Nothing is cached, because the answer is a claim about a record that can
        change.
      </p>
      <p>
        Three outcomes are kept strictly apart: a record that does not verify, a wallet with no
        record here, and the bot failing to reach the record. The last is the bot’s problem, not
        a verdict on anybody, and it says so.
      </p>

      <h2>Trading</h2>
      <p>
        <code>/buy bonk</code> searches by name and gives you a few matches to tap, with each
        one’s market cap beside it, because a name almost never picks out one token and the size
        is how you tell the real one from the impostors. Tapping one opens the same card the mint
        would have. <code>/buy</code> with a mint skips straight there.
      </p>
      <p>
        <code>/buy &lt;mint&gt; 0.5</code> fills straight away. Without a size it shows a card of
        sizes to tap, because a bot that picks a number for you has spent your money for you.
        Tapping a search result never places anything on its own for the same reason.
      </p>
      <p>
        <code>/sell bonk 50</code> sells half. A name here is matched against what you already
        hold rather than searched for: selling is only ever about a position that exists, so the
        answer is in a list the bot already has, and searching an index for it could offer to
        sell something you do not own. The word <code>all</code> works, and so does{' '}
        <code>half</code>.
      </p>
      <p>
        A share is resolved against what you actually hold at the moment of the fill rather than
        baked into the button, so a card left sitting in a chat cannot try to sell tokens that
        are no longer there.
      </p>
      <p>Every fill card prints what you were quoted beside what you were given:</p>
      <ul>
        <li>the size asked for and the size filled, with the difference as a percentage</li>
        <li>price impact, the fee, and how long the order waited in flight</li>
        <li>your new balance, and what a sell realised</li>
        <li>whether it was only partly filled, because the pool could not take the whole size</li>
        <li>the sequence number it was sealed as, and a link to the record</li>
      </ul>
      <p>
        Refusals are printed as plainly as fills. A rejected trade is a real outcome rather than
        an error: real transactions revert, and a simulator whose fills never fail is teaching a
        habit that costs money later. A suspended token, an unreadable chain and a price that
        moved past your limit are three different sentences.
      </p>
      <p>
        <code>/positions</code> lists what you hold with a row of sell sizes on each one.{' '}
        <code>/balance</code> gives your free SOL, your total including open positions, and your
        return against what the account started with.
      </p>

      <h2>The season</h2>
      <p>
        <code>/season</code> gives the pot, how long is left to enter, what first place takes,
        and how many more entries would widen the payout. If you are in it, it says where you
        stand and by how much.
      </p>
      <p>
        It works without an account, because the pot and the deadline are public and the person
        deciding whether to enter is exactly the person who has not linked anything yet. The
        figures come from the same functions the season page reads, so the two cannot disagree
        about the deadline.
      </p>

      <h2>Following a trader</h2>
      <p>
        <code>/watch &lt;wallet&gt;</code> and their fills arrive in that chat as they land,
        within about twenty seconds. It works in a group, so a room can follow somebody together,
        and it needs no account of its own: a watch delivers fills that are already on a public
        profile.
      </p>
      <p>
        It starts from now. Subscribing to somebody with two thousand fills does not replay two
        thousand fills into the room. <code>/watching</code> lists who a chat follows and{' '}
        <code>/unwatch</code> drops one. A chat can follow ten traders, which is a ceiling so one
        person cannot fill a room up.
      </p>

      <h2>In a group</h2>
      <p>
        A card belongs to whoever summoned it. Anybody can tap anybody’s buttons in a group, so
        every button carries its owner and a tap from somebody else is refused rather than
        placing a real fill on another person’s public record.
      </p>
      <p>
        <code>/link</code> refuses to work in a group at all, because a link code is a bearer
        token for an account and posting one into a room hands it to the room. An unknown command
        is answered in a direct message and ignored in a group, since in a group it is almost
        always somebody else’s bot being addressed.
      </p>

      <h2>Connecting your account</h2>
      <p>
        The bot knows who is typing and has no idea which wallet they own, so it cannot connect
        an account on its own. Send it <code>/link</code> and it hands you a code, then enter that
        code here signed in with the wallet you trade on. The signature is what proves the
        wallet; the code only carries you from one to the other. It is good for ten minutes and
        one use.
      </p>
      <p>
        The link is keyed to you rather than to a chat, so it is the same account whether you
        type in a group on Monday or a direct message on Tuesday. One wallet per Telegram account
        and one Telegram account per wallet. <code>/unlink</code> disconnects and touches nothing
        else: the record is the record.
      </p>
      <p>
        Until you link, the bot will check records and follow traders but will not place
        anything. <a href="/link">The linking page is here</a>.
      </p>
    </main>
  );
}
