use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::{types::FailedTransactionMetadata, LiteSVM},
    solana_clock::Clock,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub use probatio::instructions::init_season::SeasonParams;
pub use probatio::state::{Entry, Season, SeasonStatus, TraderRecord};

pub const SEASON_SEED: &[u8] = b"season";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ENTRY_SEED: &[u8] = b"entry";
pub const RECORD_SEED: &[u8] = b"record";

pub const ENTRY_COST: u64 = 50_000_000; // 0.05 SOL, the A1 spec

/// A season with the real spec's shape, so the tests exercise the numbers the
/// product will actually run rather than convenient round ones.
pub fn default_params(ordinal: i16, keeper: Pubkey) -> SeasonParams {
    SeasonParams {
        ordinal,
        keeper,
        starts_at: 1_000,
        ends_at: 1_000 + 7 * 24 * 60 * 60, // season 1 runs a week
        entry_closes_at: 1_000 + 48 * 60 * 60,
        starting_balance: 10_000_000_000,
        entry_cost: ENTRY_COST,
        house_bps: 1_000,
        house_threshold: 1_000_000_000,
        latency_ms: 600,
        slippage_bps: 1_000,
        max_price_impact_bps: 5_000,
        engine_version: 1,
        scoring_formula_hash: [7u8; 32],
    }
}

pub struct Harness {
    pub svm: LiteSVM,
    pub program_id: Pubkey,
    pub authority: Keypair,
    pub keeper: Keypair,
}

