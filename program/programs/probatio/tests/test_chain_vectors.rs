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

/// The result leaf, pinned against the TypeScript encoder.
///
/// A prize is claimed by proving a leaf against the results root, so the two
/// encoders have to agree byte for byte. A mismatch here is not a vulnerability
/// so much as a lock nobody holds the key to: every honest proof fails and the
/// vault stays shut.
///
/// The vector comes from `@probatio/scoring`. If either side changes, this
/// fails.
#[test]
fn result_leaf_matches_the_typescript_encoder() {
    use solana_sha256_hasher::hashv;

    const RESULT_LEAF_PREFIX: u8 = 0x02;

    let trader = [
        0u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 1,
    ];

    let mut bytes = Vec::new();
    bytes.push(RESULT_LEAF_PREFIX);
    bytes.extend_from_slice(&1i16.to_be_bytes());
    bytes.extend_from_slice(&3u32.to_be_bytes());
    bytes.extend_from_slice(&trader);
    bytes.extend_from_slice(&10_000_000_000u128.to_be_bytes());
    bytes.extend_from_slice(&23_456_789_012u128.to_be_bytes());
    bytes.extend_from_slice(&13_456i32.to_be_bytes());
    bytes.extend_from_slice(&42u32.to_be_bytes());
    bytes.extend_from_slice(&1_234_567_890u128.to_be_bytes());

    // 1 tag + 2 + 4 + 32 + 16 + 16 + 4 + 4 + 16
    assert_eq!(bytes.len(), 95);

    let hash = hashv(&[&bytes]).to_bytes();
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();

    assert_eq!(
        hex, "265343ce56a1713653b895bff7a2407ab70acddc847f7bfa4799ba56d308dee0",
        "the on-chain result leaf must hash identically to the TypeScript one"
    );
}
