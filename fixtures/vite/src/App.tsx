import { useState } from "react";
import { createPortal } from "react-dom";
import { ProofCard } from "./components/ProofCard";

export function App() {
  const [clicks, setClicks] = useState(0);
  const [authenticated, setAuthenticated] = useState(document.cookie.includes("mauxi-proof-auth=1"));
  const [submissions, setSubmissions] = useState(0);
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
      <section aria-label="Workspace interaction fixture">
        <h2>Navigation and input</h2>
        <label>Persistent note <input aria-label="Persistent note" defaultValue="" /></label>
        <nav aria-label="Fixture routes">
          <a href="/details?view=wide#overview" onClick={(event) => { event.preventDefault(); history.pushState({ private: "never mirror me" }, "", event.currentTarget.href); }}>Client route</a>{" · "}
          <a href="/document">Document route</a>{" · "}
          <a href="/auth/callback?code=private">Auth callback</a>{" · "}
          <a href="https://example.com/">External route</a>
        </nav>
        <form onSubmit={(event) => { event.preventDefault(); setSubmissions((value) => value + 1); void fetch("/side-effect", { method: "POST", body: "fixture only" }); history.pushState(null, "", "/submitted"); }}>
          <button type="submit">Submit once</button><output data-testid="submit-count">Submissions: {submissions}</output>
        </form>
        <form id="native-route-form" action="/native-result" method="get">
          <input name="choice" defaultValue="one" aria-label="Native form choice" />
          <button type="submit">Native form</button>
          <button type="button" onClick={(event) => event.currentTarget.form!.submit()}>Native submit()</button>
          <button type="button" onClick={(event) => event.currentTarget.form!.requestSubmit()}>Request submit</button>
        </form>
        <button type="button" onClick={() => history.pushState(null, "", "/after-form")}>Independent router navigation</button>
      </section>
      {createPortal(<aside className="portal-note" data-testid="portal-target">Portal-rendered status</aside>, document.getElementById("portal")!)}
    </main>
  );
}
