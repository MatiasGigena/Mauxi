import { useState } from "react";
import { createPortal } from "react-dom";
import { ProofCard } from "./components/ProofCard";

export function App() {
  const [clicks, setClicks] = useState(0);
  const [authenticated, setAuthenticated] = useState(document.cookie.includes("mauxi-proof-auth=1"));
  function signIn() {
    document.cookie = "mauxi-proof-auth=1; Path=/; SameSite=Lax";
    setAuthenticated(true);
  }
  return (
    <main>
      <header className="sticky"><span>React + Vite fixture</span><output data-testid="viewport">{innerWidth} × {innerHeight}</output></header>
      <section className="hero">
        <p className="eyebrow">LIVE PREVIEW</p>
        <h1>Source-linked canvas proof</h1>
        <p>Nested targets, responsive layout, scrolling, a portal and local cookie state.</p>
      </section>
      <section className="grid">
        <ProofCard clicks={clicks} onAction={() => setClicks((value) => value + 1)} />
        <article className="card auth-card">
          <span className="status-dot" />
          <h2>Local session</h2>
          <p data-testid="auth-state">{authenticated ? "Authenticated locally" : "Signed out"}</p>
          <button onClick={signIn}>Use local test account</button>
        </article>
      </section>
      <div className="scroll-box"><div className="scroll-inner"><strong>Nested scroll target</strong><button data-testid="scrolled-target">Inspect inside scroller</button></div></div>
      {createPortal(<aside className="portal-note" data-testid="portal-target">Portal-rendered status</aside>, document.getElementById("portal")!)}
    </main>
  );
}
