import type { Brief, FactKey } from './brief';

/**
 * Checking the model's homework.
 *
 * Two things are enforced. Every observation must cite a fact that was actually
 * supplied, and no observation may contain a figure that does not appear in the
 * facts verbatim.
 *
 * The second rule is the important one. A model asked not to do arithmetic will
 * mostly comply, and "mostly" is not a standard this product can offer — the
 * entire pitch is that a trader's numbers can be checked against a chain. A
 * fabricated statistic in a coaching report is the same failure as a fabricated
 * leaderboard entry, only harder to spot.
 *
 * Offending observations are dropped rather than rewritten. A report with three
 * sound observations is worth more than one with four where one is invented.
 */

export interface Observation {
  readonly metric: FactKey;
  readonly text: string;
}

export interface Report {
  readonly headline: string;
  readonly observations: readonly Observation[];
  readonly focus: string;
}

export interface ReviewResult {
  readonly report: Report | null;
  /** Why the report is null, or what was removed from it. */
  readonly problems: readonly string[];
  readonly dropped: number;
}

/**
 * Figures that make a quantitative claim.
 *
 * Deliberately narrow: percentages, decimals, and SOL amounts. A bare integer
 * is left alone because "the first three trades" and "one thing at a time" are
 * ordinary English, and rejecting those would drop good writing to catch
 * nothing.
 */
const FIGURE = /-?\d+(?:\.\d+)?\s*(?:%|SOL\b)|-?\d+\.\d+/gi;

function normalize(figure: string): string {
  return figure.replace(/\s+/g, '').toLowerCase();
}

export function unsupportedFigures(text: string, brief: Brief): string[] {
  const supported = new Set(
    brief.facts.flatMap((fact) => {
      // Both the value and the label, because the model is shown the label too
      // and several labels carry a reference figure (the "100%" ideal, a "20.0%"
      // threshold). Building the supported set from the value alone flagged a
      // faithful quote of one of those as fabricated and dropped the whole
      // observation, so a correct coach reply came back as "did not check out".
      const matches = `${fact.label} ${fact.value}`.match(FIGURE) ?? [];
      return matches.map(normalize);
    }),
  );

  const found = text.match(FIGURE) ?? [];
  return found.filter((figure) => !supported.has(normalize(figure)));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Parse and check a model response. Never throws. */
export function reviewResponse(raw: string, brief: Brief): ReviewResult {
  const problems: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return { report: null, problems: ['the response was not valid JSON'], dropped: 0 };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { report: null, problems: ['the response was not an object'], dropped: 0 };
  }

  const body = parsed as Record<string, unknown>;
  if (!isNonEmptyString(body['headline'])) {
    return { report: null, problems: ['the response had no headline'], dropped: 0 };
  }
  if (!Array.isArray(body['observations'])) {
    return { report: null, problems: ['the response had no observations'], dropped: 0 };
  }

  const keys = new Set<string>(brief.facts.map((fact) => fact.key));
  const observations: Observation[] = [];
  let dropped = 0;

  for (const entry of body['observations']) {
    if (typeof entry !== 'object' || entry === null) {
      dropped += 1;
      continue;
    }
    const observation = entry as Record<string, unknown>;
    const metric = observation['metric'];
    const text = observation['text'];

    if (typeof metric !== 'string' || !keys.has(metric)) {
      problems.push(`dropped an observation citing an unknown fact: ${String(metric)}`);
      dropped += 1;
      continue;
    }
    if (!isNonEmptyString(text)) {
      dropped += 1;
      continue;
    }

    const invented = unsupportedFigures(text, brief);
    if (invented.length > 0) {
      problems.push(`dropped an observation containing figures not in the record: ${invented.join(', ')}`);
      dropped += 1;
      continue;
    }

    observations.push({ metric: metric as FactKey, text: text.trim() });
  }

  if (observations.length === 0) {
    return { report: null, problems: [...problems, 'nothing survived checking'], dropped };
  }

  const headline = body['headline'].trim();
  if (unsupportedFigures(headline, brief).length > 0) {
    return {
      report: null,
      problems: [...problems, 'the headline contained a figure not in the record'],
      dropped,
    };
  }

  const focusValue = body['focus'];
  const focus = isNonEmptyString(focusValue) ? focusValue.trim() : '';
  const focusClean = focus !== '' && unsupportedFigures(focus, brief).length === 0 ? focus : '';

  return {
    report: { headline, observations, focus: focusClean },
    problems,
    dropped,
  };
}

/**
 * Pull the JSON out of a reply that wrapped it in prose or a code fence.
 *
 * The prompt asks for JSON alone. This exists because a retry costs a request
 * and a fence costs nothing to strip.
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}
