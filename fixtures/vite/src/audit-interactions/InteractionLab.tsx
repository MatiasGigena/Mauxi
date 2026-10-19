import { useEffect, useState } from "react";

const sections = ["Guides", "Gear", "Trails", "Maps", "Weather", "Huts"];

const trails = ["Tour du Mont Blanc", "West Highland Way", "Kungsleden", "Laugavegur", "Alta Via 1", "GR20", "Haute Route", "Camino Primitivo", "Pennine Way", "Rota Vicentina", "Lycian Way", "Dientes de Navarino", "Overland Track", "Milford Track", "Torres del Paine W"];

const stories = [
  { title: "Crossing the Vallée Blanche", text: "Glacier travel with a guide, crampons and an early start." },
  { title: "Three days on the Kungsleden", text: "Hut to hut through birch forest and open fell." },
  { title: "Winter on the Pentland Hills", text: "Short days, long views and a flask of tea." },
];

/** Planted interaction cases for the responsive audit. Data-testids name each case the E2E spec asserts. */
export function InteractionLab() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [trailsOpen, setTrailsOpen] = useState(false);
  const [hutsOpen, setHutsOpen] = useState(false);

  // The open drawer covers its own trigger, so like most drawers it closes on Escape.
  useEffect(() => {
    if (!hutsOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setHutsOpen(false); };

    document.addEventListener("keydown", close);

    return () => document.removeEventListener("keydown", close);
  }, [hutsOpen]);

  return (
    <div className="ix">
      {/* The strip scrolls away, so at the top of the page the header below it is not yet stuck to the viewport edge. */}
      <aside aria-label="Promotion"><p className="ix-promo">Spring trail guides are out.</p></aside>
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
          {/* Not a finding: a fixed sheet capped at 40vh whose list scrolls inside it, so every trail stays reachable. */}
          <button type="button" className="ix-trails" aria-expanded={trailsOpen} aria-controls="ix-trail-sheet" data-testid="trails-toggle" onClick={() => setTrailsOpen((open) => !open)}>Trails</button>
          <nav id="ix-trail-sheet" className="ix-sheet" aria-label="Trail index" hidden={!trailsOpen} data-testid="trail-sheet">
            <p className="ix-sheet-title">Long-distance trails</p>
            <ul className="ix-sheet-list">{trails.map((trail) => <li key={trail}><a href={`#${trail.split(" ")[0].toLowerCase()}`}>{trail}</a></li>)}</ul>
          </nav>
          {/* Planted: a fixed drawer below a 64px offset, 100vh tall with its own scroll. The list scrolls, but the scrollport
              itself ends 64px below the viewport, so the last huts never come into view (1.4.10). */}
          <button type="button" className="ix-trails" aria-expanded={hutsOpen} aria-controls="ix-hut-drawer" data-testid="huts-toggle" onClick={() => setHutsOpen((open) => !open)}>Huts</button>
          <nav id="ix-hut-drawer" className="ix-drawer" aria-label="Hut index" hidden={!hutsOpen} data-testid="hut-drawer">
            <ul>{trails.map((trail) => <li key={trail}><a href={`#${trail.split(" ")[0].toLowerCase()}-huts`}>{trail} huts</a></li>)}</ul>
          </nav>
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
      <aside className="ix-bar" aria-label="Offline maps" data-testid="ix-bar">Offline maps ready. <a href="#maps">Open maps</a></aside>
    </div>
  );
}
