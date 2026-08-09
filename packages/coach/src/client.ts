import type { Brief } from './brief';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt';
import { reviewResponse, type ReviewResult } from './review';

/**
 * The one call.
 *
 * `fetch` is injectable so every test here runs offline. A coaching feature
 * whose tests need an API key is a coaching feature nobody can change safely.
 */

export const DEFAULT_MODEL = 'claude-sonnet-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export interface CoachOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class CoachError extends Error {
  readonly code: 'http' | 'timeout' | 'network' | 'empty';
  readonly status?: number;

  constructor(message: string, code: CoachError['code'], status?: number) {
    super(message);
    this.name = 'CoachError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface CoachResponse extends ReviewResult {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export async function requestReport(
  brief: Brief,
  options: CoachOptions,
): Promise<CoachResponse> {
  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 1_024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(brief) }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new CoachError(
      aborted ? 'the coach took too long to answer' : 'could not reach the coach',
      aborted ? 'timeout' : 'network',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new CoachError(
      `the coach returned ${response.status}`,
      'http',
      response.status,
    );
  }

  const body = (await response.json()) as {
    content?: { type?: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = (body.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');

  if (text.trim() === '') {
    throw new CoachError('the coach returned nothing', 'empty');
  }

  return {
    ...reviewResponse(text, brief),
    model,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  };
}
