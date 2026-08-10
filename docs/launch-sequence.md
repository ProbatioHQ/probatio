# Launch sequence

The order matters more than the schedule. Several things here cost nothing to
do in the right order and cannot be undone in the wrong one: a burned upgrade
authority is permanent, a group owner says yes once, and a season that takes
money before the program can refund it makes a published promise unkeepable.

This gathers the ordering constraints already established across the build into
one sequence, and names the gap that would otherwise be discovered at the end.

---

## The gap in the plan

**The keeper has no concrete chain gateway, and is never started in
production.**

`ChainGateway` is an interface. The only implementations are test doubles. The
keeper is not wired into the app, so nothing runs it. Today, and on the day the
program is deployed, the consequence is the same:

- no trade is ever committed on chain
- `/verify` reports that nothing is committed, for everybody
- every profile card reads "not yet committed on chain"
- the central claim of the product is unfulfilled

The plan goes site → docs → repo → GitHub → CI → deploy program → deploy app →
"season 1 opens, first real committed records". Nothing in that list builds the
thing that produces a committed record.

**This has to be built and proved on devnet before anything else in this
sequence.** It is the gate. Everything downstream — the trust page, the verify
page, the shareable card, the entire argument — is decoration until a record
can be committed and independently checked.

---

## Hard constraints

Each of these was decided earlier for a reason, and each is expensive to
violate.

| Constraint | Why | Cost of getting it wrong |
|---|---|---|
| Back up `probatio-keypair.json` offline **before deploying** | It is the only key that can deploy to that program address | Unrecoverable. The address is lost permanently |
| Burn the upgrade authority **before any season takes money** | Records are not unfakeable while it exists | The claim on the front page is false |
| Burn it **after the refund instruction exists** | The void policy promises full refunds | A published promise becomes permanently unkeepable |
| Seed season must exist **before any outreach** | A group owner says yes once | The contact is burned permanently |
| Fee wallet must cover a **whole season** before it opens | Running out mid-season leaves trades uncommitted | The season is void under the published policy |
| Keeper identity checked **at every start** | A rotated key fails silently and looks like an RPC fault | A season runs with nothing being committed |

The two burn constraints resolve together: **season 0 is free, so it can run
before the burn.** Season 1 either waits for the refund instruction and the
burn, or it runs free as well.

---

## The sequence

### 0. The gate — before anything else

1. Back up the program keypair offline, twice, in different places.
2. Build the concrete `ChainGateway` against Solana.
3. Wire the keeper to run — a loop, not a request path.
4. Deploy the program to **devnet**.
5. Trade, let the keeper commit, then open `/verify` and check the record
   against devnet **from a browser, on an RPC not chosen by the app**.

Step 5 is the whole product. If it does not pass, nothing after this matters and
the sequence stops here.

### 1. Public surface (plan steps 45–48)

6. Site and docs. The docs are the marketing: fills, commitments, scoring, and
   the measured 0 bps simulation accuracy.
7. Discord — it is the only support channel, so it exists before there are
   users to support.
8. Repo hygiene: README, licence, clean history, tests green.

### 2. Ship (49–52)

9. Push to the new GitHub account.
10. CI running the full suite plus the program tests.
11. Deploy the program to mainnet.
12. Record the deployment: `verify-deployment.mts` writes down the authority and
    the bytecode hash, so a later change is visible as a change.
13. Deploy the app. Fund the keeper. Confirm `checkIdentity` passes and
    `treasury.mts` reports enough to finish a season.

### 3. Season 0 — free, sponsored (L42)

14. Open season 0 and send the prize to the season vault on chain. The vault
    pays what it holds, not what the database says.
15. Confirm the loop end to end on mainnet: trade, commit, verify, card.
16. **Only now** begin the first fifty. The board is not empty, the verify page
    works, and there is something to say yes to.

### 4. Season 1

17. Requires the refund instruction shipped **and** the upgrade authority
    burned. If either is missing, season 1 runs free like season 0.
18. Never charge for entry and then discover a refund cannot be paid.

---

## Who may compete

The operator can enter a season. They cannot fake a result — the engine and the
on-chain commitment prevent that as much for them as for anybody — but they can
sponsor a prize, and being paid a prize they put up is not a competition.

**Rule: the operator may enter and appear on the board, and takes no prize in a
season they sponsored.** Their share rolls to the next place down. Written here
so it is decided before it is worth arguing about.

---

## What stops a launch

Named in advance, for the same reason the void conditions were.

- `/verify` does not verify against a real chain
- The keeper cannot commit, or commits something the audit does not recognise
- The fee wallet cannot cover a whole season
- A season would take money while the program cannot refund it
- The published ruleset hash does not match what the program recorded

Any one of these and the sequence stops. None of them is a judgement call, and
each has a command that answers it.

---

## What is deliberately not first

**Marketing before the loop works.** Both previous projects launched on
narrative and decayed to nothing, because narrative decays and a working loop
does not. The order here is the opposite one: prove the record can be checked,
seed a board worth being on, then talk.
