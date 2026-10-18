import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AxeLab } from "./AxeLab";
import "./axe-lab.css";

createRoot(document.getElementById("root")!).render(<StrictMode><AxeLab /></StrictMode>);
