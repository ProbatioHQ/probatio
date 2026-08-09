import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { LaunchFeed, type LogNotification } from '../src/launches';

/**
 * A real CreateEvent log line, built the way the program emits it, so these
 * tests exercise the same parsing path production uses.
 */
function createEventLog(options: {
  mint: string;
  name?: string;
  symbol?: string;
  uri?: string;
  timestamp?: number;
}): string {
  const name = Buffer.from(options.name ?? 'Test Token', 'utf8');
  const symbol = Buffer.from(options.symbol ?? 'TEST', 'utf8');
  const uri = Buffer.from(options.uri ?? 'https://ipfs.io/ipfs/abc', 'utf8');

  const parts: Buffer[] = [
    Buffer.from([0x1b, 0x72, 0xa9, 0x4d, 0xde, 0xeb, 0x63, 0x76]),
  ];
  for (const value of [name, symbol, uri]) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(value.length);
    parts.push(length, value);
  }

  const key = (address: string) => Buffer.from(bs58.decode(address));
  parts.push(key(options.mint));
  parts.push(key('FHeBR39zwYtUuXQFLbShSsVKkEG6ti5Eup3zUdopiegi'));
  parts.push(key('9oNfewPW6KSxbKbTUCQ3g7tc2gViCEYijc6TbDaumwg1'));
  parts.push(key('9oNfewPW6KSxbKbTUCQ3g7tc2gViCEYijc6TbDaumwg1'));

  const timestamp = Buffer.alloc(8);
  timestamp.writeBigInt64LE(BigInt(options.timestamp ?? 1_786_271_082));
  parts.push(timestamp);

  return `Program data: ${Buffer.concat(parts).toString('base64')}`;
}

const MINT_A = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';
const MINT_B = 'J5reXJehdCV86HPHg2ewbeGYfMkxQT2YmLcg4DVfpump';

function notification(logs: string[], overrides: Partial<LogNotification> = {}): LogNotification {
  return { signature: 'sig', slot: 100, err: null, logs, ...overrides };
}

describe('LaunchFeed', () => {
  it('extracts a launch', () => {
    const feed = new LaunchFeed();
    const launches = feed.ingest(notification([createEventLog({ mint: MINT_A })]));

    expect(launches).toHaveLength(1);
    expect(launches[0]!.mint).toBe(MINT_A);
    expect(launches[0]!.symbol).toBe('TEST');
    expect(launches[0]!.slot).toBe(100);
  });

  it('ignores unrelated log lines', () => {
    const feed = new LaunchFeed();
    const launches = feed.ingest(
      notification([
        'Program log: Instruction: Buy',
        'Program data: bm90IGFuIGV2ZW50',
        createEventLog({ mint: MINT_A }),
      ]),
    );
    expect(launches).toHaveLength(1);
  });

  it('skips a failed transaction', () => {
    // A reverted transaction created nothing, so advertising it would put a
    // token in the feed that does not exist.
    const feed = new LaunchFeed();
    const launches = feed.ingest(
      notification([createEventLog({ mint: MINT_A })], { err: { InstructionError: [0, 'Custom'] } }),
    );
    expect(launches).toEqual([]);
  });

  it('does not emit the same launch twice', () => {
    // A websocket that drops and resubscribes replays recent history.
    const feed = new LaunchFeed();
    const first = feed.ingest(notification([createEventLog({ mint: MINT_A })]));
    const replay = feed.ingest(notification([createEventLog({ mint: MINT_A })]));

    expect(first).toHaveLength(1);
    expect(replay).toEqual([]);
  });

  it('deduplicates within a single batch', () => {
    const feed = new LaunchFeed();
    const launches = feed.ingestMany([
      notification([createEventLog({ mint: MINT_A })]),
      notification([createEventLog({ mint: MINT_A })]),
      notification([createEventLog({ mint: MINT_B })]),
    ]);

    expect(launches.map((entry) => entry.mint)).toEqual([MINT_A, MINT_B]);
  });

  it('keeps different tokens separate', () => {
    const feed = new LaunchFeed();
    const launches = feed.ingest(
      notification([createEventLog({ mint: MINT_A }), createEventLog({ mint: MINT_B })]),
    );
    expect(launches).toHaveLength(2);
  });

  it('bounds how much it remembers', () => {
    // A long-running process must not accumulate every mint it has ever seen.
    const feed = new LaunchFeed(2);
    feed.ingest(notification([createEventLog({ mint: MINT_A })]));
    feed.ingest(notification([createEventLog({ mint: MINT_B })]));
    feed.ingest(notification([createEventLog({ mint: 'BepXrvvfoFohZBSRTLnesHMpjy7EkRjyUVAA39rZpump' })]));

    expect(feed.size).toBe(2);
    // The oldest was evicted, so it would be emitted again — which the
    // database then ignores. The two defences overlap on purpose.
    expect(feed.ingest(notification([createEventLog({ mint: MINT_A })]))).toHaveLength(1);
  });

  it('handles a notification with no logs', () => {
    expect(new LaunchFeed().ingest(notification([]))).toEqual([]);
  });

  it('refuses a nonsensical capacity', () => {
    expect(() => new LaunchFeed(0)).toThrow();
  });
});
