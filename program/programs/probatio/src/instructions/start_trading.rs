use anchor_lang::prelude::*;

use crate::error::ProbatioError;
use crate::state::{Season, SeasonStatus};

#[derive(Accounts)]
pub struct StartTrading<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ProbatioError::NotAuthority,
    )]
    pub season: Account<'info, Season>,
}

/// Close the entry window and begin the season proper.
///
/// The cohort is fixed from here. A late entrant would be competing over a
/// shorter clock than everyone else, which makes the ranking incomparable.
pub fn handle_start_trading(ctx: Context<StartTrading>) -> Result<()> {
    let season = &mut ctx.accounts.season;
    require!(
        season.status == SeasonStatus::EntryOpen,
        ProbatioError::InvalidStatusTransition
    );

    season.status = SeasonStatus::Running;
    Ok(())
}
