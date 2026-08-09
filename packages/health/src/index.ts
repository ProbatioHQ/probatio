/**
 * @probatio/health — what is working, and how long it has not been.
 *
 * Two jobs. It tells a visitor what the site can currently do, honestly, rather
 * than letting them find out by trying. And it measures downtime, because the
 * void policy voids a season on more than two hours of feed outage, and a
 * threshold nobody measures is a sentence rather than a rule.
 */

export { currentlyDown, outageMinutes, outageMs } from './outage';
export type { Dependency, Outage } from './outage';

export { capabilities, overall } from './status';
export type { Capability, CapabilityState, Level } from './status';
