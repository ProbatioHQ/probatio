use solana_sha256_hasher::hashv;

/// Known-answer vectors shared with the TypeScript implementation.
///
/// The hash chain exists in two languages: here, where it is authoritative,
/// and in @probatio/commit, where the keeper predicts it and a verifier
/// replays it. Two implementations of the same algorithm drift, and the drift
/// would not surface until a verification failed in front of a user.
///
/// So both sides pin the same vectors. If either changes, one of these fails.
/// The equivalent assertions live in packages/commit/test/commit.test.ts.
fn extend(accumulator: [u8; 32], batch_root: [u8; 32], leaves: u32, engine_version: u32) -> [u8; 32] {
    hashv(&[
        &accumulator,
        &batch_root,
        &leaves.to_le_bytes(),
        &engine_version.to_le_bytes(),
    ])
    .to_bytes()
}

fn hex(bytes: [u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn matches_the_typescript_chain() {
    let first = extend([0u8; 32], [0xabu8; 32], 5, 1);
    assert_eq!(
        hex(first),
        "225ef35de89111df19cb0074343a4bab472cf40fa2540b9f30bc75403e133197",
        "step 1 diverged from @probatio/commit"
    );

    let second = extend(first, [0xcdu8; 32], 7, 2);
    assert_eq!(
        hex(second),
        "10dc9eb327056f634bf4c810b1e91dabe2ba8016f078c1e5de4b056b5939478f",
        "step 2 diverged from @probatio/commit"
    );
}
