use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::error::ProbatioError;
use crate::state::{Entry, Season, SeasonStatus, VAULT_SEED};

/// Domain tags. A leaf and a node must never hash alike, or a pair of hashes
/// could be presented as a single result.
const RESULT_LEAF_PREFIX: u8 = 0x02;
const NODE_PREFIX: u8 = 0x01;

/// One step of a merkle path.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofStep {
    pub sibling: [u8; 32],
    /// True when the sibling sits on the left. Order matters to the hash.
    pub sibling_on_left: bool,
}

/// What a trader claims they finished with.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ResultClaim {
    pub rank: u32,
    pub starting_balance: u128,
    pub final_equity: u128,
    pub return_bps: i32,
    pub trade_count: u32,
    pub payout_lamports: u128,
}

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    /// Anyone may pay the transaction, but the money goes to the trader named
    /// in the entry and nowhere else.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        constraint = season.status == SeasonStatus::Finalized @ ProbatioError::SeasonNotFinalized,
    )]
    pub season: Account<'info, Season>,

    /// Proves the claimant entered this season, and records that they were
    /// paid. Its address derives from the season and the trader, so it cannot
    /// belong to a different season.
    #[account(
        mut,
        has_one = season @ ProbatioError::EntrySeasonMismatch,
        has_one = trader @ ProbatioError::EntryTraderMismatch,
    )]
    pub entry: Account<'info, Entry>,

    /// CHECK: paid, never signs. A winner should not have to be online to be
    /// paid, and requiring their signature would strand a prize behind a lost
    /// key.
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

/// Take a prize out of the vault.
///
/// This instruction exists because a review found the vault had no exit. Entry
/// fees went in and nothing ever came out, so a season would have taken real
/// money from real people and locked it permanently.
///
/// Nothing here is discretionary. The payout is whatever the results root
/// already committed to, proved by a merkle path the caller supplies, and the
/// root was published by `finalize_season` before any claim could be made. The
/// authority cannot decide who gets paid, cannot change an amount, and cannot
/// withhold — anyone at all can submit the proof on a winner's behalf, and the
/// lamports still go to the trader named in the entry.
pub fn handle_claim_prize(
    ctx: Context<ClaimPrize>,
    claim: ResultClaim,
    proof: Vec<ProofStep>,
) -> Result<()> {
    require!(!ctx.accounts.entry.claimed, ProbatioError::AlreadyClaimed);
    require!(claim.rank >= 1, ProbatioError::InvalidClaim);
    require!(claim.payout_lamports > 0, ProbatioError::NothingToClaim);

    // A path longer than this describes a tree with more leaves than a season
    // could ever hold, and bounding it keeps the loop below finite.
    require!(proof.len() <= 32, ProbatioError::ProofTooLong);

    let leaf = hash_result_leaf(
        ctx.accounts.season.ordinal,
        &claim,
        &ctx.accounts.trader.key(),
    );

    let mut current = leaf;
    for step in proof.iter() {
        current = if step.sibling_on_left {
            hashv(&[&[NODE_PREFIX], &step.sibling, &current]).to_bytes()
        } else {
            hashv(&[&[NODE_PREFIX], &current, &step.sibling]).to_bytes()
        };
    }

    require!(
        current == ctx.accounts.season.results_root,
        ProbatioError::ProofDoesNotMatchResults
    );

    let payout = u64::try_from(claim.payout_lamports).map_err(|_| ProbatioError::InvalidClaim)?;

    // The season's own budget, set to the pot at finalization. Total payouts
    // cannot exceed it, so a root that awarded more than was entered cannot be
    // paid past the pot — the last over-claim fails here rather than draining
    // the vault down to its rent.
    require!(
        ctx.accounts.season.awardable >= payout,
        ProbatioError::OverAllocated
    );

    // The vault must keep enough to stay rent exempt, or paying the last
    // winner would close the account and strand anything left in it.
    let rent = Rent::get()?.minimum_balance(0);
    let available = ctx
        .accounts
        .vault
        .lamports()
        .saturating_sub(rent);
    require!(available >= payout, ProbatioError::VaultUnderfunded);

    let season_key = ctx.accounts.season.key();
    let seeds: &[&[u8]] = &[VAULT_SEED, season_key.as_ref(), &[ctx.accounts.season.vault_bump]];

    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.trader.to_account_info(),
            },
            &[seeds],
        ),
        payout,
    )?;

    // Drawn down after the transfer, so the budget always reflects what has
    // actually left the vault.
    ctx.accounts.season.awardable = ctx.accounts.season.awardable.saturating_sub(payout);

    // Marked before returning, so a second proof for the same entry finds it
    // already paid. The entry account is the record of that, not a counter.
    ctx.accounts.entry.claimed = true;
    ctx.accounts.entry.claimed_at = Clock::get()?.unix_timestamp;

    Ok(())
}

/// The exact bytes a result commits to.
///
/// Fixed width and fixed order, matching the off-chain encoder byte for byte.
/// A mismatch here would not be a vulnerability so much as a lock nobody holds
/// the key to: every honest proof would fail.
fn hash_result_leaf(season_ordinal: i16, claim: &ResultClaim, trader: &Pubkey) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(1 + 78);
    bytes.push(RESULT_LEAF_PREFIX);
    bytes.extend_from_slice(&season_ordinal.to_be_bytes());
    bytes.extend_from_slice(&claim.rank.to_be_bytes());
    bytes.extend_from_slice(trader.as_ref());
    bytes.extend_from_slice(&claim.starting_balance.to_be_bytes());
    bytes.extend_from_slice(&claim.final_equity.to_be_bytes());
    bytes.extend_from_slice(&claim.return_bps.to_be_bytes());
    bytes.extend_from_slice(&claim.trade_count.to_be_bytes());
    bytes.extend_from_slice(&claim.payout_lamports.to_be_bytes());
    hashv(&[&bytes]).to_bytes()
}
