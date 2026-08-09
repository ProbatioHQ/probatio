mod common;

use common::*;
use probatio::{ProofStep, ResultClaim};
use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;
use solana_sha256_hasher::hashv;
use solana_signer::Signer;

/// Taking a prize out of the vault.
///
/// These exist because a review found the vault had no exit at all: entry fees
/// went in and nothing ever came out, so a season would have taken real money
/// and locked it permanently. The instruction that fixes it moves lamports, so
/// it gets the most adversarial tests in the program.

const RESULT_LEAF_PREFIX: u8 = 0x02;
const NODE_PREFIX: u8 = 0x01;

fn leaf_hash(season_ordinal: i16, trader: &Pubkey, claim: &ResultClaim) -> [u8; 32] {
    let mut bytes = Vec::new();
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

fn node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hashv(&[&[NODE_PREFIX], left, right]).to_bytes()
}

fn claim_for(rank: u32, payout: u128) -> ResultClaim {
    ResultClaim {
        rank,
        starting_balance: 10_000_000_000,
        final_equity: 20_000_000_000,
        return_bps: 10_000,
        trade_count: 7,
        payout_lamports: payout,
    }
}

/// A finalized season with two entrants, the first paid and the second not.
struct Settled {
    harness: Harness,
    season: Pubkey,
    winner: Keypair,
    runner_up: Keypair,
    winner_claim: ResultClaim,
    runner_up_claim: ResultClaim,
    winner_proof: Vec<ProofStep>,
}

fn settle() -> Settled {
    let mut harness = Harness::new();
    harness.set_time(1_100);

    let season = harness.init_season(default_params(1, harness.keeper.pubkey())).unwrap();
    harness.open_entries(&season).unwrap();

    let winner = harness.fund(5_000_000_000);
    let runner_up = harness.fund(5_000_000_000);
    harness.record_entry(&season, &winner).unwrap();
    harness.record_entry(&season, &runner_up).unwrap();

    harness.after_entry_window();
    harness.start_trading(&season).unwrap();

    // The pot is what the two entries paid; first place takes it all.
    let winner_claim = claim_for(1, 100_000_000);
    let runner_up_claim = claim_for(2, 0);

    let left = leaf_hash(1, &winner.pubkey(), &winner_claim);
    let right = leaf_hash(1, &runner_up.pubkey(), &runner_up_claim);
    let root = node(&left, &right);

    harness.after_season_end();
    harness.finalize(&season, root, None).unwrap();

    Settled {
        harness,
        season,
        winner,
        runner_up,
        winner_claim,
        runner_up_claim,
        winner_proof: vec![ProofStep {
            sibling: right,
            sibling_on_left: false,
        }],
    }
}

#[test]
fn pays_a_winner_against_the_published_results() {
    let mut s = settle();
    let before = s.harness.balance(&s.winner.pubkey());

    s.harness
        .claim_prize(&s.season, &s.winner.pubkey(), s.winner_claim.clone(), s.winner_proof.clone())
        .unwrap();

    let after = s.harness.balance(&s.winner.pubkey());
    assert_eq!(after - before, 100_000_000);
}

#[test]
fn marks_the_entry_as_paid() {
    let mut s = settle();
    s.harness
        .claim_prize(&s.season, &s.winner.pubkey(), s.winner_claim.clone(), s.winner_proof.clone())
        .unwrap();

    let entry = s.harness.entry(&s.harness.entry_pda(&s.season, &s.winner.pubkey()));
    assert!(entry.claimed);
}

#[test]
fn refuses_a_second_claim() {
    // The entry is the record that a prize was paid, so a replayed proof finds
    // it already claimed rather than paying twice.
    let mut s = settle();
    s.harness
        .claim_prize(&s.season, &s.winner.pubkey(), s.winner_claim.clone(), s.winner_proof.clone())
        .unwrap();

    assert!(s
        .harness
        .claim_prize(&s.season, &s.winner.pubkey(), s.winner_claim.clone(), s.winner_proof.clone())
        .is_err());
}

#[test]
fn refuses_a_claim_for_more_than_the_results_say() {
    // The obvious attack: submit your own proof with a larger number in it.
    let mut s = settle();
    let mut greedy = s.winner_claim.clone();
    greedy.payout_lamports = 5_000_000_000;

    assert!(s
        .harness
        .claim_prize(&s.season, &s.winner.pubkey(), greedy, s.winner_proof.clone())
        .is_err());
}

#[test]
fn refuses_a_claim_with_somebody_elses_proof() {
    // The runner up presenting the winner's path. The trader is inside the
    // leaf, so the hash simply does not lead to the root.
    let mut s = settle();
    assert!(s
        .harness
        .claim_prize(&s.season, &s.runner_up.pubkey(), s.winner_claim.clone(), s.winner_proof.clone())
        .is_err());
}

#[test]
fn refuses_a_result_that_was_awarded_nothing() {
    let mut s = settle();
    let left = leaf_hash(1, &s.winner.pubkey(), &s.winner_claim);
    let proof = vec![ProofStep {
        sibling: left,
        sibling_on_left: true,
    }];

    assert!(s
        .harness
        .claim_prize(&s.season, &s.runner_up.pubkey(), s.runner_up_claim.clone(), proof)
        .is_err());
}

#[test]
fn refuses_a_claim_before_the_season_is_finalized() {
    // Nothing may leave the vault until the results are published, or the
    // authority could pay a friend and finalize around it afterwards.
    let mut harness = Harness::new();
    harness.set_time(1_100);
    let season = harness.init_season(default_params(1, harness.keeper.pubkey())).unwrap();
    harness.open_entries(&season).unwrap();

    let trader = harness.fund(5_000_000_000);
    harness.record_entry(&season, &trader).unwrap();

    let claim = claim_for(1, 50_000_000);
    let root = leaf_hash(1, &trader.pubkey(), &claim);

    assert!(harness
        .claim_prize(&season, &trader.pubkey(), claim, vec![])
        .is_err());
    let _ = root;
}

#[test]
fn refuses_a_proof_longer_than_any_real_tree() {
    let mut s = settle();
    let long: Vec<ProofStep> = (0..40)
        .map(|_| ProofStep {
            sibling: [7u8; 32],
            sibling_on_left: false,
        })
        .collect();

    assert!(s
        .harness
        .claim_prize(&s.season, &s.winner.pubkey(), s.winner_claim.clone(), long)
        .is_err());
}

#[test]
fn refuses_to_pay_more_than_the_vault_holds() {
    // A results root that promises more than was ever paid in. The vault is
    // the backstop: it cannot be drained below rent exemption, so a bad root
    // cannot take the account with it.
    let mut harness = Harness::new();
    harness.set_time(1_100);
    let season = harness.init_season(default_params(1, harness.keeper.pubkey())).unwrap();
    harness.open_entries(&season).unwrap();

    let trader = harness.fund(5_000_000_000);
    harness.record_entry(&season, &trader).unwrap();

    harness.after_entry_window();
    harness.start_trading(&season).unwrap();

    let claim = claim_for(1, 900_000_000_000);
    let root = leaf_hash(1, &trader.pubkey(), &claim);

    harness.after_season_end();
    harness.finalize(&season, root, None).unwrap();

    assert!(harness
        .claim_prize(&season, &trader.pubkey(), claim, vec![])
        .is_err());
}
