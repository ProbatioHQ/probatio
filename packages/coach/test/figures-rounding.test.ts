import { describe, expect, it } from 'vitest';
import { unsupportedFigures } from '../src/review';
import type { Brief } from '../src/brief';

const brief = {
  facts: [
    { key: 'netPnl', label: 'Net profit and loss', value: '-1.234 SOL' },
    { key: 'averageWin', label: 'Average win', value: '0.500 SOL' },
    { key: 'averageMfeBps', label: 'Best unrealized', value: '12.3%' },
  ],
} as unknown as Brief;

describe('figures', () => {
  it('accepts a faithful rounding, which used to be rejected', () => {
    expect(unsupportedFigures('you gave back 0.5 SOL on average', brief)).toEqual([]);
    expect(unsupportedFigures('you were up 12% at best', brief)).toEqual([]);
    expect(unsupportedFigures('down 1.23 SOL overall', brief)).toEqual([]);
  });
  it('accepts the exact value', () => {
    expect(unsupportedFigures('down 1.234 SOL, best 12.3%', brief)).toEqual([]);
  });

  /*
   * The brief writes a loss as negative and English writes it as a positive
   * with a verb in front. Requiring the sign to match rejected the commonest
   * sentence a coach produces.
   */
  it('accepts a loss quoted without its minus sign', () => {
    expect(unsupportedFigures('you lost 1.234 SOL', brief)).toEqual([]);
    expect(unsupportedFigures('you gave back 1.23 SOL', brief)).toEqual([]);
  });
  it('still rejects an invented figure', () => {
    expect(unsupportedFigures('you lost 9.999 SOL', brief)).toEqual(['9.999 SOL']);
    expect(unsupportedFigures('you were up 47%', brief)).toEqual(['47%']);
  });
  it('does not let a unit swap through', () => {
    expect(unsupportedFigures('12.3 SOL', brief)).toEqual(['12.3 SOL']);
  });
});
