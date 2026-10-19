import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuditLab } from "./AuditLab";
import "./audit-lab.css";

createRoot(document.getElementById("root")!).render(<StrictMode><AuditLab /></StrictMode>);
