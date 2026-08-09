import { SignIn } from '@/components/sign-in';

/**
 * A holding page. The real interface arrives with the trade UI — this exists so
 * wallet auth can be exercised end to end.
 */
export default function Home() {
  return (
    <main>
      <h1>Probatio</h1>
      <p>A proving ground for traders.</p>
      <SignIn />
    </main>
  );
}
