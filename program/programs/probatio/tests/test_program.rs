mod common;

use common::*;
use solana_signer::Signer;

// ---------------------------------------------------------------------------
// Creating a season
// ---------------------------------------------------------------------------

#[test]
fn records_every_condition_that_could_change_a_result() {
    let mut harness = Harness::new();
    let params = default_params(1, harness.keeper.pubkey());
    let season = harness.init_season(params.clone()).unwrap();

    let state = harness.season(&season);

    // The point of putting these on chain: the claim is not merely "these
    // trades happened" but "these trades happened under these rules". Without
    // the rules recorded, anyone can say the latency or the fee schedule moved
    // partway through and there is no answer.
    assert_eq!(state.latency_ms, params.latency_ms);
    assert_eq!(state.slippage_bps, params.slippage_bps);
    assert_eq!(state.max_price_impact_bps, params.max_price_impact_bps);
    assert_eq!(state.engine_version, params.engine_version);
    assert_eq!(state.scoring_formula_hash, params.scoring_formula_hash);
    assert_eq!(state.starting_balance, params.starting_balance);
    assert_eq!(state.entry_cost, params.entry_cost);
    assert_eq!(state.house_bps, params.house_bps);
    assert_eq!(state.house_threshold, params.house_threshold);
}

#[test]
fn starts_pending_and_empty() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();

    let state = harness.season(&season);
    assert_eq!(state.status, SeasonStatus::Pending);
    assert_eq!(state.entry_count, 0);
    assert_eq!(state.pot_lamports, 0);
    assert_eq!(state.results_root, [0u8; 32]);
    assert_eq!(state.finalized_at, 0);
}

#[test]
fn separates_the_keeper_from_the_authority() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();

    // The keeper signs constantly and is therefore a hot key. Keeping it
    // distinct from the authority means a compromise cannot also rewrite the
    // season's rules or publish its results.
    let state = harness.season(&season);
    assert_eq!(state.authority, harness.authority.pubkey());
    assert_eq!(state.keeper, harness.keeper.pubkey());
    assert_ne!(state.authority, state.keeper);
}

#[test]
fn rejects_a_season_that_ends_before_it_starts() {
    let mut harness = Harness::new();
    let mut params = default_params(1, harness.keeper.pubkey());
    params.ends_at = params.starts_at - 1;
    assert!(harness.init_season(params).is_err());
}

#[test]
fn rejects_an_entry_window_outside_the_season() {
    let mut harness = Harness::new();
    let mut params = default_params(1, harness.keeper.pubkey());
    params.entry_closes_at = params.ends_at + 1;
    assert!(harness.init_season(params).is_err());
}

#[test]
fn rejects_impossible_basis_points() {
    let mut harness = Harness::new();
    let mut params = default_params(1, harness.keeper.pubkey());
    params.house_bps = 10_001;
    assert!(harness.init_season(params).is_err());
}

#[test]
fn cannot_create_the_same_season_twice() {
    let mut harness = Harness::new();
    let params = default_params(1, harness.keeper.pubkey());
    harness.init_season(params.clone()).unwrap();
    assert!(harness.init_season(params).is_err());
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[test]
fn moves_forward_through_its_lifecycle() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();

    harness.open_entries(&season).unwrap();
    assert_eq!(harness.season(&season).status, SeasonStatus::EntryOpen);

    harness.start_trading(&season).unwrap();
    assert_eq!(harness.season(&season).status, SeasonStatus::Running);
}

#[test]
fn cannot_reopen_entries_once_trading_has_begun() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();
    harness.start_trading(&season).unwrap();

    // The cohort is fixed once trading starts. A late entrant competes over a
    // shorter clock, which makes the ranking incomparable.
    assert!(harness.open_entries(&season).is_err());
}

