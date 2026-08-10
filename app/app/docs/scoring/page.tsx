export const metadata = {
  title: 'Scoring — Probatio',
  description:
    'Highest return wins. How ties are broken, why there is no minimum trade count, and why risk-adjusted scoring was removed.',
};

export default function ScoringDoc() {
  return (
    <>
      <h1>Scoring</h1>

      <p>
        <strong>Highest return wins.</strong> That is the whole formula. Everyone starts a season
        with the same balance, under the same fill conditions, and finishes with whatever they
        finished with.
      </p>

      <h2>No minimum number of trades</h2>

      <p>
        One trade can win a season. That is deliberate, not an oversight. A trader who is right
        once and sizes it properly has done something, and a rule requiring thirty trades would
        mostly select for people with time rather than for people who are right.
      </p>

      <p>Getting lucky is allowed. Being lucky twice is a different thing, which is what seasons are for.</p>

      <h2>Why not risk-adjusted</h2>

      <p>
        The original design scored return divided by maximum drawdown, which is the sort of
        formula that sounds serious. With no minimum trade count it is worthless: a single trade
        produces almost no drawdown, so the score approaches infinity and the winner is whoever
        traded least. The clever formula would have crowned the most cautious person in the room.
      </p>

      <p>It was removed rather than patched, because every patch reintroduced a minimum.</p>

      <h2>Ties</h2>

      <p>
        Published in advance and hashed into the season&apos;s rules, because with a prize on the
        table a tie is the most contestable moment there is — and the wrong time to decide is
        after seeing who it affects.
      </p>

      <ol>
        <li>Higher return.</li>
        <li>
          Then the larger actual gain. Two traders can round to the same basis point while one
          genuinely finished ahead, and a tie-break should not be spent on a rounding artefact.
        </li>
        <li>Then whoever entered the season first.</li>
        <li>
          Then the lower wallet address. This one is arbitrary and it is meant to be — it exists
          so the order is total, because a ranking that reports two firsts cannot pay one.
        </li>
      </ol>

      <p>
        Places are always distinct. Nobody shares a rank.
      </p>

      <h2>Open positions at the close</h2>

      <p>
        Anything still held is valued at the market price. A token whose price cannot be read is
        held at what it cost rather than marked to nothing — wiping a position because a network
        call failed would invent the number that decides who gets paid.
      </p>

      <h2>The rules cannot move</h2>

      <p>
        A season&apos;s entire ruleset — the scoring, the tie-breaks, the payout shape, the entry
        cost, the simulation conditions, and the conditions under which the season does not count
        — is encoded and hashed before anybody enters, and that hash is recorded on chain with
        the season.
      </p>

      <p>
        So the rules can be read, hashed independently, and compared against what the program
        recorded. Rules that could be adjusted after a result are not rules.
      </p>

      <h2>When a season does not count</h2>

      <p>
        A season is void only under conditions published in advance and measured, never judged:
        an extended price feed outage, a chain halt, any trade left uncommitted, any trade that
        will not rebuild from its own inputs, or the engine changing mid-season. Everything else
        stands — an unpopular winner, a lucky winner, a one-trade winner and a single entrant are
        outcomes, not faults.
      </p>

      <p>
        A void season refunds every entrant in full and takes no cut. And once results are on
        chain a season can never be voided, however unpopular the winner — otherwise every
        condition above becomes a way to cancel a result somebody dislikes after seeing it.
      </p>
    </>
  );
}
