interface ProofCardProps { clicks: number; onAction(): void }

export function ProofCard({ clicks, onAction }: ProofCardProps) {
  return (
    <article className="card proof-card">
      <div className="card-copy"><span className="badge">Known nested target</span><h2>Precise selection</h2><p>The icon is nested inside a button with a real click handler.</p></div>
      <button className="primary" data-testid="known-target" onClick={onAction} aria-label="Increment proof counter">
        <svg data-testid="known-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M10 4l6 6-6 6" /></svg>
        <span>Run action</span>
      </button>
      <output data-testid="click-count">Underlying clicks: {clicks}</output>
    </article>
  );
}
