use anchor_lang::prelude::*;

use crate::error::ProbatioError;
use crate::state::{Entry, Season, SeasonStatus, VAULT_SEED};

#[derive(Accounts)]
pub struct RefundEntry<'info> {
    /// Anyone may pay the transaction. The lamports go to the trader named in
    /// the entry regardless of who submits it, so a refund does not depend on
    /// the trader still having gas — or on us being willing to send it.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        constraint = season.status == SeasonStatus::Voided @ ProbatioError::SeasonNotVoided,
    )]
    pub season: Account<'info, Season>,

    #[account(
        mut,
        has_one = season @ ProbatioError::EntrySeasonMismatch,
        has_one = trader @ ProbatioError::EntryTraderMismatch,
    )]
    pub entry: Account<'info, Entry>,

    /// CHECK: paid, never signs. Named by the entry, which was written when
    /// they paid in — so this cannot be pointed at anybody else.
    #[account(mut)]
    pub trader: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, season.key().as_ref()],
        bump = season.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Give an entry fee back after a season is voided.
///
/// The amount is not a parameter. It is `entry.paid`, written by the chain when
/// the trader paid in, so there is nothing here for anyone to decide — not the
/// authority, not the payer, not the trader. A refund is exactly what was paid,
/// and it can only happen for a season already marked void.
///
/// The same `claimed` flag guards this as guards a prize, and that is on
/// purpose rather than reuse for its own sake: a season is either finalized or
/// void, never both, so an entry has at most one way to be paid out. One flag
/// means there is no state in which a trader could take a prize and a refund.
pub fn handle_refund_entry(ctx: Context<RefundEntry>) -> Result<()> {
    require!(!ctx.accounts.entry.claimed, ProbatioError::AlreadyClaimed);

    let refund = ctx.accounts.entry.paid;
    // A free season takes nothing, so there is nothing to give back. Rejected
    // rather than passed through as a no-op, so a caller cannot burn fees
    // discovering that.
    require!(refund > 0, ProbatioError::NothingToRefund);

    // The vault has to stay rent exempt. Paying the last refund down to zero
    // would close the account, and anything that arrived afterwards would be
    // stranded in an account nobody can sign for.
    let rent = Rent::get()?.minimum_balance(0);
    let available = ctx.accounts.vault.lamports().saturating_sub(rent);
    require!(available >= refund, ProbatioError::VaultUnderfunded);

    let season_key = ctx.accounts.season.key();
    let seeds: &[&[u8]] = &[
        VAULT_SEED,
        season_key.as_ref(),
        &[ctx.accounts.season.vault_bump],
    ];

    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.trader.to_account_info(),
            },
            &[seeds],
        ),
        refund,
    )?;

    // Marked before returning, so a second attempt finds it already paid.
    ctx.accounts.entry.claimed = true;
    ctx.accounts.entry.claimed_at = Clock::get()?.unix_timestamp;

    // The pot shrinks by what left it, so the account keeps describing what the
    // vault actually holds rather than what it once held.
    let season = &mut ctx.accounts.season;
    season.pot_lamports = season.pot_lamports.saturating_sub(refund);

    Ok(())
}
