use anchor_lang::prelude::*;

use crate::error::ProbatioError;
use crate::state::{Season, SeasonStatus};

#[derive(Accounts)]
pub struct OpenEntries<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ProbatioError::NotAuthority,
    )]
    pub season: Account<'info, Season>,
}

/// Move a season from Pending into its entry window.
///
/// Separate from creation so the conditions can be set, inspected and argued
/// with before anyone is allowed to pay to enter them.
pub fn handle_open_entries(ctx: Context<OpenEntries>) -> Result<()> {
    let season = &mut ctx.accounts.season;
    require!(
        season.status == SeasonStatus::Pending,
        ProbatioError::InvalidStatusTransition
    );

    season.status = SeasonStatus::EntryOpen;
    Ok(())
}
