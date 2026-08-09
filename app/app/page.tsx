import { Coach } from '@/components/coach';
import { LaunchFeedList } from '@/components/launch-feed';
import { Leaderboard } from '@/components/leaderboard';
import { NameClaim } from '@/components/name-claim';
import { Onboarding } from '@/components/onboarding';
import { Season } from '@/components/season';
import { SignIn } from '@/components/sign-in';

export default function Home() {
  return (
    <main>
      <h1>Probatio</h1>
      <p>
        Trade live Solana markets with practice money, against fills that model real slippage and
        real delay. Every trade is written to the chain as you make it, so your record cannot be
        edited afterwards.
      </p>

      <SignIn />
      <Onboarding />
      <Season />
      <Leaderboard />
      <Coach />
      <NameClaim />
      <LaunchFeedList />
      <p>
        <a href="/verify">Check any record yourself</a>
      </p>
    </main>
  );
}
