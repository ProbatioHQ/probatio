/// Free play is modelled as a season so nothing downstream has to fork on
/// whether a trader paid. Its ordinal is negative because it sits outside the
/// ranked sequence entirely.
pub const FREE_PLAY_ORDINAL: i16 = -1;

/// The most basis points anything can be.
pub const MAX_BPS: u16 = 10_000;
