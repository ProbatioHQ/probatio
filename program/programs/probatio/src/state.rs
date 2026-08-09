use anchor_lang::prelude::*;

/// Where a season is in its life.
///
/// The order matters: a season only moves forward, and `Finalized` is
/// terminal. Nothing may be committed to a finalized season, or a record could
/// be altered after the results that depend on it were published.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SeasonStatus {
    /// Created, not yet accepting entries.
    Pending,
    /// Inside the entry window.
    EntryOpen,
    /// Entry closed, trading underway.
    Running,
    /// Trading over, results not yet published.
    Closed,
    /// Results published. Terminal.
    Finalized,
}

/// A season, and every condition that could change a result.
///
/// The conditions live on chain rather than only in a database because the
/// claim being made is not merely "these trades happened" but "these trades
/// happened under these rules". Without the rules recorded, anyone can say the
/// latency or the fee schedule moved partway through and there is no answer.
#[account]
#[derive(InitSpace)]
pub struct Season {
    /// -1 is free play: unranked, no entry cost, no end.
    pub ordinal: i16,
    /// May create and finalize the season.
    pub authority: Pubkey,
    /// May append trade commitments. A hot key, deliberately separated from
    /// the authority so a compromise cannot also rewrite the season's rules.
    pub keeper: Pubkey,
    pub status: SeasonStatus,

    pub starts_at: i64,
    pub ends_at: i64,
    pub entry_closes_at: i64,

    pub starting_balance: u64,
    pub entry_cost: u64,

    pub house_bps: u16,
    pub house_threshold: u64,

    // The simulation conditions. These are what make a result reproducible.
    pub latency_ms: u32,
    pub slippage_bps: u16,
    pub max_price_impact_bps: u16,
    pub engine_version: u32,
    pub scoring_formula_hash: [u8; 32],

    pub entry_count: u32,
    pub pot_lamports: u64,

    /// Merkle root of the final rankings. Zero until finalized.
    pub results_root: [u8; 32],
    pub finalized_at: i64,

    pub bump: u8,
    pub vault_bump: u8,
}

/// One trader's registration in one season.
///
/// Its address derives from the season and the trader, so the chain enforces
/// one entry each — there is no counter to get wrong and no race to lose.
#[account]
#[derive(InitSpace)]
pub struct Entry {
    pub season: Pubkey,
    pub trader: Pubkey,
    pub paid: u64,
    pub entered_at: i64,
    pub bump: u8,
}

/// A trader's committed trade history for one season.
///
/// `accumulator` is a hash chain, not a list. Each commit folds the new batch
/// into it:
///
/// ```text
/// accumulator = sha256(accumulator || batch_root || leaves || engine_version)
/// ```
///
/// That commits to every batch ever made, in order, in thirty-two bytes. A
/// list would grow without bound and cost rent forever; a single latest root
/// would let history be quietly replaced. The chain can only be extended,
/// because changing any earlier batch changes every value after it, and those
/// were already witnessed on chain at the time.
///
/// The engine version is folded in rather than stored separately, so a batch
/// stays checkable against the rules that were in force when it was written —
/// even if the engine changed mid-season.
#[account]
#[derive(InitSpace)]
pub struct TraderRecord {
    pub season: Pubkey,
    pub trader: Pubkey,
    pub accumulator: [u8; 32],
    pub commit_count: u32,
    pub leaf_count: u64,
    pub first_committed_at: i64,
    pub last_committed_at: i64,
    pub bump: u8,
}

pub const SEASON_SEED: &[u8] = b"season";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ENTRY_SEED: &[u8] = b"entry";
pub const RECORD_SEED: &[u8] = b"record";
