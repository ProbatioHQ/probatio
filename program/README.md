# program

The Anchor workspace for Probatio's on-chain program. Built in **step 13**.

It will hold three accounts — `Season`, `Entry` and `TraderRecord` — and four
instructions: `init_season`, `record_entry`, `commit_root` and
`finalize_season`.

Nothing here is deployed anywhere until step 51. Development and testing run
against `solana-test-validator` only.

## Not yet installed

The Anchor CLI is not on this machine. Install it before starting step 13:

```
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest
avm use latest
```

The Solana CLI (1.18.20) and Rust (1.91.0) are already present.
