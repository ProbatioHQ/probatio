use anchor_lang::prelude::*;

use crate::error::ProbatioError;
use crate::state::{Season, SeasonStatus};

#[derive(Accounts)]
pub struct VoidSeason<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ProbatioError::NotAuthority,
    )]
    pub season: Account<'info, Season>,
}

/// Declare a season void, so its entry fees can be given back.
///
/// The published void policy says a season that ran under broken conditions
/// does not count and everyone is refunded in full. Until this existed that was
/// a promise the program could not keep: money could go into the vault and the
/// only way out was a prize proved against results that, by definition, a void
/// season never publishes.
///
/// Deliberately not automatic. The policy's triggers are measured off chain —
/// feed downtime, fill drift, a keeper that stopped committing — and a program
/// cannot see any of them. What the chain enforces is the consequence: once
/// void, the season can never be finalized, so this is not a lever for
/// discarding a result somebody dislikes after seeing it. It is a one-way door
/// out of paying prizes and into paying everybody back.
///
/// Terminal, and refuses a season that already published results. A finalized
/// season has winners with claimable proofs, and voiding it afterwards would
/// mean the vault owed both the prizes and the refunds.
pub fn handle_void_season(ctx: Context<VoidSeason>) -> Result<()> {
    let season = &mut ctx.accounts.season;

    require!(
        season.status != SeasonStatus::Finalized,
        ProbatioError::SeasonFinalized
    );
    require!(
        season.status != SeasonStatus::Voided,
        ProbatioError::SeasonAlreadyVoided
    );

    season.status = SeasonStatus::Voided;
    season.voided_at = Clock::get()?.unix_timestamp;

    Ok(())
}
