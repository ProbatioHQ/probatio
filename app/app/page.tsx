import { Coach } from '@/components/coach';
import { LaunchFeedList } from '@/components/launch-feed';
import { Leaderboard } from '@/components/leaderboard';
import { NameClaim } from '@/components/name-claim';
import { Onboarding } from '@/components/onboarding';
import { Season } from '@/components/season';
import { SignIn } from '@/components/sign-in';

/**
 * The front page.
 *
 * Ordered by what a stranger needs in the order they need it: what this is,
 * proof it is real, then the thing to actually do. The token list comes last
 * because it is the widest surface and reads as noise before the sentence that
 * explains why the prices matter.
 *
 * Everything below the first block hides itself when it has nothing to say, so
 * a signed-out visitor is not shown a row of empty panels.
 */
export default function Home() {
  return (
    <main>
      <section className="prose" style={{ gap: 18, paddingTop: 24 }}>
        <h1>Trade fake money on real tokens. Prove you&apos;re good.</h1>
        <p style={{ fontSize: 17 }}>
          Live pump.fun markets, practice money, and fills that model real slippage and real
          delay — so a win here is a win you could have had. Every trade is written to Solana as
          you make it, which means your record cannot be edited afterwards without replacing the
          program on chain, and that is a public act anyone can see.
        </p>
        <p>
          <a href="/trust">What you still have to trust</a> ·{' '}
          <a href="/verify">Check any record yourself</a>
        </p>
        <SignIn />
      </section>

      <Onboarding />
      <Season />
      <Leaderboard />
      <Coach />
      <NameClaim />
      <LaunchFeedList />
    </main>
  );
}
