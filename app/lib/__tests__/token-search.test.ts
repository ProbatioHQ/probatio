import { describe, expect, it } from 'vitest';
import { parseTokens } from '../token-search';

function pair(over: Record<string, unknown>): Record<string, unknown> {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    baseToken: { address: 'mint', name: 'Name', symbol: 'SYM' },
    ...over,
  };
}

describe('parseTokens', () => {
  it('returns nothing when the index answers with no pairs', () => {
    expect(parseTokens({}, '', 20)).toEqual([]);
    expect(parseTokens(null, '', 20)).toEqual([]);
    expect(parseTokens({ pairs: 'nope' }, '', 20)).toEqual([]);
  });

  it('reads a token off a pair', () => {
    const tokens = parseTokens(
      { pairs: [pair({ baseToken: { address: 'a', name: 'Axon', symbol: 'AXON' } })] },
      'axon',
      20,
    );
    expect(tokens).toEqual([{ mint: 'a', name: 'Axon', symbol: 'AXON', image: null }]);
  });

  it('keeps name and symbol matches but not address-substring noise', () => {
    // The index returns a token whose mint contains the query but whose name
    // and symbol do not; it should not surface for that search.
    const tokens = parseTokens(
      {
        pairs: [
          pair({ baseToken: { address: 'Cz7axonXx', name: 'Unrelated', symbol: 'UNREL' } }),
          pair({ baseToken: { address: 'real', name: 'Axon Protocol', symbol: 'AXON' } }),
        ],
      },
      'axon',
      20,
    );
    expect(tokens.map((t) => t.mint)).toEqual(['real']);
  });

  it('drops pairs that are not on solana', () => {
    const tokens = parseTokens(
      {
        pairs: [
          pair({ chainId: 'ethereum', baseToken: { address: 'eth', name: 'E', symbol: 'E' } }),
          pair({ baseToken: { address: 'sol', name: 'S', symbol: 'S' } }),
        ],
      },
      '',
      20,
    );
    expect(tokens.map((t) => t.mint)).toEqual(['sol']);
  });

  it('collapses a token that has many pairs into one', () => {
    const tokens = parseTokens(
      {
        pairs: [
          pair({ dexId: 'raydium', baseToken: { address: 'x', name: 'X', symbol: 'X' } }),
          pair({ dexId: 'meteora', baseToken: { address: 'x', name: 'X', symbol: 'X' } }),
        ],
      },
      '',
      20,
    );
    expect(tokens).toHaveLength(1);
  });

  it('puts pump.fun venues ahead of the rest', () => {
    const tokens = parseTokens(
      {
        pairs: [
          pair({ dexId: 'raydium', baseToken: { address: 'ray', name: 'R', symbol: 'R' } }),
          pair({ dexId: 'pumpswap', baseToken: { address: 'ps', name: 'P', symbol: 'P' } }),
          pair({ dexId: 'pumpfun', baseToken: { address: 'pf', name: 'F', symbol: 'F' } }),
        ],
      },
      '',
      20,
    );
    // pump.fun and pumpswap first (in the order seen), then the rest.
    expect(tokens.map((t) => t.mint)).toEqual(['ps', 'pf', 'ray']);
  });

  it('honors the limit', () => {
    const pairs = Array.from({ length: 30 }, (_, i) =>
      pair({ baseToken: { address: `m${i}`, name: 'N', symbol: 'N' } }),
    );
    expect(parseTokens({ pairs }, '', 5)).toHaveLength(5);
  });

  it('takes an image when the index carries one', () => {
    const tokens = parseTokens({ pairs: [pair({ info: { imageUrl: 'https://img/x.png' } })] }, '', 20);
    expect(tokens[0]!.image).toBe('https://img/x.png');
  });
});
