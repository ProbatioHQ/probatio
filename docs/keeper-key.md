# The keeper key

The keeper signs every commitment of every trade. It is the only key in the
system that signs continuously, which makes it the one most likely to be
stolen — and the design assumes it will be.

## What it can and cannot do

The program restricts it, and the restriction is real rather than a convention.

**Can:** append a batch to any trader's record in a season it is the keeper of.

**Cannot:** change a season's rules, take an entry, move a lamport out of the
vault, publish results, or rewrite anything already committed. Those need the
authority, which is a separate key that signs a handful of times per season and
is not kept on the server.

## The damage a stolen keeper can do

Not theft. Corruption.

An attacker with the keeper key can append a batch that corresponds to no real
trades. Because the accumulator is a hash chain, that value can never be
removed — not by them, not by us, not by anybody. Every honest trade committed
afterwards folds into a poisoned chain, so the trader's record stops verifying
against their trades permanently.

There is no repair. The season would have to be voided, which the published
policy already covers: an irreproducible trade is one of its conditions, and
this produces them by the thousand.

So the key is protected on the assumption that losing it costs a season, and
detection matters more than prevention.

## Detection

`auditRecords` walks every trader the keeper has committed for and compares the
chain against the accumulator our own last confirmed commit predicted. Anything
else means somebody signed with this key.

The conclusion is certain rather than probable. Only the keeper key can write
there, and a hash chain cannot be made to agree by accident.

This is deliberately separate from the keeper's own reconcile step, which
notices a foreign write **only on a trader it happens to have work in flight
for** — and a stolen key would be used on all the others. Incidental detection
is not detection.

Run it on a schedule, and on every start:

    npx tsx scripts/keeper-audit.mts

## Startup

`checkIdentity` reads the season from the chain before anything is signed and
refuses to run if this key is not the keeper it names.

That catches the quiet failure: a key rotated away after a compromise otherwise
keeps trying, fails every transaction, and looks like an RPC problem while the
season runs out. If the check fails because the key was rotated deliberately,
**the right response is to stay stopped**, not to find a way to keep signing.

## Handling

- Loaded from the environment. Never written to the repository, never in a
  backup — `scripts/backup.mts` lists it among the exclusions, so a restored
  database never carries it.
- One key per deployment. Sharing it across environments means a staging
  compromise is a production compromise.
- It needs SOL: every commit pays a fee, and the first commit for each trader
  pays rent for their record account. That funding is a separate concern and a
  separate key.

## Rotation

Possible since the security review — before it, a stolen keeper could not be
taken away at all, which made the hot/cold split worth nothing.

1. Stop the keeper.
2. Generate a new keypair, offline.
3. `set_keeper` with the authority key, naming the new keeper.
4. Confirm on chain that the season names the new key.
5. Fund it.
6. Start the keeper with the new key. `checkIdentity` confirms it at boot.
7. Run the audit. Rotation stops future writes; it does not tell you whether
   any already happened.

Rotation cannot undo a poisoned chain. If the audit finds a foreign commit, the
season is void under the published policy and rotating is the second step, not
the fix.

## What is not done

No multisig on the authority, no hardware key, no automatic alerting on an audit
failure. The authority key is a single keypair today, which is the subject of
the next step rather than this one.