#[test]
fn only_the_authority_may_move_a_season_along() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();

    let stranger = harness.fund(10_000_000_000);
    let instruction = anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        harness.program_id,
        &{
            use anchor_lang::InstructionData;
            probatio::instruction::OpenEntries {}.data()
        },
        {
            use anchor_lang::ToAccountMetas;
            probatio::accounts::OpenEntries {
                authority: stranger.pubkey(),
                season,
            }
            .to_account_metas(None)
        },
    );
    assert!(harness
        .send(instruction, &[&stranger], &stranger.pubkey())
        .is_err());
}

// ---------------------------------------------------------------------------
// Entering
// ---------------------------------------------------------------------------

#[test]
fn takes_an_entry_and_holds_the_fee_in_the_vault() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();

    let trader = harness.fund(10_000_000_000);
    let vault = harness.vault_pda(&season);
    let before = harness.lamports(&vault);

    harness.record_entry(&season, &trader).unwrap();

    assert_eq!(harness.lamports(&vault), before + ENTRY_COST);

    let entry = harness.entry(&harness.entry_pda(&season, &trader.pubkey()));
    assert_eq!(entry.trader, trader.pubkey());
    assert_eq!(entry.paid, ENTRY_COST);

    let state = harness.season(&season);
    assert_eq!(state.entry_count, 1);
    assert_eq!(state.pot_lamports, ENTRY_COST);
}

#[test]
fn refuses_a_second_entry_from_the_same_trader() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();

    let trader = harness.fund(10_000_000_000);
    harness.record_entry(&season, &trader).unwrap();

    // Enforced by the address itself, derived from the season and the trader.
    // There is no counter to get wrong and no race to lose.
    assert!(harness.record_entry(&season, &trader).is_err());
    assert_eq!(harness.season(&season).entry_count, 1);
}

#[test]
fn refuses_entries_before_the_window_opens() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();

    let trader = harness.fund(10_000_000_000);
    assert!(harness.record_entry(&season, &trader).is_err());
}

#[test]
fn refuses_entries_once_trading_has_started() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();
    harness.start_trading(&season).unwrap();

    let trader = harness.fund(10_000_000_000);
    assert!(harness.record_entry(&season, &trader).is_err());
}

#[test]
fn refuses_entries_after_the_window_has_passed() {
    let mut harness = Harness::new();
    let params = default_params(1, harness.keeper.pubkey());
    let closes_at = params.entry_closes_at;
    let season = harness.init_season(params).unwrap();
    harness.open_entries(&season).unwrap();

    // Inside the window this succeeds; the deadline is the only difference.
    harness.set_time(closes_at);
    let in_time = harness.fund(10_000_000_000);
    harness.record_entry(&season, &in_time).unwrap();

    harness.set_time(closes_at + 1);
    let too_late = harness.fund(10_000_000_000);
    assert!(harness.record_entry(&season, &too_late).is_err());

    assert_eq!(harness.season(&season).entry_count, 1);
}

#[test]
fn free_play_takes_no_entries() {
    let mut harness = Harness::new();
    let mut params = default_params(-1, harness.keeper.pubkey());
    params.entry_cost = 0;
    let season = harness.init_season(params).unwrap();
    harness.open_entries(&season).unwrap();

    // Free play is a season so nothing downstream forks on whether someone
    // paid, but paying into it is meaningless and refused outright.
    let trader = harness.fund(10_000_000_000);
    assert!(harness.record_entry(&season, &trader).is_err());
}

#[test]
fn several_traders_can_enter_the_same_season() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();

    for _ in 0..5 {
        let trader = harness.fund(10_000_000_000);
        harness.record_entry(&season, &trader).unwrap();
    }

    let state = harness.season(&season);
    assert_eq!(state.entry_count, 5);
    assert_eq!(state.pot_lamports, ENTRY_COST * 5);
}

// ---------------------------------------------------------------------------
// Committing trades
// ---------------------------------------------------------------------------

#[test]
fn commits_a_batch_and_starts_the_chain() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();

    let trader = harness.fund(10_000_000_000);
    harness
        .commit_root(&season, &trader.pubkey(), [1u8; 32], 10, 1, None)
        .unwrap();

    let record = harness.record(&harness.record_pda(&season, &trader.pubkey()));
    assert_eq!(record.trader, trader.pubkey());
    assert_eq!(record.commit_count, 1);
    assert_eq!(record.leaf_count, 10);
    assert_ne!(record.accumulator, [0u8; 32]);
}

