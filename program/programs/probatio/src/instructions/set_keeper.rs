use anchor_lang::prelude::*;

use crate::error::ProbatioError;
use crate::state::{Season, SeasonStatus};

#[derive(Accounts)]
pub struct SetKeeper<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ProbatioError::NotAuthority,
    )]
    pub season: Account<'info, Season>,
}

/// Replace the keeper.
///
/// The keeper is a hot key that signs continuously, and the whole reason it is
/// separate from the authority is that it is the one more likely to be lost.
/// Without this instruction that separation bought nothing: a compromised
/// keeper could commit garbage for the rest of the season and there was no way
/// to take the key away. Added after a review pointed that out.
///
/// It cannot rewrite anything already committed. The hash chain sees to that —
/// a new keeper inherits the accumulator exactly as the old one left it.
pub fn handle_set_keeper(ctx: Context<SetKeeper>, keeper: Pubkey) -> Result<()> {
    let season = &mut ctx.accounts.season;
    require!(
        season.status != SeasonStatus::Finalized,
        ProbatioError::SeasonFinalized
    );

    season.keeper = keeper;
    Ok(())
}
