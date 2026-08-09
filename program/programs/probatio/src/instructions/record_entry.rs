use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::FREE_PLAY_ORDINAL;
use crate::error::ProbatioError;
use crate::state::{Entry, Season, SeasonStatus, ENTRY_SEED, VAULT_SEED};

#[derive(Accounts)]
pub struct RecordEntry<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(mut)]
    pub season: Account<'info, Season>,

    /// Deriving this from the season and the trader is what enforces one entry
    /// each — the chain refuses a second, so there is no counter to get wrong
    /// and no race to lose.
    #[account(
        init,
        payer = trader,
        space = 8 + Entry::INIT_SPACE,
        seeds = [ENTRY_SEED, season.key().as_ref(), trader.key().as_ref()],
        bump
    )]
    pub entry: Account<'info, Entry>,

    #[account(
        mut,
        seeds = [VAULT_SEED, season.key().as_ref()],
        bump = season.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Pay to enter a ranked season.
///
/// The fee is not revenue. It funds the pot and it makes running hundreds of
/// wallets expensive, which is half the sybil defence — the other half is the
/// trade minimums, which cost the farmer time rather than money.
pub fn handle_record_entry(ctx: Context<RecordEntry>) -> Result<()> {
    let clock = Clock::get()?;

    require!(
        ctx.accounts.season.ordinal != FREE_PLAY_ORDINAL,
        ProbatioError::FreePlayTakesNoEntries
    );
    require!(
        ctx.accounts.season.status == SeasonStatus::EntryOpen,
        ProbatioError::EntriesClosed
    );
    require!(
        clock.unix_timestamp <= ctx.accounts.season.entry_closes_at,
        ProbatioError::EntryWindowPassed
    );

    let cost = ctx.accounts.season.entry_cost;
    if cost > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.trader.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            cost,
        )?;
    }

    let entry = &mut ctx.accounts.entry;
    entry.season = ctx.accounts.season.key();
    entry.trader = ctx.accounts.trader.key();
    entry.paid = cost;
    entry.entered_at = clock.unix_timestamp;
    entry.bump = ctx.bumps.entry;

    let season = &mut ctx.accounts.season;
    season.entry_count = season.entry_count.saturating_add(1);
    season.pot_lamports = season.pot_lamports.saturating_add(cost);

    Ok(())
}
