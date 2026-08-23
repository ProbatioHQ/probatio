import 'server-only';
import { Limiter, POLICIES, callerKey, clientAddress, type PolicyName } from '@probatio/limits';
import { currentUser } from './session';

/**
 * The rate limit, applied at the top of a route.
 *
 * A helper rather than middleware, on purpose. Middleware would have to guess
 * which policy a route needs from its path, and a policy chosen by path is
 * wrong the first time a route changes what it does. Here the route names its
 * own cost, which is the thing that actually determines the limit.
 *
 * Limits are per process. Running two instances doubles every number, and that
 * is a real weakness rather than a detail — it is written down here, in
 * `@probatio/limits`, and in the downtime notes, so nobody has to rediscover it
 * during an incident.
 */

const limiters = new Map<PolicyName, Limiter>();

function limiterFor(policy: PolicyName): Limiter {
  let limiter = limiters.get(policy);
  if (!limiter) {
    limiter = new Limiter({ rule: POLICIES[policy] });
    limiters.set(policy, limiter);
  }
  return limiter;
}

/** Proxies in front of this server. Wrong in either direction is bad; see the package. */
function trustedProxies(): number {
  const configured = Number(process.env['TRUSTED_PROXIES'] ?? '1');
  return Number.isFinite(configured) && configured >= 0 ? configured : 1;
}

export interface LimitResult {
  /** A 429 to return immediately, or null to carry on. */
  readonly response: Response | null;
  readonly key: string;
}

export async function rateLimit(
  request: Request,
  policy: PolicyName,
  cost = 1,
  /**
   * Who this is, when the caller already knows better than a cookie can say.
   *
   * The session is how a browser identifies itself and a program has no session,
   * so a request carrying an API key fell through to being counted by network
   * address. Two people running bots from one office, or from one cloud
   * provider's range, would then have shared a bucket and throttled each other,
   * while the key in the header named the wallet exactly. Passed in rather than
   * looked up here, because only the route knows whether it has authenticated
   * the request yet.
   */
  identity?: string,
): Promise<LimitResult> {
  // Identifying the caller by wallet where possible: two traders behind one
  // connection are two callers, and one wallet moving networks is still one.
  const user = identity ? null : await currentUser().catch(() => null);
  const address = clientAddress(request.headers, { trustedProxies: trustedProxies() });
  const key = callerKey(identity ?? user?.pubkey ?? null, address);

  const decision = limiterFor(policy).check(key, Date.now(), cost);
  if (decision.allowed) return { response: null, key };

  const seconds = Math.ceil(decision.retryAfterMs / 1_000);
  return {
    key,
    response: Response.json(
      { error: `Too many requests. Try again in ${seconds}s.`, retryAfterMs: decision.retryAfterMs },
      {
        status: 429,
        headers: {
          // Seconds, per the spec, even though the body carries milliseconds.
          'retry-after': String(seconds),
          'x-ratelimit-remaining': String(decision.remaining),
        },
      },
    ),
  };
}

/** For tests and for a deploy that needs a clean slate. */
export function resetLimiters(): void {
  for (const limiter of limiters.values()) limiter.clear();
}
