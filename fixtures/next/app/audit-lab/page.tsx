import type { Metadata, Viewport } from "next";
import { PricingTable } from "./PricingTable";
import styles from "./audit-lab.module.css";

export const metadata: Metadata = { title: "Audit lab · Northwind Roasters" };

// Planted: pinch-zoom blocked (1.4.4). Route-level viewport, so other fixture routes keep Next's default.
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1 };

const origins = ["Huila", "Sidamo", "Antigua", "Yirgacheffe", "Cerrado", "Tarrazú"];
const partners = ["Lumen", "Okra", "Fable & Co", "Northbeam", "Quill", "Arbor", "Tidal"];

export default function AuditLabPage() {
  return (
    <div className={styles.lab}>
      {/* Planted: sticky header that grows at narrow widths (2.4.11 at 400% zoom). */}
      <header className={styles["lab-header"]} data-testid="lab-header">
        <strong className={styles["lab-logo"]}>Northwind Roasters</strong>
        <nav className={styles["lab-nav"]} aria-label="Primary">
          <a href="#beans">Beans</a><a href="#subscriptions">Subscriptions</a><a href="#wholesale">Wholesale</a><a href="#journal">Journal</a><a href="#visit">Visit us</a>
        </nav>
        {/* Planted: tiny adjacent icon targets (2.5.8). */}
        <div className={styles["lab-icons"]}>
          <button type="button" aria-label="Search" data-testid="icon-search">⌕</button>
          <button type="button" aria-label="Account" data-testid="icon-account">◉</button>
          <button type="button" aria-label="Cart" data-testid="icon-cart">◍</button>
        </div>
      </header>

      {/* Not a finding: off-canvas drawer kept hidden outside the viewport. */}
      <aside className={styles["lab-drawer"]} aria-hidden="true" data-testid="offcanvas-drawer"><a href="#beans" tabIndex={-1}>Beans</a></aside>
      {/* Not a finding: visually hidden helper text. */}
      <span className={styles["sr-only"]} data-testid="sr-only-text">Skip to content</span>

      <main className={styles["lab-main"]}>
        <section className={styles["lab-hero"]}>
          <p className={styles["lab-eyebrow"]}>Single origin · roasted Tuesdays</p>
          <h1>Coffee that tastes like where it grew.</h1>
          {/* Planted: unbreakable string overflowing at narrow widths. */}
          <p className={styles["lab-ref"]} data-testid="tracking-link">Track your order: https://northwind.example/orders/tracking/NW-2026-ESPRESSO-BLEND-000123456789</p>
        </section>

        {/* Not a finding: deliberate, keyboard-reachable carousel with scroll snapping. */}
        <section className={styles["lab-section"]} id="beans">
          <h2>This week’s beans</h2>
          <div className={styles["origin-carousel"]} role="region" aria-label="This week's beans" tabIndex={0} data-testid="origin-carousel">
            {origins.map((origin) => <article className={styles["origin-card"]} key={origin}><h3>{origin}</h3><p>Notes of stone fruit, cacao and honey.</p></article>)}
          </div>
        </section>

        {/* Planted: intentional marquee-style rail with no keyboard access. */}
        <section className={styles["lab-section"]}>
          <h2>Served by</h2>
          <div className={styles["partner-rail"]} data-testid="partner-rail">
            {partners.map((partner) => <span className={styles.partner} key={partner}>{partner}</span>)}
          </div>
        </section>

        {/* Planted: fixed-width row in a client component. */}
        <section className={styles["lab-section"]} id="subscriptions">
          <h2>Subscriptions</h2>
          <PricingTable />
        </section>

        {/* Planted: filter row that scrolls by accident at narrow widths. */}
        <section className={styles["lab-section"]}>
          <div className={styles["filter-row"]} data-testid="filter-row">
            <span>Roast: medium-dark</span><span>Grind: whole bean</span><span>Ships: every two weeks</span><span>Bag: 340 g</span>
          </div>
        </section>

        {/* Not a finding: data table inside a focusable scroll wrapper. */}
        <section className={styles["lab-section"]} id="wholesale">
          <h2>Wholesale price list</h2>
          <div className={styles["table-wrap"]} tabIndex={0} role="region" aria-label="Wholesale prices" data-testid="price-table">
            <table>
              <thead><tr><th>Origin</th><th>Process</th><th>Altitude</th><th>1 kg</th><th>5 kg</th><th>20 kg</th><th>Availability</th></tr></thead>
              <tbody>{origins.map((origin, index) => <tr key={origin}><td>{origin}</td><td>Washed</td><td>{1600 + index * 80} m</td><td>$24</td><td>$110</td><td>$410</td><td>In stock</td></tr>)}</tbody>
            </table>
          </div>
        </section>

        {/* Planted: three columns that only overflow between two breakpoints. */}
        <section className={`${styles["lab-section"]} ${styles["lab-features"]}`} data-testid="feature-grid">
          <article><h3>Roasted to order</h3><p>Every bag ships within 48 hours of roasting.</p></article>
          <article><h3>Direct trade</h3><p>We pay growers 40% above fair-trade minimums.</p></article>
          <article><h3>Compostable bags</h3><p>Plant-based liners, recyclable valves.</p></article>
        </section>

        {/* Planted: fixed-height promo that clips once text spacing increases (1.4.12). */}
        <section className={styles["lab-section"]}>
          <div className={styles.promo} data-testid="promo-card"><p>Free shipping over $40. Use code BREW.</p></div>
        </section>
      </main>

      {/* Planted: fixed cookie bar adding to the covered area at short viewports. */}
      <div className={styles["cookie-bar"]} role="dialog" aria-label="Cookie notice" data-testid="cookie-bar">We use cookies to remember your grind. <button type="button">OK</button></div>
    </div>
  );
}
