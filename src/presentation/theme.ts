import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const key = "mauxi-theme";
const listeners = new Set<() => void>();

function stored(): Theme {
  try { return localStorage.getItem(key) === "light" ? "light" : "dark"; } catch { return "dark"; }
}

let current: Theme = stored();

export function applyTheme(theme: Theme = current) {
  current = theme;
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme) {
  applyTheme(theme);

  try { localStorage.setItem(key, theme); } catch {}

  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => { listeners.delete(listener); };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => current);
}
