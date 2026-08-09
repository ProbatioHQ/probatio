/**
 * @probatio/retention — whether people come back.
 *
 * First-party and deliberately minimal: a public wallet address and a date, and
 * nothing else. No third-party script, no IP addresses, no user agents, no page
 * views. A hosted analytics account is an account — an email, a card, a company
 * that knows who runs this — and adding one would trade away the anonymity this
 * project is being built with for numbers a few lines of SQL already answer.
 */

export { DAY_MS, cohorts, dayNumber, dayString, summarize } from './cohort';
export type { Activity, Cohort, RetentionOptions, Summary } from './cohort';
