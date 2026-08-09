use anchor_lang::prelude::*;

use crate::error::ProbatioError;
use crate::state::{Season, SeasonStatus};

#[derive(Accounts)]
pub struct FinalizeSeason<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ProbatioError::NotAuthority,
    )]
    pub season: Account<'info, Season>,
}

/// Publish the results and close the season permanently.
///
/// Only a merkle root of the rankings goes on chain, not the rankings
/// themselves — a season with thousands of entrants would cost a fortune in
/// rent to store outright, and a root lets any trader prove their own placing
/// without the chain carrying everyone else's.
///
/// Terminal by design. After this no commitment can be added, so the records
/// the results were computed from are frozen as they stood.
pub fn handle_finalize_season(ctx: Context<FinalizeSeason>, results_root: [u8; 32]) -> Result<()> {
    require!(results_root != [0u8; 32], ProbatioError::EmptyResultsRoot);

    let season = &mut ctx.accounts.season;
    require!(
        season.status != SeasonStatus::Finalized,
        ProbatioError::SeasonFinalized
    );
    require!(
        season.status == SeasonStatus::Running || season.status == SeasonStatus::Closed,
        ProbatioError::InvalidStatusTransition
    );

    // The season has to be over. Without this the authority could finalize the
    // moment the standings suited them — and since a finalized season can never
    // be voided or added to, that would be the end of the argument. Found by
    // review: the published policy leaned on finalization being the terminal
    // act, and nothing on chain required it to be the last one.
    let now = Clock::get()?.unix_timestamp;
    require!(now >= season.ends_at, ProbatioError::SeasonNotOver);

    season.results_root = results_root;
    season.finalized_at = now;
    season.status = SeasonStatus::Finalized;

    Ok(())
}
