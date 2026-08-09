mod common;

use common::*;
use solana_signer::Signer;

/// What the authority may and may not do.
///
/// Added after a review: the published rules leaned on the chain enforcing a
/// schedule, and the chain enforced almost none of it. An authority could
/// close the entry window whenever it liked and finalize a season the moment
/// the standings suited them — and because a finalized season can never be
/// voided or added to, that would have been the end of the argument.

#[test]
fn cannot_close_the_entry_window_early() {
    // Taking entries and then shutting the door early is a different season
    // from the one people paid to join.
    let mut harness = Harness::new();
    harness.set_time(1_100);

    let season = harness.init_season(default_params(1, harness.keeper.pubkey())).unwrap();
    harness.open_entries(&season).unwrap();

    assert!(harness.start_trading(&season).is_err());
}

#[test]
fn closes_the_entry_window_when_it_said_it_would() {
    let mut harness = Harness::new();
    harness.set_time(1_100);

    let season = harness.init_season(default_params(1, harness.keeper.pubkey())).unwrap();
    harness.open_entries(&season).unwrap();
    harness.after_entry_window();

    assert!(harness.start_trading(&season).is_ok());
}

#[test]
fn cannot_finalize_before_the_season_ends() {
    // The one that matters most. Without this, an authority watching the
    // leaderboard could finalize the instant they liked the result.
    let mut harness = Harness::new();
    harness.set_time(1_100);

    let season = harness.init_season(default_params(1, harness.keeper.pubkey())).unwrap();
    harness.open_entries(&season).unwrap();
    harness.after_entry_window();
    harness.start_trading(&season).unwrap();

    assert!(harness.finalize(&season, [42u8; 32], None).is_err());
}

#[test]
fn finalizes_once_the_season_is_over() {
    let mut harness = Harness::new();
    harness.set_time(1_100);

    let season = harness.init_season(default_params(1, harness.keeper.pubkey())).unwrap();
    harness.open_entries(&season).unwrap();
    harness.after_entry_window();
    harness.start_trading(&season).unwrap();
    harness.after_season_end();

    assert!(harness.finalize(&season, [42u8; 32], None).is_ok());
}

#[test]
fn the_authority_can_replace_a_compromised_keeper() {
    // The keeper is a hot key that signs continuously. Separating it from the
    // authority bought nothing while there was no way to take it away.
    let mut harness = Harness::new();
    let season = harness.init_season(default_params(1, harness.keeper.pubkey())).unwrap();

    let replacement = harness.fund(1_000_000_000);
    assert!(harness.set_keeper(&season, replacement.pubkey(), None).is_ok());
    assert_eq!(harness.season(&season).keeper, replacement.pubkey());
}

#[test]
fn nobody_else_can_replace_the_keeper() {
    let mut harness = Harness::new();
    let season = harness.init_season(default_params(1, harness.keeper.pubkey())).unwrap();

    let stranger = harness.fund(1_000_000_000);
    assert!(harness
        .set_keeper(&season, stranger.pubkey(), Some(&stranger))
        .is_err());
}

#[test]
fn a_replaced_keeper_cannot_commit_any_more() {
    let mut harness = Harness::new();
    let season = harness.init_season(default_params(1, harness.keeper.pubkey())).unwrap();
    harness.open_entries(&season).unwrap();
    harness.after_entry_window();
    harness.start_trading(&season).unwrap();

    let old = harness.keeper.insecure_clone();
    let replacement = harness.fund(1_000_000_000);
    harness.set_keeper(&season, replacement.pubkey(), None).unwrap();

    let trader = harness.fund(1_000_000_000);
    assert!(harness
        .commit_root(&season, &trader.pubkey(), [1u8; 32], 3, 1, Some(&old))
        .is_err());
}

#[test]
fn the_keeper_cannot_be_replaced_after_finalization() {
    // Nothing about a finished season changes, including who could have
    // written to it.
    let mut harness = Harness::new();
    let season = harness.init_season(default_params(1, harness.keeper.pubkey())).unwrap();
    harness.open_entries(&season).unwrap();
    harness.after_entry_window();
    harness.start_trading(&season).unwrap();
    harness.after_season_end();
    harness.finalize(&season, [42u8; 32], None).unwrap();

    let replacement = harness.fund(1_000_000_000);
    assert!(harness.set_keeper(&season, replacement.pubkey(), None).is_err());
}
