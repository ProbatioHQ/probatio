use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::error::ProbatioError;
use crate::state::{Season, SeasonStatus, TraderRecord, RECORD_SEED};

#[derive(Accounts)]
pub struct CommitRoot<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        has_one = keeper @ ProbatioError::NotKeeper,
    )]
    pub season: Account<'info, Season>,

    /// CHECK: identifies whose record this is. Never signs and is never
    /// written to — the trader does not have to be online for their own
    /// trades to be committed.
    pub trader: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = keeper,
        space = 8 + TraderRecord::INIT_SPACE,
        seeds = [RECORD_SEED, season.key().as_ref(), trader.key().as_ref()],
        bump
    )]
    pub record: Account<'info, TraderRecord>,

    pub system_program: Program<'info, System>,
}

/// Append a batch of trades to a trader's record.
///
/// The batch itself is a merkle root computed off chain; what lands here is
/// that root folded into a hash chain. Anyone holding the batch data can
/// replay the chain and confirm it produces the value on chain, and nobody —
/// including the keeper — can change an earlier batch without changing every
/// value after it, all of which were already witnessed at the time.
///
/// The engine version goes into the hash rather than beside it, so a batch
/// stays checkable against the rules in force when it was written even if the
/// engine changes later in the season.
pub fn handle_commit_root(
    ctx: Context<CommitRoot>,
    batch_root: [u8; 32],
    leaves: u32,
    engine_version: u32,
) -> Result<()> {
    require!(leaves > 0, ProbatioError::EmptyCommit);

    // Nothing may be added to a finalized season. Allowing it would let a
    // record change after the results that depend on it were published.
    require!(
        ctx.accounts.season.status != SeasonStatus::Finalized,
        ProbatioError::SeasonFinalized
    );

    let clock = Clock::get()?;
    let record = &mut ctx.accounts.record;

    if record.commit_count == 0 {
        record.season = ctx.accounts.season.key();
        record.trader = ctx.accounts.trader.key();
        record.accumulator = [0u8; 32];
        record.first_committed_at = clock.unix_timestamp;
        record.bump = ctx.bumps.record;
    }

    record.accumulator = hashv(&[
        &record.accumulator,
        &batch_root,
        &leaves.to_le_bytes(),
        &engine_version.to_le_bytes(),
    ])
    .to_bytes();

    record.commit_count = record.commit_count.saturating_add(1);
    record.leaf_count = record.leaf_count.saturating_add(leaves as u64);
    record.last_committed_at = clock.unix_timestamp;

    Ok(())
}
