import type { Metadata } from 'next';
import { LinkTelegram } from '@/components/link-telegram';

export const metadata: Metadata = {
  title: 'Link Telegram, Probatio',
  description: 'Connect a Telegram account to your Probatio account, so both trade the same record.',
};

/**
 * The site half of linking Telegram.
 *
 * It is here rather than in the bot because only this side can prove which
 * wallet somebody holds. Telegram knows who is typing and nothing else, so a
 * bot that accepted a pasted address would let anybody claim anybody's record.
 * Signing in is the proof, and the code is only what carries the claim across.
 */
export default function LinkPage() {
  return (
    <main>
      <div className="page-head">
        <h1>Link Telegram</h1>
        <p className="dim">
          Message the bot, send it <code>/link</code>, and it will give you a code. Sign in here
          with the wallet you trade on and enter it below. Both sides then trade the same account:
          the same balance, the same positions, the same record.
        </p>
      </div>

      <LinkTelegram />

      <p className="dim" style={{ fontSize: 13 }}>
        A code is worth having, so do not post one anywhere. Anybody holding it can attach their
        Telegram to your account until it expires. You can disconnect at any time by sending the
        bot <code>/unlink</code>, and nothing about your record changes when you do.
      </p>
    </main>
  );
}
