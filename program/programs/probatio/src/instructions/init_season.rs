use anchor_lang::prelude::*;

use crate::constants::MAX_BPS;
use crate::error::ProbatioError;
use crate::state::{Config, Season, SeasonStatus, CONFIG_SEED, SEASON_SEED, VAULT_SEED};

/// Everything that could change a result, fixed before anyone trades.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SeasonParams {
    pub ordinal: i16,
    pub keeper: Pubkey,
    pub starts_at: i64,
    pub ends_at: i64,
    pub entry_closes_at: i64,
    pub starting_balance: u64,
    pub entry_cost: u64,
    pub house_bps: u16,
    pub house_threshold: u64,
    pub latency_ms: u32,
    pub slippage_bps: u16,
    pub max_price_impact_bps: u16,
    pub engine_version: u32,
    pub scoring_formula_hash: [u8; 32],
}

#[derive(Accounts)]
#[instruction(params: SeasonParams)]
pub struct InitSeason<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Season::INIT_SPACE,
        seeds = [SEASON_SEED, &params.ordinal.to_le_bytes()],
        bump
    )]
    pub season: Account<'info, Season>,

    /// Holds entry fees until the season pays out. A bare system account, so
    /// the program owns no token logic it does not need.
    #[account(
        mut,
        seeds = [VAULT_SEED, season.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    /// Only the admin may create a season. Without this, an ordinal-seeded
    /// season was open to anyone; now the authority creating it has to be the
    /// one admin the program was set up with.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.admin == authority.key() @ ProbatioError::NotAuthority,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub fn handle_init_season(ctx: Context<InitSeason>, params: SeasonParams) -> Result<()> {
    require!(params.ends_at > params.starts_at, ProbatioError::InvalidSchedule);
    require!(
        params.entry_closes_at >= params.starts_at && params.entry_closes_at <= params.ends_at,
        ProbatioError::InvalidSchedule
    );
    require!(params.house_bps <= MAX_BPS, ProbatioError::InvalidBasisPoints);
    require!(params.slippage_bps <= MAX_BPS, ProbatioError::InvalidBasisPoints);

    let season = &mut ctx.accounts.season;
    season.ordinal = params.ordinal;
    season.authority = ctx.accounts.authority.key();
    season.keeper = params.keeper;
    season.status = SeasonStatus::Pending;

    season.starts_at = params.starts_at;
    season.ends_at = params.ends_at;
    season.entry_closes_at = params.entry_closes_at;

    season.starting_balance = params.starting_balance;
    season.entry_cost = params.entry_cost;
    season.house_bps = params.house_bps;
    season.house_threshold = params.house_threshold;

    season.latency_ms = params.latency_ms;
    season.slippage_bps = params.slippage_bps;
    season.max_price_impact_bps = params.max_price_impact_bps;
    season.engine_version = params.engine_version;
    season.scoring_formula_hash = params.scoring_formula_hash;

    season.entry_count = 0;
    season.pot_lamports = 0;
    season.results_root = [0u8; 32];
    season.finalized_at = 0;
    season.voided_at = 0;
    season.awardable = 0;

    season.bump = ctx.bumps.season;
    season.vault_bump = ctx.bumps.vault;

    // The authority funds the vault's rent, not the entrants.
    //
    // A system account has to keep a rent-exempt balance or it disappears, so
    // paying prizes out of the entry fees alone would leave the last winner
    // short by exactly that much — the pot would be unpayable in full, and the
    // shortfall would come out of somebody's prize. Found by writing the test
    // that pays a winner: the proof verified and the transfer failed.
    let rent = Rent::get()?.minimum_balance(0);
    let held = ctx.accounts.vault.lamports();
    if held < rent {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            rent - held,
        )?;
    }

    Ok(())
}
