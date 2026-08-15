use anchor_lang::prelude::*;

use crate::state::{Config, CONFIG_SEED};

/// Set who may create seasons. Called once, when the program is first stood up.
#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

/// Records the admin. The `init` above makes it a one-time act: a second call
/// finds the account already there and fails, so the admin cannot be quietly
/// replaced by anyone who reaches this instruction.
pub fn handle_init_config(ctx: Context<InitConfig>, admin: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = admin;
    config.bump = ctx.bumps.config;
    Ok(())
}
