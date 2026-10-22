import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut } from "lucide-react";
import logo from "./assets/logo-mauxi.png";
import { errorText } from "./error-text";

export function RepositoryMenu({ root, onClose }: { root: string; onClose: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const dismiss = (event: PointerEvent) => { if (!pending && !container.current?.contains(event.target instanceof Node ? event.target : null)) setOpen(false); };

    document.addEventListener("pointerdown", dismiss);

    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, pending]);

  async function closeProject() {
    if (pending) return;
    setPending(true); setError("");

    try { await onClose(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setPending(false); }
  }

  return <div className="repository-menu" ref={container} onKeyDown={event => {
    if (event.key === "Escape" && open && !pending) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }} onBlur={event => { if (!pending && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="brand repository-trigger" aria-label="Project menu" aria-expanded={open} aria-controls="repository-actions" title={root} onClick={() => setOpen(value => !value)} disabled={pending} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
      <img className="brand-mark" src={logo} alt="" /><strong>{root.split("/").pop()}</strong><ChevronDown size={13} aria-hidden="true" />
    </button>
    {open && <section id="repository-actions" className="repository-popover action-modal" aria-label="Project actions">
      <button ref={close} type="button" className="action-modal-secondary" disabled={pending} onClick={() => void closeProject()}><LogOut size={16} aria-hidden="true" /><span>{pending ? "Closing project…" : "Close project"}</span></button>
      {error && <p className="send-error" role="alert">{error}</p>}
    </section>}
  </div>;
}
