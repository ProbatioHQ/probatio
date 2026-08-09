pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("HZvgzZ6JvBtcUBYuLEkQQJ5hbwx1ZACss52LjFLd4UPX");

/// Probatio's on-chain half.
///
/// It holds two things a database cannot be trusted with: the conditions a
/// season ran under, and a commitment to every trade made inside it.
///
/// The trades themselves are not here. A hash chain per trader commits to all
/// of them in thirty-two bytes, which anyone holding the trade data can replay
/// and check. What that buys is the one property the whole project rests on —
/// a record cannot be edited after the fact, because every later value in the
/// chain was already witnessed on chain at the time.
#[program]
pub mod probatio {
    use super::*;

    /// Create a season and fix its conditions before anyone can enter it.
    pub fn init_season(ctx: Context<InitSeason>, params: SeasonParams) -> Result<()> {
        instructions::init_season::handle_init_season(ctx, params)
    }

    /// Begin accepting entries.
    pub fn open_entries(ctx: Context<OpenEntries>) -> Result<()> {
        instructions::open_entries::handle_open_entries(ctx)
    }

    /// Pay to enter a ranked season.
    pub fn record_entry(ctx: Context<RecordEntry>) -> Result<()> {
        instructions::record_entry::handle_record_entry(ctx)
    }

    /// Close the entry window and fix the cohort.
    pub fn start_trading(ctx: Context<StartTrading>) -> Result<()> {
        instructions::start_trading::handle_start_trading(ctx)
    }

    /// Append a batch of trades to a trader's record.
    pub fn commit_root(
        ctx: Context<CommitRoot>,
        batch_root: [u8; 32],
        leaves: u32,
        engine_version: u32,
    ) -> Result<()> {
        instructions::commit_root::handle_commit_root(ctx, batch_root, leaves, engine_version)
    }

    /// Publish the results and close the season permanently.
    pub fn finalize_season(ctx: Context<FinalizeSeason>, results_root: [u8; 32]) -> Result<()> {
        instructions::finalize_season::handle_finalize_season(ctx, results_root)
    }
}
