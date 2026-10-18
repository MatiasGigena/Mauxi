import { PricingTable } from "./PricingTable";

const origins = ["Huila", "Sidamo", "Antigua", "Yirgacheffe", "Cerrado", "Tarrazú"];
const partners = ["Lumen", "Okra", "Fable & Co", "Northbeam", "Quill", "Arbor", "Tidal"];

export function AuditLab() {
  return (
    <div className="lab">
      {/* Planted: sticky header that grows at narrow widths (2.4.11 at 400% zoom). */}
      <header className="lab-header" data-testid="lab-header">
        <strong className="lab-logo">Northwind Roasters</strong>
        <nav className="lab-nav" aria-label="Primary">
          <a href="#beans">Beans</a><a href="#subscriptions">Subscriptions</a><a href="#wholesale">Wholesale</a><a href="#journal">Journal</a><a href="#visit">Visit us</a>
        </nav>
        {/* Planted: tiny adjacent icon targets (2.5.8). */}
        <div className="lab-icons">
          <button type="button" aria-label="Search" data-testid="icon-search">⌕</button>
          <button type="button" aria-label="Account" data-testid="icon-account">◉</button>
          <button type="button" aria-label="Cart" data-testid="icon-cart">◍</button>
        </div>
      </header>

      {/* Not a finding: off-canvas drawer kept hidden outside the viewport. */}
      <aside className="lab-drawer" aria-hidden="true" data-testid="offcanvas-drawer"><a href="#beans" tabIndex={-1}>Beans</a></aside>
      {/* Not a finding: visually hidden helper text. */}
      <span className="sr-only">Skip to content</span>

      <main>
        <section className="lab-hero">
          <p className="lab-eyebrow">Single origin · roasted Tuesdays</p>
          <h1>Coffee that tastes like where it grew.</h1>
          {/* Planted: unbreakable string overflowing at narrow widths. */}
          <p className="lab-ref" data-testid="tracking-link">Track your order: https://northwind.example/orders/tracking/NW-2026-ESPRESSO-BLEND-000123456789</p>
        </section>

        {/* Not a finding: deliberate, keyboard-reachable carousel with scroll snapping. */}
        <section className="lab-section" id="beans">
          <h2>This week’s beans</h2>
          <div className="origin-carousel" role="region" aria-label="This week's beans" tabIndex={0} data-testid="origin-carousel">
            {origins.map((origin) => <article className="origin-card" key={origin}><h3>{origin}</h3><p>Notes of stone fruit, cacao and honey.</p></article>)}
          </div>
        </section>

        {/* Planted: intentional marquee-style rail with no keyboard access. */}
        <section className="lab-section">
          <h2>Served by</h2>
          <div className="partner-rail" data-testid="partner-rail">
            {partners.map((partner) => <span className="partner" key={partner}>{partner}</span>)}
          </div>
        </section>

        <section className="lab-section" id="subscriptions">
          <h2>Subscriptions</h2>
          <PricingTable />
        </section>

        {/* Planted: filter row that scrolls by accident at narrow widths. */}
        <section className="lab-section">
          <div className="filter-row" data-testid="filter-row">
            <span>Roast: medium-dark</span><span>Grind: whole bean</span><span>Ships: every two weeks</span><span>Bag: 340 g</span>
          </div>
        </section>

        {/* Not a finding: data table inside a focusable scroll wrapper. */}
        <section className="lab-section" id="wholesale">
          <h2>Wholesale price list</h2>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Wholesale prices" data-testid="price-table">
            <table>
              <thead><tr><th>Origin</th><th>Process</th><th>Altitude</th><th>1 kg</th><th>5 kg</th><th>20 kg</th><th>Availability</th></tr></thead>
              <tbody>{origins.map((origin, index) => <tr key={origin}><td>{origin}</td><td>Washed</td><td>{1600 + index * 80} m</td><td>$24</td><td>$110</td><td>$410</td><td>In stock</td></tr>)}</tbody>
            </table>
          </div>
        </section>

        {/* Planted: three columns that only overflow between two breakpoints. */}
        <section className="lab-section lab-features" data-testid="feature-grid">
          <article><h3>Roasted to order</h3><p>Every bag ships within 48 hours of roasting.</p></article>
          <article><h3>Direct trade</h3><p>We pay growers 40% above fair-trade minimums.</p></article>
          <article><h3>Compostable bags</h3><p>Plant-based liners, recyclable valves.</p></article>
        </section>

        {/* Planted: fixed-height promo that clips once text spacing increases (1.4.12). */}
        <section className="lab-section">
          <div className="promo" data-testid="promo-card"><p>Free shipping over $40. Use code BREW.</p></div>
        </section>
      </main>

      {/* Planted: fixed cookie bar adding to the covered area at short viewports. */}
      <div className="cookie-bar" role="dialog" aria-label="Cookie notice" data-testid="cookie-bar">We use cookies to remember your grind. <button type="button">OK</button></div>
    </div>
  );
}
