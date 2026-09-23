import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { ProofCard } from "../components/ProofCard";

async function DelayedCard() {
  await connection();
  await new Promise(resolve => setTimeout(resolve, 1500));
  return <div data-testid="streamed-content"><ProofCard initialAuthenticated={false} /></div>;
}

export default function StreamingPage() {
  return (
    <main>
      <h1>Delayed server stream</h1>
      <Link href="/" prefetch={false}>Return to fixture</Link>
      <Suspense fallback={<p data-testid="streaming-fallback">Waiting for the server card…</p>}>
        <DelayedCard />
      </Suspense>
    </main>
  );
}
