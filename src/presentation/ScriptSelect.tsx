import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { LaunchPlan } from "../application/project-contract";

interface ScriptSelectProps {
  plans: LaunchPlan[];
  value: string;
  disabled: boolean;
  open: boolean;
  keyboard: boolean;
  onChange: (id: string) => void;
  onOpenChange: (open: boolean, keyboard: boolean) => void;
}

/** Command-only select; plan IDs, not display strings, remain the source of identity. */
export function ScriptSelect({ plans, value, disabled, open, keyboard, onChange, onOpenChange }: ScriptSelectProps) {
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", time: 0 });
  const id = useId();
  const selected = plans.find(plan => plan.id === value);
  const unavailable = disabled || !selected;
  const expanded = open && !unavailable;
  const activeIndex = Math.min(active, Math.max(0, plans.length - 1));
  const activeId = `${id}-option-${activeIndex}`;

  function show(fromKeyboard: boolean, index = Math.max(0, plans.findIndex(plan => plan.id === value))) {
    if (unavailable) return;
    typeahead.current = { text: "", time: 0 };
    setActive(index); onOpenChange(true, fromKeyboard);
  }
  function choose(planId: string, fromKeyboard: boolean) {
    if (unavailable) return;
    onChange(planId); onOpenChange(false, fromKeyboard);
    trigger.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    if (open && unavailable) onOpenChange(false, true);
  }, [open, unavailable, onOpenChange]);
  useEffect(() => {
    if (!expanded) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false, false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded, onOpenChange]);
  useLayoutEffect(() => {
    // Scroll the options, never the surrounding setup screen.
    const option = document.getElementById(activeId);
    if (!expanded || !option || !list.current) return;
    const itemBounds = option.getBoundingClientRect();
    const listBounds = list.current.getBoundingClientRect();
    if (itemBounds.top < listBounds.top) list.current.scrollTop -= listBounds.top - itemBounds.top;
    else if (itemBounds.bottom > listBounds.bottom) list.current.scrollTop += itemBounds.bottom - listBounds.bottom;
  }, [expanded, activeId]);

  function keys(event: KeyboardEvent<HTMLButtonElement>) {
    if (unavailable || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape" && expanded) {
      event.preventDefault(); event.stopPropagation(); onOpenChange(false, true); return;
    }
    if (event.key === "Tab") { if (expanded) onOpenChange(false, true); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      if (!expanded) show(true);
      else setActive((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + plans.length) % plans.length);
    } else if (expanded && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault(); event.stopPropagation(); choose(plans[activeIndex].id, true);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault(); event.stopPropagation();
      const index = event.key === "Home" ? 0 : plans.length - 1;
      if (expanded) setActive(index); else show(true, index);
    } else if (event.key.length === 1 && event.key !== " ") {
      event.preventDefault(); event.stopPropagation();
      const now = Date.now();
      const text = (now - typeahead.current.time < 700 ? typeahead.current.text : "") + event.key.toLowerCase();
      // Repeated letters cycle; otherwise match a command or script prefix.
      const prefix = [...text].every(char => char === text[0]) ? text[0] : text;
      const start = expanded ? activeIndex : plans.findIndex(plan => plan.id === value);
      const candidates = plans.map((_, offset) => (start + offset + 1) % plans.length);
      const index = candidates.find(index => plans[index].commandDisplay.toLowerCase().startsWith(prefix) || plans[index].scriptName.toLowerCase().startsWith(prefix));
      if (!expanded) show(true, index); else if (index !== undefined) setActive(index);
      typeahead.current = { text, time: now };
    }
  }

  return <div ref={root} className="script-control" data-keyboard={keyboard}
    onBlur={event => { if (expanded && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false, keyboard); }}>
    <div id={`${id}-label`} className="script-select-caption">Application and script</div>
    <button ref={trigger} type="button" className="script-select-trigger" role="combobox" disabled={unavailable}
      aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined}
      aria-labelledby={`${id}-label ${id}-value`} aria-activedescendant={expanded ? activeId : undefined}
      onKeyDown={keys} onClick={event => expanded ? onOpenChange(false, event.detail === 0) : show(event.detail === 0)}>
      <code id={`${id}-value`}>{selected?.commandDisplay ?? "No command available"}</code><ChevronDown size={15} aria-hidden="true" />
    </button>
    {expanded && <div className="script-select-popup">
      <div ref={list} className="script-select-options" id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`}>
        {plans.map((plan, index) => <div key={plan.id} role="option" id={`${id}-option-${index}`} className="script-select-option"
          aria-selected={plan.id === value} aria-label={`${plan.commandDisplay} (${plan.appRoot})`} title={plan.appRoot} data-active={index === activeIndex}
          onPointerMove={event => { if (event.pointerType === "mouse") setActive(index); }}
          onMouseDown={event => event.preventDefault()} onClick={event => choose(plan.id, event.detail === 0)}>
          <code>{plan.commandDisplay}</code>{plan.id === value && <Check size={15} aria-hidden="true" />}
        </div>)}
      </div>
    </div>}
  </div>;
}