#[test]
fn every_commit_moves_the_chain_forward() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();

    let trader = harness.fund(10_000_000_000);
    let record_pda = harness.record_pda(&season, &trader.pubkey());

    let mut seen = Vec::new();
    for i in 1u8..=4 {
        harness
            .commit_root(&season, &trader.pubkey(), [i; 32], 5, 1, None)
            .unwrap();
        seen.push(harness.record(&record_pda).accumulator);
    }

    // Each value must differ from every earlier one. A repeat would mean the
    // chain had stopped committing to what came before.
    for i in 0..seen.len() {
        for j in (i + 1)..seen.len() {
            assert_ne!(seen[i], seen[j]);
        }
    }

    let record = harness.record(&record_pda);
    assert_eq!(record.commit_count, 4);
    assert_eq!(record.leaf_count, 20);
}

#[test]
fn the_same_batches_in_a_different_order_give_a_different_chain() {
    // This is the property that makes the record unfakeable. If order did not
    // change the result, history could be quietly rearranged after the fact.
    let mut a = Harness::new();
    let season_a = a.init_season(default_params(1, a.keeper.pubkey())).unwrap();
    a.open_entries(&season_a).unwrap();
    let trader_a = a.fund(10_000_000_000);
    a.commit_root(&season_a, &trader_a.pubkey(), [1u8; 32], 5, 1, None)
        .unwrap();
    a.commit_root(&season_a, &trader_a.pubkey(), [2u8; 32], 5, 1, None)
        .unwrap();
    let first = a.record(&a.record_pda(&season_a, &trader_a.pubkey())).accumulator;

    let mut b = Harness::new();
    let season_b = b.init_season(default_params(1, b.keeper.pubkey())).unwrap();
    b.open_entries(&season_b).unwrap();
    let trader_b = b.fund(10_000_000_000);
    b.commit_root(&season_b, &trader_b.pubkey(), [2u8; 32], 5, 1, None)
        .unwrap();
    b.commit_root(&season_b, &trader_b.pubkey(), [1u8; 32], 5, 1, None)
        .unwrap();
    let second = b.record(&b.record_pda(&season_b, &trader_b.pubkey())).accumulator;

    assert_ne!(first, second);
}

#[test]
fn the_engine_version_is_part_of_the_chain() {
    // Folded into the hash rather than stored beside it, so a batch stays
    // checkable against the rules in force when it was written even if the
    // engine changes mid-season.
    let mut a = Harness::new();
    let season_a = a.init_season(default_params(1, a.keeper.pubkey())).unwrap();
    a.open_entries(&season_a).unwrap();
    let trader_a = a.fund(10_000_000_000);
    a.commit_root(&season_a, &trader_a.pubkey(), [1u8; 32], 5, 1, None)
        .unwrap();
    let with_v1 = a.record(&a.record_pda(&season_a, &trader_a.pubkey())).accumulator;

    let mut b = Harness::new();
    let season_b = b.init_season(default_params(1, b.keeper.pubkey())).unwrap();
    b.open_entries(&season_b).unwrap();
    let trader_b = b.fund(10_000_000_000);
    b.commit_root(&season_b, &trader_b.pubkey(), [1u8; 32], 5, 2, None)
        .unwrap();
    let with_v2 = b.record(&b.record_pda(&season_b, &trader_b.pubkey())).accumulator;

    assert_ne!(with_v1, with_v2);
}

#[test]
fn only_the_keeper_may_commit() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();

    let trader = harness.fund(10_000_000_000);
    let impostor = harness.fund(10_000_000_000);

    // Anyone able to commit could write whatever record they liked.
    assert!(harness
        .commit_root(&season, &trader.pubkey(), [1u8; 32], 5, 1, Some(&impostor))
        .is_err());
}

