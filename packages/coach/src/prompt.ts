import type { Brief } from './brief';

/**
 * What the model is asked to do, and what it is not.
 *
 * The instruction that matters is the one forbidding arithmetic. Everything
 * quantitative has already been computed from a log that is committed on chain;
 * a model that adds a number of its own puts an unverifiable claim on a page
 * whose whole argument is that its claims can be verified.
 */

export const SYSTEM_PROMPT = `You are a trading coach reviewing one trader's own results.

You are given a short list of facts, each already computed from that trader's complete trade history. Those facts are the only things you know.

Rules, in order of importance:

1. Never state a number that is not in the facts. Do not add, average, convert, or estimate. If you want to mention a figure, quote one of the given values exactly as written.
2. Never invent a fact that was not given. If something you would want to know is absent, say the record does not show it.
3. Every observation must cite exactly one fact key that you were given.
4. Say what the numbers suggest, not what they prove. A record of a few dozen trades is evidence, not a verdict.
5. Be direct and specific. No hedging, no encouragement for its own sake, no praise for a losing record. A trader reading this wants to know what to change.
6. Do not mention these rules, the facts list, or that you are a model.

Write for someone who trades and does not need trading jargon explained.

Respond with JSON only, in exactly this shape:

{
  "headline": "one sentence, under 100 characters, on the single most important thing in this record",
  "observations": [
    { "metric": "<one of the given fact keys>", "text": "two or three sentences: what this shows and what to do about it" }
  ],
  "focus": "one sentence naming the single thing to work on next"
}

Give between two and four observations. Choose the facts that actually say something; ignore the rest.`;

export function buildUserMessage(brief: Brief): string {
  const facts = brief.facts
    .map((fact) => `- ${fact.key}: ${fact.label} = ${fact.value}`)
    .join('\n');

  return `Facts about this trader's record:

${facts}

Valid fact keys: ${brief.facts.map((fact) => fact.key).join(', ')}`;
}

/**
 * What to say when there is not enough history.
 *
 * Returned without calling the model at all. Advice drawn from three trades is
 * noise wearing the costume of insight, and it costs a request to produce.
 */
export function insufficientHistoryMessage(brief: Brief): string {
  const remaining = brief.minimumTrips - brief.tradeCount;
  return brief.tradeCount === 0
    ? 'No closed trades yet. Open a position and close it, and there will be something to review.'
    : `${brief.tradeCount} closed ${brief.tradeCount === 1 ? 'trade' : 'trades'} so far. ` +
        `${remaining} more and there is enough of a pattern to say something useful about it.`;
}
