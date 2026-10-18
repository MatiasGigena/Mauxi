import { useState } from "react";

const sections = ["Guides", "Gear", "Trails", "Maps", "Weather", "Huts"];
const stories = [
  { title: "Crossing the Vallée Blanche", text: "Glacier travel with a guide, crampons and an early start." },
  { title: "Three days on the Kungsleden", text: "Hut to hut through birch forest and open fell." },
  { title: "Winter on the Pentland Hills", text: "Short days, long views and a flask of tea." },
];

/** Planted interaction cases for the responsive audit. Data-testids name each case the E2E spec asserts. */
export function InteractionLab() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="ix">
      {/* The strip scrolls away, so at the top of the page the header below it is not yet stuck to the viewport edge. */}
      <p className="ix-promo">Spring trail guides are out.</p>
      {/* Planted: sticky header taller than half of a 400%-zoom viewport. Tab scrolls later links to the middle of the
          viewport, right under it (2.4.11). The coverage check measures the page at the top, where the header still sits below the strip. */}
      <header className="ix-header" data-testid="ix-header">
        <div className="ix-brand">
          {/* Not a finding: focus is visible and the link sits inside the bar, so it is never hidden. */}
          <a href="#main" className="ix-home" data-testid="home-link">Fieldnotes</a>
          {/* Planted: hamburger whose opened menu has a fixed 420px width (1.4.10 at 320px). */}
          <button type="button" className="ix-burger" aria-expanded={menuOpen} aria-controls="ix-menu" data-testid="menu-toggle" onClick={() => setMenuOpen((open) => !open)}>Menu</button>
        </div>
        <nav id="ix-menu" className="ix-menu" aria-label="All sections" hidden={!menuOpen} data-testid="wide-menu">
          {sections.map((section) => <a key={section} href={`#${section.toLowerCase()}`}>{section}</a>)}
        </nav>
        <nav className="ix-tabs" aria-label="Sections">
          {sections.map((section) => <a key={section} href={`#${section.toLowerCase()}`}>{section}</a>)}
        </nav>
      </header>

      <main id="main">
        <section className="ix-intro">
          <h1>Notes from the trail</h1>
          {/* Not a finding: a disclosure whose content fits at every width. */}
          <details className="ix-faq" data-testid="faq">
            <summary>What is a fieldnote?</summary>
            <p>A short report written on the day.</p>
          </details>
          {/* Planted: hover tooltip that runs off the right edge at 320px (1.4.13). */}
          <p className="ix-stat">
            <span className="ix-tip-wrap">
              <button type="button" className="ix-tip-trigger" aria-describedby="tip-elevation" data-testid="tooltip-trigger">Elevation</button>
              <span role="tooltip" id="tip-elevation" className="ix-tip">Total climb across the route, measured from the GPS track and corrected with a terrain model.</span>
            </span>
          </p>
        </section>

        {stories.map((story) => <article className="ix-story" key={story.title}>
          <h2>{story.title}</h2>
          <p>{story.text}</p>
          <a href={`#${story.title.split(" ")[0].toLowerCase()}`} className="ix-more">Read the story</a>
        </article>)}

        <section className="ix-actions">
          {/* Planted: outline removed with no replacement focus style (2.4.7). */}
          <button type="button" className="ix-ghost" data-testid="no-focus-style">Save for later</button>
          {/* Not activated: a disclosure-looking button whose click handler navigates away. */}
          <button type="button" className="ix-share" aria-expanded="false" aria-controls="ix-share-panel" data-testid="navigating-trigger"
            onClick={() => { localStorage.setItem("mauxi-fixture:navigated", "share"); window.location.assign("/audit-lab.html"); }}>Share</button>
          <div id="ix-share-panel" hidden>Copy link</div>
          {/* Not activated: a popup button that submits its form. */}
          <form action="/audit-lab.html" className="ix-sort">
            <button aria-haspopup="listbox" data-testid="submit-trigger" onClick={() => localStorage.setItem("mauxi-fixture:navigated", "sort")}>Sort</button>
          </form>
        </section>
      </main>

      {/* Not a finding: a fixed bottom bar matched by scroll-padding-bottom, so focus scrolls clear of it. */}
      <div className="ix-bar" data-testid="ix-bar">Offline maps ready. <a href="#maps">Open maps</a></div>
    </div>
  );
}
