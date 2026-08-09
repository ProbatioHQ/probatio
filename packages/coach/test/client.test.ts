import { describe, expect, it, vi } from 'vitest';
import type { Brief } from '../src/brief';
import { CoachError, DEFAULT_MODEL, requestReport } from '../src/client';

const brief: Brief = {
  facts: [
    { key: 'winRateBps', label: 'Win rate', value: '38.0% (19 of 50)' },
    { key: 'netPnl', label: 'Net profit and loss', value: '-2.340 SOL' },
  ],
  tradeCount: 50,
  sufficient: true,
  minimumTrips: 5,
};

const GOOD_REPLY = JSON.stringify({
  headline: 'You lose more often than you win.',
  observations: [{ metric: 'winRateBps', text: 'Under half your trades work out.' }],
  focus: 'Take fewer, better setups.',
});

function reply(text: string, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 400, output_tokens: 120 },
      }),
      { status, headers: { 'content-type': 'application/json' } },
    ),
  ) as unknown as typeof fetch;
}

describe('calling the coach', () => {
  it('returns a checked report', async () => {
    const result = await requestReport(brief, { apiKey: 'k', fetchImpl: reply(GOOD_REPLY) });

    expect(result.report?.headline).toBe('You lose more often than you win.');
    expect(result.model).toBe(DEFAULT_MODEL);
    expect(result.inputTokens).toBe(400);
    expect(result.outputTokens).toBe(120);
  });

  it('sends the key and version the API expects', async () => {
    const fetchImpl = reply(GOOD_REPLY);
    await requestReport(brief, { apiKey: 'secret', fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.messages[0].content).toContain('winRateBps');
  });

  it('honours a model override', async () => {
    const fetchImpl = reply(GOOD_REPLY);
    await requestReport(brief, { apiKey: 'k', model: 'claude-haiku-4-5-20251001', fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init.body as string).model).toBe('claude-haiku-4-5-20251001');
  });

  it('checks the reply rather than trusting it', async () => {
    const result = await requestReport(brief, {
      apiKey: 'k',
      fetchImpl: reply(
        JSON.stringify({
          headline: 'You lose more often than you win.',
          observations: [{ metric: 'winRateBps', text: 'You are down 9.9 SOL on this.' }],
          focus: 'Trade less.',
        }),
      ),
    });

    // The call succeeded and the content still did not survive checking.
    expect(result.report).toBeNull();
    expect(result.problems.join(' ')).toContain('9.9 SOL');
  });
});

describe('when the call goes wrong', () => {
  it('reports an HTTP failure with its status', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;

    await expect(requestReport(brief, { apiKey: 'k', fetchImpl })).rejects.toMatchObject({
      code: 'http',
      status: 429,
    });
  });

  it('reports a network failure as such', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    await expect(requestReport(brief, { apiKey: 'k', fetchImpl })).rejects.toBeInstanceOf(CoachError);
  });

  it('gives up rather than hanging', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: { signal?: AbortSignal } = {}) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    await expect(
      requestReport(brief, { apiKey: 'k', fetchImpl, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('treats an empty reply as a failure, not an empty report', async () => {
    await expect(requestReport(brief, { apiKey: 'k', fetchImpl: reply('   ') })).rejects.toMatchObject({
      code: 'empty',
    });
  });

  it('survives a reply with no content blocks', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(requestReport(brief, { apiKey: 'k', fetchImpl })).rejects.toMatchObject({
      code: 'empty',
    });
  });
});
