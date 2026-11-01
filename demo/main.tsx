import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { RotateCcw } from "lucide-react";
import MauxiDemo from "./MauxiDemo";
import "./host.css";

// The page a demo lives on: a white page, the stage, and a real Replay button.
// The scene plays once and holds its payoff; Replay remounts it at the story
// boundary (references/kit.md, Explicit replay).
function Host() {
  const [run, setRun] = useState(0);

  return <main className="demo-host">
    <div className="demo-figure" id="mauxi-demo"><MauxiDemo key={run} /></div>
    <button type="button" className="demo-replay" onClick={() => setRun((count) => count + 1)}><RotateCcw size={14} aria-hidden="true" />Replay</button>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Host /></StrictMode>);
