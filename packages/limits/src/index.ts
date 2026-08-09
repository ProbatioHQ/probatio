/**
 * @probatio/limits — rate limiting.
 *
 * Deliberately in-process, and the consequence is stated rather than buried:
 * limits are per instance, so running two instances doubles every number here.
 * That is a real weakness and an acceptable one at this size — a shared store
 * is a dependency that can fail, and a rate limiter whose outage takes the
 * site down has protected nothing.
 */

export { newBucket, take } from './bucket';
export type { BucketRule, BucketState, Decision } from './bucket';

export { Limiter } from './limiter';
export type { LimiterOptions } from './limiter';

export { callerKey, clientAddress } from './identity';
export type { IdentityOptions } from './identity';

export { POLICIES } from './policy';
export type { PolicyName } from './policy';