impl Harness {
    pub fn new() -> Self {
        let program_id = probatio::id();
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/probatio.so"
        ));
        svm.add_program(program_id, bytes).unwrap();

        let authority = Keypair::new();
        let keeper = Keypair::new();
        svm.airdrop(&authority.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&keeper.pubkey(), 100_000_000_000).unwrap();

        Self {
            svm,
            program_id,
            authority,
            keeper,
        }
    }

    /// Move the validator's clock.
    ///
    /// litesvm starts at the epoch, which quietly makes every deadline in a
    /// season lie in the future — so a window that should have closed never
    /// does, and the test that would have caught it passes for the wrong
    /// reason.
    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    /// Move to a point where the entry window has closed.
    ///
    /// The program now refuses to start trading early, so a test that wants a
    /// running season has to reach the moment the season said it would begin.
    pub fn after_entry_window(&mut self) {
        self.set_time(1_000 + 48 * 60 * 60);
    }

    /// Move past the end of the season, where finalizing becomes legal.
    pub fn after_season_end(&mut self) {
        self.set_time(1_000 + 7 * 24 * 60 * 60 + 1);
    }

    pub fn fund(&mut self, lamports: u64) -> Keypair {
        let account = Keypair::new();
        self.svm.airdrop(&account.pubkey(), lamports).unwrap();
        account
    }

    pub fn season_pda(&self, ordinal: i16) -> Pubkey {
        Pubkey::find_program_address(&[SEASON_SEED, &ordinal.to_le_bytes()], &self.program_id).0
    }

    pub fn vault_pda(&self, season: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[VAULT_SEED, season.as_ref()], &self.program_id).0
    }

    pub fn entry_pda(&self, season: &Pubkey, trader: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[ENTRY_SEED, season.as_ref(), trader.as_ref()],
            &self.program_id,
        )
        .0
    }

    pub fn record_pda(&self, season: &Pubkey, trader: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[RECORD_SEED, season.as_ref(), trader.as_ref()],
            &self.program_id,
        )
        .0
    }

    pub fn send(
        &mut self,
        instruction: Instruction,
        signers: &[&Keypair],
        payer: &Pubkey,
    ) -> Result<(), FailedTransactionMetadata> {
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[instruction], Some(payer), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx).map(|_| ())
    }

    pub fn init_season(&mut self, params: SeasonParams) -> Result<Pubkey, FailedTransactionMetadata> {
        let season = self.season_pda(params.ordinal);
        let vault = self.vault_pda(&season);

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &probatio::instruction::InitSeason {
                params: params.clone(),
            }
            .data(),
            probatio::accounts::InitSeason {
                authority: self.authority.pubkey(),
                season,
                vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );

        let authority = self.authority.insecure_clone();
        self.send(instruction, &[&authority], &authority.pubkey())?;
        Ok(season)
    }

    pub fn open_entries(&mut self, season: &Pubkey) -> Result<(), FailedTransactionMetadata> {
        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &probatio::instruction::OpenEntries {}.data(),
            probatio::accounts::OpenEntries {
                authority: self.authority.pubkey(),
                season: *season,
            }
            .to_account_metas(None),
        );
        let authority = self.authority.insecure_clone();
        self.send(instruction, &[&authority], &authority.pubkey())
    }

    pub fn start_trading(&mut self, season: &Pubkey) -> Result<(), FailedTransactionMetadata> {
        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &probatio::instruction::StartTrading {}.data(),
            probatio::accounts::StartTrading {
                authority: self.authority.pubkey(),
                season: *season,
            }
            .to_account_metas(None),
        );
        let authority = self.authority.insecure_clone();
        self.send(instruction, &[&authority], &authority.pubkey())
    }

    pub fn record_entry(
        &mut self,
        season: &Pubkey,
        trader: &Keypair,
    ) -> Result<(), FailedTransactionMetadata> {
        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &probatio::instruction::RecordEntry {}.data(),
            probatio::accounts::RecordEntry {
                trader: trader.pubkey(),
                season: *season,
                entry: self.entry_pda(season, &trader.pubkey()),
                vault: self.vault_pda(season),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(instruction, &[trader], &trader.pubkey())
    }

    pub fn commit_root(
        &mut self,
        season: &Pubkey,
        trader: &Pubkey,
        batch_root: [u8; 32],
        leaves: u32,
        engine_version: u32,
        signer: Option<&Keypair>,
    ) -> Result<(), FailedTransactionMetadata> {
        let keeper = self.keeper.insecure_clone();
        let signer = signer.unwrap_or(&keeper);

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &probatio::instruction::CommitRoot {
                batch_root,
                leaves,
                engine_version,
            }
            .data(),
            probatio::accounts::CommitRoot {
                keeper: signer.pubkey(),
                season: *season,
                trader: *trader,
                record: self.record_pda(season, trader),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(instruction, &[signer], &signer.pubkey())
    }

    pub fn set_keeper(
        &mut self,
        season: &Pubkey,
        keeper: Pubkey,
        signer: Option<&Keypair>,
    ) -> Result<(), FailedTransactionMetadata> {
        let authority = self.authority.insecure_clone();
        let signer = signer.unwrap_or(&authority);

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &probatio::instruction::SetKeeper { keeper }.data(),
            probatio::accounts::SetKeeper {
                authority: signer.pubkey(),
                season: *season,
            }
            .to_account_metas(None),
        );
        let signer = signer.insecure_clone();
        self.send(instruction, &[&signer], &signer.pubkey())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn claim_prize(
        &mut self,
        season: &Pubkey,
        trader: &Pubkey,
        claim: probatio::ResultClaim,
        proof: Vec<probatio::ProofStep>,
    ) -> Result<(), FailedTransactionMetadata> {
        let entry = self.entry_pda(season, trader);
        let vault = self.vault_pda(season);

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &probatio::instruction::ClaimPrize { claim, proof }.data(),
            probatio::accounts::ClaimPrize {
                payer: self.authority.pubkey(),
                season: *season,
                entry,
                trader: *trader,
                vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );

        let authority = self.authority.insecure_clone();
        self.send(instruction, &[&authority], &authority.pubkey())
    }

    pub fn void_season(
        &mut self,
        season: &Pubkey,
        signer: Option<&Keypair>,
    ) -> Result<(), FailedTransactionMetadata> {
        let authority = self.authority.insecure_clone();
        let signer = signer.unwrap_or(&authority);

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &probatio::instruction::VoidSeason {}.data(),
            probatio::accounts::VoidSeason {
                authority: signer.pubkey(),
                season: *season,
            }
            .to_account_metas(None),
        );
        self.send(instruction, &[signer], &signer.pubkey())
    }

    pub fn refund_entry(
        &mut self,
        season: &Pubkey,
        trader: &Pubkey,
    ) -> Result<(), FailedTransactionMetadata> {
        let entry = self.entry_pda(season, trader);
        let vault = self.vault_pda(season);

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &probatio::instruction::RefundEntry {}.data(),
            probatio::accounts::RefundEntry {
                payer: self.authority.pubkey(),
                season: *season,
                entry,
                trader: *trader,
                vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );

        let authority = self.authority.insecure_clone();
        self.send(instruction, &[&authority], &authority.pubkey())
    }

    pub fn balance(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn finalize(
        &mut self,
        season: &Pubkey,
        results_root: [u8; 32],
        signer: Option<&Keypair>,
    ) -> Result<(), FailedTransactionMetadata> {
        let authority = self.authority.insecure_clone();
        let signer = signer.unwrap_or(&authority);

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &probatio::instruction::FinalizeSeason { results_root }.data(),
            probatio::accounts::FinalizeSeason {
                authority: signer.pubkey(),
                season: *season,
            }
            .to_account_metas(None),
        );
        self.send(instruction, &[signer], &signer.pubkey())
    }

    pub fn season(&self, address: &Pubkey) -> Season {
        let account = self.svm.get_account(address).unwrap();
        let mut data: &[u8] = &account.data;
        Season::try_deserialize(&mut data).unwrap()
    }

    pub fn entry(&self, address: &Pubkey) -> Entry {
        let account = self.svm.get_account(address).unwrap();
        let mut data: &[u8] = &account.data;
        Entry::try_deserialize(&mut data).unwrap()
    }

    pub fn record(&self, address: &Pubkey) -> TraderRecord {
        let account = self.svm.get_account(address).unwrap();
        let mut data: &[u8] = &account.data;
        TraderRecord::try_deserialize(&mut data).unwrap()
    }

    pub fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map(|a| a.lamports).unwrap_or(0)
    }
}
