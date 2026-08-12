import 'server-only';

/**
 * Required configuration, read once and validated loudly.
 *
 * A missing session secret does not degrade gracefully — it means every session
 * token is forgeable. Failing at first use is the only safe behaviour.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy app/.env.example to app/.env.local and fill it in.`,
    );
  }
  return value;
}

export function sessionSecret(): string {
  return required('SESSION_SECRET');
}

export function databaseUrl(): string {
  return required('DATABASE_URL');
}

/**
 * The domain the sign-in message is bound to.
 *
 * This is read from configuration rather than from the incoming request, so a
 * request arriving with a forged Host header cannot get a user to sign a
 * message naming someone else's site.
 */
export function appDomain(): string {
  return required('APP_DOMAIN');
}

export function appUri(): string {
  return required('APP_URI');
}

/**
 * The Solana endpoint every chain read goes through.
 *
 * Falls back to the public cluster so a fresh checkout runs, but that endpoint
 * rate-limits hard and is not suitable for anything beyond trying the app out.
 */
export function rpcEndpoint(): string {
  return process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
}

/**
 * Whether a dedicated RPC is configured, rather than the public cluster.
 *
 * The two behave nothing alike under load. The public endpoint rate-limits a
 * burst of transaction reads so hard that a token's history takes minutes to
 * walk or never finishes, which is why a freshly opened chart shows a handful
 * of candles. A paid endpoint serves the same burst in seconds. So the reads
 * that walk history are gentle and shallow on the public cluster and fast and
 * deep on a dedicated one, chosen from this rather than from a flag nobody
 * remembers to set. Anything that is not the public host counts as dedicated.
 */
export function hasDedicatedRpc(): boolean {
  const url = process.env['RPC_URL'];
  return typeof url === 'string' && url.length > 0 && !url.includes('api.mainnet-beta.solana.com');
}

/**
 * The key the coach calls with.
 *
 * Optional, unlike the rest. The simulator, the chart and the on-chain record
 * all work without it — the coach is the one feature that degrades to "not
 * configured" rather than taking the server down at boot.
 */
export function coachApiKey(): string | null {
  return process.env['ANTHROPIC_API_KEY'] ?? null;
}

/** Overrides the coach's model. Unset uses the package default. */
export function coachModel(): string | null {
  return process.env['COACH_MODEL'] ?? null;
}

/**
 * The address entry fees are paid to.
 *
 * Optional, so the app runs without it — but every payment route refuses while
 * it is unset rather than falling back to anything. There is no sensible
 * default for where money goes.
 */
export function treasuryAddress(): string | null {
  return process.env['TREASURY_ADDRESS'] ?? null;
}
