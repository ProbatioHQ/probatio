# Security review: the Anchor program

Reviewed before deployment. The program holds the prize vault and every
trader's committed record, so a bug here loses money that belongs to somebody
else.

Findings are listed worst first. Everything marked **fixed** has a test that
fails if the fix is removed.

---

## Critical

### 1. The vault had no exit — **fixed**

`record_entry` transferred entry fees into a vault PDA. No instruction ever
transferred anything out. There was no payout, no refund, no sweep.

A season would have taken 0.05 SOL from every entrant and locked it
permanently. Nothing in the remaining build plan added one either, so this
would have shipped.

Fixed by adding `claim_prize`, which pays against the results root that
`finalize_season` already publishes. Nothing about it is discretionary: the
amount is whatever the committed results say, proved by a merkle path the
caller supplies. The authority cannot choose who is paid, cannot change an
amount, and cannot withhold — anybody at all may submit the proof, and the
lamports go to the trader named in the entry regardless of who sent the
transaction. A winner does not need to be online, so a prize is not stranded
behind a lost key.

Nine tests, most of them adversarial: a forged amount, another trader's proof,
a replayed claim, a proof longer than any real tree, a claim before results
exist, and a root promising more than the vault holds.

### 2. A season could be finalized at any moment — **fixed**

`finalize_season` checked the status but never the clock. The authority could
finalize while a season was still running.

That undoes the published policy on its own. Finalization is terminal — nothing
can be committed afterwards and a finalized season can never be voided — so an
authority watching the leaderboard could have ended a season the instant the
standings suited them, permanently and beyond challenge.

Now requires `clock >= ends_at`.

---

## High

### 3. The entry window could be closed early — **fixed**

`start_trading` had no time check, so the authority could take entries and then
shut the door whenever they chose. That is a different season from the one
people paid to join. Now requires `clock >= entry_closes_at`.

### 4. A compromised keeper could not be replaced — **fixed**

The keeper is a hot key that signs continuously, and the comment in `state.rs`
says it is separated from the authority precisely so a compromise cannot also
rewrite the season's rules. But there was no way to take the key away, so the
separation bought nothing: a stolen keeper could commit garbage for the rest of
the season.

Added `set_keeper`, gated on the authority and refused after finalization. It
cannot rewrite anything already committed — the hash chain sees to that.

### 5. Entrants would have paid the vault's rent — **fixed**

Found by writing the test that pays a winner: the proof verified and the
transfer failed. A system account must keep a rent-exempt balance, so paying
prizes out of entry fees alone leaves the last winner short by exactly that
amount. The shortfall would have come out of somebody's prize.

The authority now funds the vault's rent at `init_season`, so every lamport an
entrant pays is payable back out.

---

## Verified correct

Things that were checked and found sound, recorded so the next reviewer does
not have to rediscover them.

- **One entry per trader** is enforced by PDA derivation rather than a counter,
  so there is no race to lose.
- **`init_if_needed` on the trader record** is safe here: identity fields are
  written only when `commit_count == 0`, so a second call cannot reset an
  accumulator.
- **The hash chain** cannot be rewritten by the keeper. Changing any earlier
  batch changes every value after it, and those were witnessed on chain at the
  time.
- **`finalize_season` refuses a zero root**, which keeps "not yet finalized"
  distinct from every real outcome — including the empty-season and void-season
  roots, both of which are non-zero by construction.
- **The result leaf hashes identically on both sides.** A cross-language vector
  test pins it. A mismatch would not be a vulnerability so much as a lock nobody
  holds the key to: every honest proof would fail and the vault would stay shut.
- **Merkle nodes and leaves use distinct domain tags**, so a pair of hashes
  cannot be passed off as a single result.

---

## Known and accepted

Not fixed, and each is a decision rather than an oversight.

- **`commit_root` does not require the trader to have an entry.** The keeper can
  commit a record for any address in a ranked season. It costs the keeper rent
  and proves nothing to anybody, and requiring the entry would mean an extra
  account on the hottest instruction in the program. The consequence: a trader
  record is not by itself evidence of entry.
- **`saturating_add` on `entry_count` and `pot_lamports`.** Both are unreachable
  in practice — `u32` entrants and `u64` lamports. Saturating hides an error
  rather than failing on it, which is the wrong default, but changing it means
  an error path that cannot be reached and therefore cannot be tested.
- **Commits are allowed after `ends_at`, up until finalization.** Deliberate:
  the keeper batches, so trades made in the last minutes of a season are
  committed after it closes. The void policy requires every trade committed
  before finalization, which is the real gate.
- **~~No refund instruction for a void season.~~** *Closed.* The void policy
  promised full refunds and the program had no on-chain path to pay one, which
  meant no season could honestly take money at all. `void_season` and
  `refund_entry` close it, with the exclusivity between void and finalized
  enforced in both directions so an entry can never be paid twice. Ten tests
  cover it, including that a rejected second refund moves no lamports.

---

## Not covered by this review

This is a careful read by the person who wrote it, not an independent audit. It
has not been reviewed by anyone else, and no fuzzing or formal analysis has been
done. The program has never been deployed to mainnet.

62 tests run against the program under litesvm.