#[test]
fn a_trader_cannot_commit_their_own_record() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();

    let trader = harness.fund(10_000_000_000);
    assert!(harness
        .commit_root(&season, &trader.pubkey(), [9u8; 32], 5, 1, Some(&trader))
        .is_err());
}

#[test]
fn refuses_an_empty_commit() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();

    let trader = harness.fund(10_000_000_000);
    assert!(harness
        .commit_root(&season, &trader.pubkey(), [1u8; 32], 0, 1, None)
        .is_err());
}

#[test]
fn keeps_traders_records_separate() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();

    let one = harness.fund(10_000_000_000);
    let two = harness.fund(10_000_000_000);

    harness
        .commit_root(&season, &one.pubkey(), [1u8; 32], 10, 1, None)
        .unwrap();
    harness
        .commit_root(&season, &two.pubkey(), [1u8; 32], 3, 1, None)
        .unwrap();

    assert_eq!(
        harness.record(&harness.record_pda(&season, &one.pubkey())).leaf_count,
        10
    );
    assert_eq!(
        harness.record(&harness.record_pda(&season, &two.pubkey())).leaf_count,
        3
    );
}

#[test]
fn commits_while_trading_is_running() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();
    harness.start_trading(&season).unwrap();

    let trader = harness.fund(10_000_000_000);
    assert!(harness
        .commit_root(&season, &trader.pubkey(), [1u8; 32], 5, 1, None)
        .is_ok());
}

// ---------------------------------------------------------------------------
// Finalizing
// ---------------------------------------------------------------------------

#[test]
fn publishes_results_and_closes_the_season() {
    let mut harness = Harness::new();
    harness.set_time(2_000);
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();
    harness.start_trading(&season).unwrap();

    harness.finalize(&season, [42u8; 32], None).unwrap();

    let state = harness.season(&season);
    assert_eq!(state.status, SeasonStatus::Finalized);
    assert_eq!(state.results_root, [42u8; 32]);
    assert!(state.finalized_at > 0);
}

#[test]
fn refuses_an_empty_results_root() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();
    harness.start_trading(&season).unwrap();

    assert!(harness.finalize(&season, [0u8; 32], None).is_err());
}

#[test]
fn cannot_finalize_twice() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();
    harness.start_trading(&season).unwrap();
    harness.finalize(&season, [42u8; 32], None).unwrap();

    // Republishing would let a result be rewritten after people had acted on
    // it.
    assert!(harness.finalize(&season, [43u8; 32], None).is_err());
    assert_eq!(harness.season(&season).results_root, [42u8; 32]);
}

#[test]
fn only_the_authority_may_finalize() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();
    harness.start_trading(&season).unwrap();

    let keeper = harness.keeper.insecure_clone();
    // Not even the keeper. It signs constantly and is the likeliest key to be
    // compromised, so publishing results is kept out of its reach.
    assert!(harness.finalize(&season, [42u8; 32], Some(&keeper)).is_err());
}

#[test]
fn nothing_can_be_committed_after_finalization() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    harness.open_entries(&season).unwrap();
    harness.start_trading(&season).unwrap();

    let trader = harness.fund(10_000_000_000);
    harness
        .commit_root(&season, &trader.pubkey(), [1u8; 32], 5, 1, None)
        .unwrap();
    let frozen = harness.record(&harness.record_pda(&season, &trader.pubkey())).accumulator;

    harness.finalize(&season, [42u8; 32], None).unwrap();

    // The records the results were computed from have to be frozen as they
    // stood, or a record could change after the results depending on it were
    // published.
    assert!(harness
        .commit_root(&season, &trader.pubkey(), [2u8; 32], 5, 1, None)
        .is_err());
    assert_eq!(
        harness.record(&harness.record_pda(&season, &trader.pubkey())).accumulator,
        frozen
    );
}

#[test]
fn cannot_finalize_a_season_that_never_opened() {
    let mut harness = Harness::new();
    let season = harness
        .init_season(default_params(1, harness.keeper.pubkey()))
        .unwrap();
    assert!(harness.finalize(&season, [42u8; 32], None).is_err());
}
