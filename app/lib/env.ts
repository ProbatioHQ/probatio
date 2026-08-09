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
