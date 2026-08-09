/**
 * @probatio/profile — display names.
 *
 * A name is a convenience laid over a public key. The key is the identity, it
 * is what the chain commits to, and it is what a result belongs to. Removing a
 * name changes no record and invalidates no proof, which is the property that
 * makes moderating names safe.
 */

export {
  DEFAULT_NAME_RULES,
  MAX_LENGTH,
  MIN_LENGTH,
  NameError,
  checkName,
  displayName,
  foldConfusables,
  nameKey,
  shortAddress,
  validateName,
} from './name';
export type { NameRejection, NameRules } from './name';
