import { cookies } from "next/headers";
import Link from "next/link";
import { ProofCard } from "./components/ProofCard";

export default async function Page() {
  const cookieStore = await cookies();
  const authenticated = cookieStore.get("mauxi-next-auth")?.value === "1";
  return (
    <main>
      <header className="sticky"><span>Next.js App Router · Webpack</span><span>Server → client boundary</span></header>
      <section className="hero"><p className="eyebrow">SERVER COMPONENT</p><h1>App Router source proof</h1><p>This heading is rendered by a server component. The interactive target below crosses into a client component.</p></section>
      <ProofCard initialAuthenticated={authenticated} />
      <nav aria-label="Fixture routes"><Link href="/?view=linked" prefetch={false}>Next client route</Link></nav>
      <div className="scroll-box"><div className="scroll-inner"><strong>Streaming-ready layout</strong><button data-testid="next-scrolled-target">Nested scroll target</button></div></div>
    </main>
  );
}
