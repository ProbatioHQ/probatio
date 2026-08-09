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
}
