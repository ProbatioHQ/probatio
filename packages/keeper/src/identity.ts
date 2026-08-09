/**
 * Confirming the keeper is the keeper.
 *
 * Checked at startup, before anything is committed. Two failures this catches,
 * and both are quiet:
 *
 * A key that is no longer the season's keeper — because it was rotated after a
 * compromise — would otherwise keep trying, failing every transaction, and
 * looking like an RPC problem. The keeper would sit there burning fees and
 * committing nothing while the season ran out.
 *
 * And a key pointed at the wrong season, or a season pointed at the wrong key,
 * fails the same way. Reading the answer off the chain once at startup costs
 * one request and turns an afternoon of confusion into a sentence.
 */

export class KeeperIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeeperIdentityError';
  }
}

export interface SeasonKeeper {
  /** The keeper the season currently names, base58. */
  readonly keeper: string;
  readonly status: string;
}

export interface IdentityCheck {
  readonly ok: boolean;
  readonly configured: string;
  readonly onChain: string | null;
  readonly detail: string;
}

export function checkIdentity(configured: string, season: SeasonKeeper | null): IdentityCheck {
  if (season === null) {
    return {
      ok: false,
      configured,
      onChain: null,
      detail: 'the season does not exist on chain',
    };
  }

  if (season.status === 'Finalized') {
    return {
      ok: false,
      configured,
      onChain: season.keeper,
      detail: 'the season is finalized and accepts no more commitments',
    };
  }

  if (season.keeper !== configured) {
    return {
      ok: false,
      configured,
      onChain: season.keeper,
      // Worth saying plainly: if this key was rotated away deliberately, the
      // right response is to stop, not to find a way to keep signing.
      detail:
        'this key is not the season keeper. If it was rotated after a compromise, ' +
        'this process should stay stopped.',
    };
  }

  return { ok: true, configured, onChain: season.keeper, detail: 'keeper confirmed' };
}
