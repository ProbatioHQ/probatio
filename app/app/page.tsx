import { LaunchFeedList } from '@/components/launch-feed';
import { Onboarding } from '@/components/onboarding';
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
      <LaunchFeedList />
    </main>
  );
}
