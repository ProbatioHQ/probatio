import { describe, expect, it } from 'vitest';
import type { Brief } from '../src/brief';
import { reviewResponse, unsupportedFigures } from '../src/review';

const brief: Brief = {
  facts: [
    { key: 'winRateBps', label: 'Win rate', value: '38.0% (19 of 50)' },
    { key: 'netPnl', label: 'Net profit and loss', value: '-2.340 SOL' },
    { key: 'exitEfficiencyBps', label: 'Exit timing', value: '22.0%' },
  ],
  tradeCount: 50,
  sufficient: true,
  minimumTrips: 5,
};

function response(body: unknown): string {
  return JSON.stringify(body);
}

describe('spotting invented figures', () => {
  it('accepts a figure quoted from the record', () => {
    expect(unsupportedFigures('Your win rate is 38.0%, which is low.', brief)).toEqual([]);
  });

  it('catches a percentage that was never given', () => {
    expect(unsupportedFigures('You win about 61.5% of the time.', brief)).toEqual(['61.5%']);
  });

  it('catches an invented SOL amount', () => {
    expect(unsupportedFigures('You are down 4.100 SOL overall.', brief)).toEqual(['4.100 SOL']);
  });

  it('catches a number the model arrived at by doing arithmetic', () => {
    // 19 wins out of 50 is in the record. "31 losses" is not — it is correct,
    // and it is still a number this system did not compute.
    expect(unsupportedFigures('That leaves 12.5% unaccounted for.', brief)).toEqual(['12.5%']);
  });

  it('leaves ordinary counting alone', () => {
    // Rejecting these would drop good writing to catch nothing.
    expect(unsupportedFigures('Pick one thing and fix it over the next 3 sessions.', brief)).toEqual([]);
  });

  it('ignores spacing differences when matching', () => {
    expect(unsupportedFigures('You are down -2.340SOL.', brief)).toEqual([]);
  });
});

describe('reviewing a response', () => {
  it('accepts a clean report', () => {
    const result = reviewResponse(
      response({
        headline: 'You exit far too early.',
        observations: [
          { metric: 'exitEfficiencyBps', text: 'At 22.0% you are selling near the low of the range.' },
          { metric: 'winRateBps', text: 'Winning less than half the time is survivable if the winners are large.' },
        ],
        focus: 'Hold winners past your first instinct to sell.',
      }),
      brief,
    );

    expect(result.report?.observations).toHaveLength(2);
    expect(result.dropped).toBe(0);
    expect(result.problems).toEqual([]);
  });

  it('drops an observation citing a fact it was never given', () => {
    const result = reviewResponse(
      response({
        headline: 'Mixed record.',
        observations: [
          { metric: 'winRateBps', text: 'Under half your trades work.' },
          { metric: 'sharpeRatio', text: 'Your risk-adjusted return is poor.' },
        ],
        focus: 'Trade less.',
      }),
      brief,
    );

    expect(result.report?.observations).toHaveLength(1);
    expect(result.dropped).toBe(1);
    expect(result.problems[0]).toContain('sharpeRatio');
  });

  it('drops an observation that invented a figure', () => {
    const result = reviewResponse(
      response({
        headline: 'You exit early.',
        observations: [
          { metric: 'exitEfficiencyBps', text: 'You capture only 22.0% of the range.' },
          { metric: 'netPnl', text: 'Cutting your losers at 8.5% would have saved most of this.' },
        ],
        focus: 'Sell later.',
      }),
      brief,
    );

    expect(result.report?.observations).toHaveLength(1);
    expect(result.problems[0]).toContain('8.5%');
  });

  it('refuses the whole report when the headline invents a figure', () => {
    // A headline is the one line everyone reads. A wrong number there is
    // worse than no report.
    const result = reviewResponse(
      response({
        headline: 'You are giving back 55.0% of your gains.',
        observations: [{ metric: 'winRateBps', text: 'Under half your trades work.' }],
        focus: 'Sell later.',
      }),
      brief,
    );

    expect(result.report).toBeNull();
    expect(result.problems.at(-1)).toContain('headline');
  });

  it('keeps the report but drops a focus line that invented a figure', () => {
    const result = reviewResponse(
      response({
        headline: 'You exit early.',
        observations: [{ metric: 'winRateBps', text: 'Under half your trades work.' }],
        focus: 'Aim for a 45.0% win rate.',
      }),
      brief,
    );

    expect(result.report).not.toBeNull();
    expect(result.report?.focus).toBe('');
  });

  it('returns nothing when every observation failed', () => {
    const result = reviewResponse(
      response({
        headline: 'Mixed record.',
        observations: [{ metric: 'madeUpKey', text: 'Something.' }],
        focus: 'Something else.',
      }),
      brief,
    );

    expect(result.report).toBeNull();
    expect(result.problems.at(-1)).toBe('nothing survived checking');
  });
});

describe('responses that are not what was asked for', () => {
  it('reads JSON out of a code fence', () => {
    const result = reviewResponse(
      '```json\n' +
        response({
          headline: 'You exit early.',
          observations: [{ metric: 'winRateBps', text: 'Under half your trades work.' }],
          focus: 'Sell later.',
        }) +
        '\n```',
      brief,
    );

    expect(result.report?.headline).toBe('You exit early.');
  });

  it('reads JSON out of surrounding chatter', () => {
    const result = reviewResponse(
      'Here is my review:\n' +
        response({
          headline: 'You exit early.',
          observations: [{ metric: 'winRateBps', text: 'Under half your trades work.' }],
          focus: 'Sell later.',
        }) +
        '\nHope that helps.',
      brief,
    );

    expect(result.report?.headline).toBe('You exit early.');
  });

  it('gives up on something that is not JSON at all', () => {
    const result = reviewResponse('I would rather not.', brief);
    expect(result.report).toBeNull();
    expect(result.problems).toEqual(['the response was not valid JSON']);
  });

  it('gives up when there is no headline', () => {
    const result = reviewResponse(response({ observations: [] }), brief);
    expect(result.report).toBeNull();
    expect(result.problems).toEqual(['the response had no headline']);
  });

  it('survives observations that are not objects', () => {
    const result = reviewResponse(
      response({
        headline: 'Fine.',
        observations: ['a string', null, { metric: 'winRateBps', text: 'Under half work.' }],
        focus: 'Sell later.',
      }),
      brief,
    );

    expect(result.report?.observations).toHaveLength(1);
    expect(result.dropped).toBe(2);
  });

  it('survives an empty observation text', () => {
    const result = reviewResponse(
      response({
        headline: 'Fine.',
        observations: [
          { metric: 'winRateBps', text: '   ' },
          { metric: 'netPnl', text: 'You are down over the period.' },
        ],
        focus: '',
      }),
      brief,
    );

    expect(result.report?.observations).toHaveLength(1);
    expect(result.report?.focus).toBe('');
  });
});
