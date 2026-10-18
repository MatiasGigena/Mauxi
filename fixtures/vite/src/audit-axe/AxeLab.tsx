const photo = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#cfe3ea"/><circle cx="180" cy="250" r="70" fill="none" stroke="#173b4a" stroke-width="14"/><circle cx="460" cy="250" r="70" fill="none" stroke="#173b4a" stroke-width="14"/><path d="M180 250 280 140h120l60 110M280 140l50 110h-150" fill="none" stroke="#c4512b" stroke-width="14"/></svg>')}`;
const divider = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 8"><path d="M0 4h400" stroke="#d6dde1" stroke-width="2" stroke-dasharray="6 6"/></svg>')}`;

const Icon = ({ path }: { path: string }) => <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22"><path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;

export function AxeLab() {
  return (
    <div className="axe-lab">
      <header className="axe-header">
        <strong className="axe-logo">Harbor Bikes</strong>
        {/* Planted: icon-only menu toggle, shown only below 600px, with no accessible name (4.1.2). */}
        <button type="button" className="axe-mobile-only axe-icon" data-testid="menu-toggle"><Icon path="M4 7h16M4 12h16M4 17h16" /></button>
        {/* Not a finding: icon-only search toggle, shown only below 600px, named with aria-label. */}
        <button type="button" className="axe-mobile-only axe-icon" aria-label="Search" data-testid="search-toggle"><Icon path="M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm5-2 4 4" /></button>
        <nav className="axe-nav" aria-label="Primary"><a href="#bikes">Bikes</a><a href="#service">Service</a><a href="#rentals">Rentals</a></nav>
        {/* Planted: icon-only social link, shown only from 1024px, with no accessible name (2.4.4 / 4.1.2). */}
        <a className="axe-wide-only axe-icon" href="#instagram" data-testid="social-link"><Icon path="M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm5 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" /></a>
      </header>

      <main>
        <section className="axe-hero">
          <h1>Bikes built for the harbor wind.</h1>
          {/* Planted: tagline that drops to low contrast only in the mobile layout (1.4.3). */}
          <p className="axe-tagline" data-testid="mobile-tagline">Hand-tuned in our workshop since 1987.</p>
          {/* Planted: informative photo without alt text, at every width (1.1.1). */}
          <img className="axe-photo" src={photo} width={640} height={360} data-testid="hero-photo" />
          {/* Not a finding: decorative divider with empty alt. */}
          <img className="axe-divider" src={divider} alt="" data-testid="decorative-divider" />
        </section>

        <section className="axe-section" id="bikes" aria-labelledby="bikes-title">
          <h2 id="bikes-title">This season</h2>
          {/* Not a finding: large text at 3.5:1 passes the 3:1 large-text threshold. */}
          <p className="axe-large" data-testid="large-text">Spring service: 20% off</p>
          {/* Not a finding: disabled controls are exempt from contrast. */}
          <button type="button" className="axe-sold-out" disabled data-testid="sold-out">Sold out</button>
          {/* Planted for review: text on a gradient, where axe-core cannot compute contrast. */}
          <p className="axe-banner" data-testid="gradient-banner">Free test rides every Saturday.</p>
        </section>

        {/* Not a finding: closed drawer with faint text is not rendered. */}
        <div className="axe-drawer" hidden data-testid="hidden-drawer"><a href="#bikes">Hidden faint link</a></div>
      </main>

      <footer className="axe-footer"><p>Harbor Bikes · Pier 4 · <a href="#visit">Visit the workshop</a></p></footer>
    </div>
  );
}
