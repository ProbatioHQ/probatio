mod common;

use common::*;
use probatio::SeasonStatus;
use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Giving entry fees back.
///
/// These exist for the same reason the claim tests do. Until `refund_entry` the
/// published void policy promised full refunds and the program had no way to
/// pay one, which meant no season could honestly take money at all. Anything
/// that moves lamports gets the adversarial treatment.

/// A season with two paid entrants, mid-flight.
fn entered() -> (Harness, Pubkey, Keypair, Keypair) {
    let mut harness = Harness::new();
    harness.set_time(1_100);

    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();

    let first = harness.fund(5_000_000_000);
    let second = harness.fund(5_000_000_000);
    harness.record_entry(&season, &first).unwrap();
    harness.record_entry(&season, &second).unwrap();

    (harness, season, first, second)
}

#[test]
fn refunds_exactly_what_was_paid() {
    let (mut harness, season, first, _second) = entered();

    let paid = harness.entry(&harness.entry_pda(&season, &first.pubkey())).paid;
    assert!(paid > 0, "the fixture must actually charge for entry");

    let before = harness.balance(&first.pubkey());

    harness.void_season(&season, None).unwrap();
    harness.refund_entry(&season, &first.pubkey()).unwrap();

    assert_eq!(
        harness.balance(&first.pubkey()) - before,
        paid,
        "a refund is what was paid, not a number anybody chose"
    );
}

#[test]
fn a_season_must_be_voided_before_anything_is_refunded() {
    let (mut harness, season, first, _second) = entered();

    // Running, not void. The fee is not the trader's to take back yet.
    assert!(harness.refund_entry(&season, &first.pubkey()).is_err());
}

#[test]
fn an_entry_cannot_be_refunded_twice() {
    let (mut harness, season, first, _second) = entered();

    harness.void_season(&season, None).unwrap();
    harness.refund_entry(&season, &first.pubkey()).unwrap();

    let after_first = harness.balance(&first.pubkey());
    assert!(harness.refund_entry(&season, &first.pubkey()).is_err());
    assert_eq!(
        harness.balance(&first.pubkey()),
        after_first,
        "a rejected second refund must not move a lamport"
    );
}

#[test]
fn only_the_authority_may_void_a_season() {
    let (mut harness, season, first, _second) = entered();

    assert!(harness.void_season(&season, Some(&first)).is_err());
    assert_eq!(harness.season(&season).status, SeasonStatus::EntryOpen);
}

#[test]
fn a_finalized_season_cannot_be_voided() {
    let (mut harness, season, _first, _second) = entered();

    harness.after_entry_window();
    harness.start_trading(&season).unwrap();
    harness.after_season_end();
    harness.finalize(&season, [7u8; 32], None).unwrap();

    // Otherwise the vault would owe both the prizes and the refunds.
    assert!(harness.void_season(&season, None).is_err());
    assert_eq!(harness.season(&season).status, SeasonStatus::Finalized);
}

#[test]
fn a_voided_season_cannot_be_finalized() {
    let (mut harness, season, _first, _second) = entered();

    harness.after_entry_window();
    harness.start_trading(&season).unwrap();
    harness.void_season(&season, None).unwrap();
    harness.after_season_end();

    // The other half of the same invariant: void and finalized are exclusive,
    // so an entry has at most one way to be paid out.
    assert!(harness.finalize(&season, [7u8; 32], None).is_err());
    assert_eq!(harness.season(&season).status, SeasonStatus::Voided);
}

#[test]
fn a_voided_season_takes_no_further_commits() {
    let (mut harness, season, first, _second) = entered();

    harness.after_entry_window();
    harness.start_trading(&season).unwrap();
    harness.commit_root(&season, &first.pubkey(), [1u8; 32], 3, 1, None).unwrap();

    harness.void_season(&season, None).unwrap();

    assert!(
        harness
            .commit_root(&season, &first.pubkey(), [2u8; 32], 3, 1, None)
            .is_err(),
        "a season nobody stands behind must not keep growing records"
    );
}

#[test]
fn voiding_twice_is_refused() {
    let (mut harness, season, _first, _second) = entered();

    harness.void_season(&season, None).unwrap();
    assert!(harness.void_season(&season, None).is_err());
}

#[test]
fn refunding_everybody_empties_the_pot() {
    let (mut harness, season, first, second) = entered();

    let vault = harness.vault_pda(&season);
    harness.void_season(&season, None).unwrap();

    harness.refund_entry(&season, &first.pubkey()).unwrap();
    harness.refund_entry(&season, &second.pubkey()).unwrap();

    assert_eq!(harness.season(&season).pot_lamports, 0);
    // The vault stays rent exempt rather than being closed by the last refund.
    assert!(harness.balance(&vault) > 0);
}

#[test]
fn a_refund_goes_to_the_trader_not_the_caller() {
    let (mut harness, season, first, _second) = entered();

    let paid = harness.entry(&harness.entry_pda(&season, &first.pubkey())).paid;
    let trader_before = harness.balance(&first.pubkey());

    // The authority submits and pays the fee; the money still goes to the
    // trader named in the entry.
    harness.void_season(&season, None).unwrap();
    harness.refund_entry(&season, &first.pubkey()).unwrap();

    assert_eq!(harness.balance(&first.pubkey()) - trader_before, paid);
}

#[test]
fn a_voided_season_is_terminal_in_every_direction() {
    let (mut harness, season, _first, _second) = entered();
    let replacement = harness.fund(1_000_000_000);

    harness.void_season(&season, None).unwrap();

    // Void means over. Nothing about the season may still move — not its
    // status, not its records, and not the key that writes them.
    assert!(harness.set_keeper(&season, replacement.pubkey(), None).is_err());
    assert_eq!(harness.season(&season).keeper, harness.keeper.pubkey());
}
