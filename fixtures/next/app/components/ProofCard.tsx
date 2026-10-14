"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ProofCard({ initialAuthenticated }: { initialAuthenticated: boolean }) {
  const [clicks, setClicks] = useState(0);
  const router = useRouter();

  async function signIn() { await fetch("/api/auth", { method: "POST" }); router.refresh(); }

  return (
    <section className="grid">
      <article className="card proof-card">
        <div><span className="badge">Known nested target</span><h2>Hydrated client island</h2><p>Selection must resolve this exact JSX, not only the server caller.</p></div>
        <button className="primary" data-testid="known-target" onClick={() => setClicks((value) => value + 1)} aria-label="Increment Next proof counter">
          <svg data-testid="known-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M10 4l6 6-6 6" /></svg><span>Run action</span>
        </button>
        <output data-testid="click-count">Underlying clicks: {clicks}</output>
      </article>
      <article className="card"><span className="status-dot" /><h2>Server cookie</h2><p data-testid="auth-state">{initialAuthenticated ? "Authenticated on server" : "Signed out"}</p><button onClick={signIn}>Use local test account</button></article>
    </section>
  );
}
