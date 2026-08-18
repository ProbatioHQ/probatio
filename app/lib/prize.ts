import 'server-only';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { RpcClient } from '@probatio/pools';
import { compileMessage, encodeCompactU16, encodeMessage, transferInstruction } from '@probatio/payments';
import { parseSecretKey } from './season-onchain';

/**
 * The wallet that holds the prize pot and pays the winners.
 *
 * Entry fees are transferred into it, and when a season ends the payout worker
 * sends each winner their share straight out of it. It is a hot wallet by
 * necessity: the server has to be able to sign the payouts without anybody
 * present. Keep only the pot in it, not a treasury; store revenue goes
 * elsewhere.
 */

export interface PrizeWallet {
  readonly secret: Uint8Array;
  readonly publicKey: string;
}

/** The prize wallet, or null when the operator has not configured one. */
export function prizeWallet(): PrizeWallet | null {
  const configured = process.env['PRIZE_KEYPAIR'];
  if (!configured) return null;
  try {
    const secret = parseSecretKey(configured);
    if (secret.length !== 64) {
      console.error('[prize] PRIZE_KEYPAIR is not a 64-byte keypair');
      return null;
    }
    return { secret, publicKey: bs58.encode(ed25519.getPublicKey(secret.subarray(0, 32))) };
  } catch (error) {
    console.error('[prize] PRIZE_KEYPAIR is set but could not be read', error);
    return null;
  }
}

/** The address entry fees are paid to, or null when no prize wallet is set. */
export function prizeAddress(): string | null {
  return prizeWallet()?.publicKey ?? null;
}

/** Send one winner their prize from the pot. Returns the transaction signature. */
export async function sendPayout(
  rpc: RpcClient,
  wallet: PrizeWallet,
  to: string,
  lamports: bigint,
): Promise<string> {
  const { blockhash } = await rpc.getLatestBlockhash();
  const instruction = transferInstruction(wallet.publicKey, to, lamports);
  const message = encodeMessage(compileMessage(wallet.publicKey, blockhash, [instruction]));
  const signature = ed25519.sign(message, wallet.secret.subarray(0, 32));

  const transaction = new Uint8Array(1 + 64 + message.length);
  transaction.set(encodeCompactU16(1), 0);
  transaction.set(signature, 1);
  transaction.set(message, 65);

  const sent = await rpc.sendTransaction(Buffer.from(transaction).toString('base64'));
  const settled = await rpc.confirmSignature(sent, { timeoutMs: 60_000 });
  if (!settled.confirmed) {
    throw new Error(
      settled.err ? `payout failed on chain: ${JSON.stringify(settled.err)}` : `payout ${sent} did not confirm`,
    );
  }
  return sent;
}

/**
 * Whether a season could actually pay, for the health endpoint.
 *
 * Both of these are configured by environment variable and both do nothing at
 * all when unset: the keeper commits no trades, and the payout worker pays no
 * winners. Neither failure announces itself, so a season can be opened, entered
 * and traded under the impression that records are landing and prizes will be
 * paid when neither is true. Reported so it can be seen before anybody pays to
 * enter, and it names only whether a key is present, never the key.
 */
export function seasonReadiness(): {
  prizeWallet: string | null;
  keeperConfigured: boolean;
} {
  return {
    prizeWallet: prizeAddress(),
    keeperConfigured: Boolean(process.env['KEEPER_KEYPAIR']),
  };
}
