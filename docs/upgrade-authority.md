# The upgrade authority

The plan's note on this step reads: *"multisig or public burn plan; 'unfakeable'
is false without it."* That is exactly right, and it was false on the front page
until this step.

## The problem

The program treats records as append-only. Nothing can rewrite a committed
trade — not the server, not the keeper key, not the authority. That is enforced
by the deployed code.

But every guarantee a program makes is a guarantee about the code *currently
deployed*. A Solana program with an upgrade authority can be replaced by
whoever holds that key, including with a version that rewrites the records the
old one refused to touch.

So "your record cannot be edited" was not true. What is true:

> Your record cannot be edited without replacing the program on chain, which is
> a public, permanent, timestamped act.

That is weaker. It is also checkable, which the stronger claim was not.

## What was done

The front page now makes the true claim and links to `/trust`, which lists this
and everything else a reader still has to take on faith.

`scripts/verify-deployment.mts` reports who holds the authority, when the
bytecode was last written, and its hash — so a reader checks rather than
believes. Validated against a real deployed mainnet program, not only against
fixtures.

## Why it is not burned yet

Burning is permanent. No bug fix afterwards, ever.

A review of this program found five issues, one of which meant entry fees would
have gone into the vault with no instruction able to pay anybody. Burning a
program in that state would have made the bug permanent along with everything
else.

More specifically: **the void policy promises every entrant a full refund if a
season does not count, and the program has no instruction that can pay one.**
Burning today would make a published promise permanently impossible to keep.

## The commitment

The upgrade authority is burned **before any season takes money, and after the
refund instruction exists**. If both cannot be true, the season runs free rather
than ranked.

The ordering is checkable by anyone:

- the burn is visible on chain (`verify-deployment.mts`)
- the refund instruction is visible in the program
- whether a season takes money is visible from its entry cost

## Why not a multisig

A multisig replaces one key with several, which helps only if the holders are
independent people. This project is being built by one person who intends to
stay anonymous, so the co-signers would be either the same person with more
keypairs — which is theatre — or people whose identities would undo the reason
for the anonymity.

Burning is the honest version of the same intent, and it is strictly stronger:
a multisig can still upgrade, a burned authority cannot.

## What burning does not prove

It fixes the program forever without saying *which* program was fixed. Verifying
that the deployed bytecode matches published source needs a reproducible build,
and Solana builds are not reproducible by default — two honest builds of the
same source can differ.

`verify-deployment.mts` hashes both sides and reports the comparison, but a
mismatch today is not evidence of anything. Until the build is reproducible, the
bytecode hash is a record to compare against later, not a proof.
