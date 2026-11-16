import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./theme";
import "./styles.css";
import "./project-setup.css";

applyTheme();

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
