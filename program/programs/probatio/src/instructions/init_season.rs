use anchor_lang::prelude::*;

use crate::constants::MAX_BPS;
use crate::error::ProbatioError;
use crate::state::{Season, SeasonStatus, SEASON_SEED, VAULT_SEED};

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
    pub min_trades: u16,
    pub min_distinct_tokens: u16,
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
        seeds = [VAULT_SEED, season.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

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
    season.min_trades = params.min_trades;
    season.min_distinct_tokens = params.min_distinct_tokens;
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

    season.bump = ctx.bumps.season;
    season.vault_bump = ctx.bumps.vault;

    Ok(())
}
