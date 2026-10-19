import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { InteractionLab } from "./InteractionLab";
import "./interaction-lab.css";

createRoot(document.getElementById("root")!).render(<StrictMode><InteractionLab /></StrictMode>);
