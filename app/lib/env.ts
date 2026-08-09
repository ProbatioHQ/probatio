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
