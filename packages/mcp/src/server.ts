// The shebang is added by the bundler (see build.mjs).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createTools } from './tools';

/**
 * The Probatio MCP server.
 *
 * Gives an agent the same reach the SDK does: read a trader's record and check
 * it against the chain, so it can vet or back a trader on proof rather than on a
 * leaderboard's word. Speaks over stdio; point an MCP client at `probatio-mcp`.
 *
 * The default instance and RPC come from PROBATIO_API and PROBATIO_RPC; a
 * verify_record call may also carry its own rpc.
 */

const tools = createTools({
  apiBase: process.env['PROBATIO_API'],
  rpc: process.env['PROBATIO_RPC'],
});

type ToolResult = { content: { type: 'text'; text: string }[] };

function asText(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'probatio', version: '0.1.0' });

/**
 * Register a tool through a narrowed view of `server.tool`.
 *
 * The SDK's `tool` overload infers a type across the zod shape that, under this
 * repo's strict settings, is deep enough to trip the compiler's instantiation
 * limit. The runtime is unaffected; this just hands it a plain signature so the
 * inference does not run away.
 */
const register = server.tool.bind(server) as unknown as (
  name: string,
  description: string,
  shape: z.ZodRawShape,
  handler: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>,
) => void;

register(
  'verify_record',
  "Verify a trader's Probatio record against Solana. Rebuilds their committed " +
    'trades, folds the accumulator, and compares it to the one on chain. Returns ' +
    'verified plus every check. Needs an rpc, in the call or from PROBATIO_RPC.',
  { wallet: z.string(), rpc: z.string().optional(), season: z.number().int().optional() },
  async (args) =>
    asText(
      await tools.verifyRecord(args as { wallet: string; rpc?: string; season?: number }),
    ),
);

register(
  'get_record',
  "A trader's public record: name, the seasons they traded, and where to prove it.",
  { wallet: z.string() },
  async (args) => asText(await tools.getRecord(args as { wallet: string })),
);

register(
  'get_standings',
  'The standings of a season, or the current one when none is named.',
  { season: z.number().int().optional(), limit: z.number().int().optional() },
  async (args) => asText(await tools.getStandings(args as { season?: number; limit?: number })),
);

register(
  'get_proof',
  'The raw inputs to check a record: every committed trade, its batch, and the ' +
    'roots. What verify_record recomputes from.',
  { wallet: z.string(), season: z.number().int().optional() },
  async (args) => asText(await tools.getProof(args as { wallet: string; season?: number })),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
