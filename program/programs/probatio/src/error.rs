use anchor_lang::prelude::*;

#[error_code]
pub enum ProbatioError {
    #[msg("this season is not accepting entries")]
    EntriesClosed,

    #[msg("the entry window for this season has passed")]
    EntryWindowPassed,

    #[msg("this season has been finalized and cannot be changed")]
    SeasonFinalized,

    #[msg("only the season keeper may commit trade records")]
    NotKeeper,

    #[msg("only the season authority may do this")]
    NotAuthority,

    #[msg("a season cannot move backwards through its lifecycle")]
    InvalidStatusTransition,

    #[msg("a commit must contain at least one trade")]
    EmptyCommit,

    #[msg("free play has no entry cost and takes no entries")]
    FreePlayTakesNoEntries,

    #[msg("the season's end must come after its start")]
    InvalidSchedule,

    #[msg("basis points cannot exceed 10000")]
    InvalidBasisPoints,

    #[msg("the results root cannot be empty")]
    EmptyResultsRoot,

    #[msg("this trader did not enter this season")]
    NotEntered,

    #[msg("the season has not been finalized")]
    SeasonNotFinalized,
    #[msg("this entry belongs to a different season")]
    EntrySeasonMismatch,
    #[msg("this entry belongs to a different trader")]
    EntryTraderMismatch,
    #[msg("this prize has already been claimed")]
    AlreadyClaimed,
    #[msg("the claim is not well formed")]
    InvalidClaim,
    #[msg("this result was not awarded a prize")]
    NothingToClaim,
    #[msg("the proof is longer than any real tree")]
    ProofTooLong,
    #[msg("the proof does not lead to the published results root")]
    ProofDoesNotMatchResults,
    #[msg("the vault does not hold enough to pay this claim")]
    VaultUnderfunded,
    #[msg("the season has not ended yet")]
    SeasonNotOver,
    #[msg("the entry window has not closed yet")]
    EntryWindowStillOpen,
}
