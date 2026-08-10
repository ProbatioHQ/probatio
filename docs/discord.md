# Discord

Two jobs, and they pull in different directions. It is where people argue about
the leaderboard, which is what brings them back. It is also the only support
channel, which means somebody has to be able to find an answer in it.

Nothing here is implemented. It is the design and the list of what would need
building.

---

## Why this is the retention mechanic

A leaderboard is only interesting if people talk about it, and they only talk
about it if there is something to disagree over.

What is different here is that **the disagreements are resolvable.** In every
other trading community "I'm up 300%" is unfalsifiable — a screenshot, a claim,
an argument that goes nowhere and repeats next week. Here the record is
committed on chain and anybody can check it in their browser.

That changes the shape of the conversation from bragging to evidence, and it is
the one thing this community would have that no other trading Discord does. It
should be the thing the server is built around, not a rule buried in a channel
description.

The practical consequence: **when somebody disputes a result, the answer is a
link, not an opinion.** Every argument ends the same way and ends quickly.

---

## Structure

Deliberately small. One person is moderating, and a server with twenty channels
where nineteen are dead reads worse than a server with five that are used.

| Channel | For |
|---|---|
| `#rules` | Read-only. The scam warning below is the first line. |
| `#announcements` | Read-only. Seasons opening and closing, results, incidents. |
| `#trading` | The main room. Calls, arguing, screenshots that can be checked. |
| `#leaderboard` | Standings and results. The room where the trash talk has a subject. |
| `#help` | The only support channel. Questions get answered here, never in DMs. |
| `#verify` | Somebody disputes a record, somebody else checks it. Keeps the argument out of `#trading`. |

`#verify` is the one that would not exist in a normal trading server, and it is
the point of the whole thing.

---

## Rules

Short enough that people read them.

1. **Nobody from this project will ever DM you first.** Not for support, not
   about a prize, not about your wallet. Anyone who does is impersonating us.
   Report and block them.
2. **Never share a seed phrase or private key.** Nothing here ever needs one.
   Signing in proves a wallet is yours and authorises no transaction.
3. No links to other people's tokens in `#help` or `#announcements`.
4. Disputes about a record go to `#verify` with the wallet address. Anybody can
   check it; nobody has to be believed.
5. Being wrong is fine. Faking a screenshot is not, and here it is detectable.

Rule 1 is first for a reason. Crypto Discords are farmed for scam DMs the moment
they have members, the impersonation always starts with a private message
offering help, and a server whose only support channel is public is unusually
well placed to say so plainly.

---

## Support

Most questions have a page already. The answer is a link and a sentence, not a
retyped explanation — a retyped explanation is one that drifts from the docs and
eventually contradicts them.

| Question | Answer lives at |
|---|---|
| Why did my trade fill at a worse price? | `/docs/fills` |
| Why was my trade rejected? | `/docs/fills` |
| How do I know the fills are real? | `/docs/fills` — with the command to measure it |
| How is my record proved? | `/docs/records` |
| How do I check somebody else's? | `/verify` |
| How is the season won? | `/docs/scoring` |
| Why is the leaderboard different from yesterday? | `/docs/scoring` — open positions are marked to market |
| What do I still have to trust you on? | `/trust` |
| Is something broken? | `/api/health` says what is degraded and what is off |

The pattern to notice: **a question that has no page is a missing page, not a
support burden.** If the same one arrives three times, it belongs in the docs.

---

## What would need building

None of this exists, and none of it should until there is a server to point it
at.

- **A webhook poster.** Season opened, entry window closing, season closed,
  results published, and a new leader on the board. This is the retention loop —
  the leaderboard channel is worthless if somebody has to go and look.
- **Configuration by absence.** Follow the coach: unset the webhook URL and
  nothing happens, no errors, no half-feature. Nothing else changes.
- **Rate limiting on it.** A new leader posted on every reshuffle would make the
  channel unreadable within an hour. The interesting event is a change at the
  top that survives a few minutes, not every tick.
- **Never post a trader's name without their record.** A leaderboard post with a
  number and no link is the same unverifiable brag the whole product exists to
  replace.

A bot that can read messages is a different thing with a different risk profile
and is not needed for any of the above. A webhook can only post.

---

## What Discord is not

Not the announcement channel of record. Anything that matters — a season
opening, a result, a void — is on chain and on the site first, because a message
in a chat room can be edited or deleted and the point of this project is records
that cannot.
