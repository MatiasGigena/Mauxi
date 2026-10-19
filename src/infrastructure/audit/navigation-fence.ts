import type { BrowserWindow } from "electron";
import { linkVerdict } from "../../application/audit-site";

/** The last main-frame navigation or redirect the fence cancelled, so a failed load can say why. Null route: another origin. */
export interface Fence { refused: { route: string | null; reason: string } | null }

/**
 * Keeps a hidden audit window, which shares the workspace session, on routes a site audit may load: no popups, no
 * beforeunload prompts, and no navigation or server redirect to another origin or an excluded route (API, auth,
 * actions, downloads). Each hop is cancelled before its request is sent. The explicitly requested route stays loadable.
 */
export function confine(window: BrowserWindow, origin: string, requested: string): Fence {
  const contents = window.webContents;
  const fence: Fence = { refused: null };
  const exempt = linkVerdict(requested, origin).route;

  const check = (event: Electron.Event, url: string, mainFrame: boolean) => {
    const verdict = linkVerdict(url, origin);

    if (verdict.reason === null || verdict.route !== null && verdict.route === exempt) return;
    event.preventDefault();

    if (mainFrame) fence.refused = { route: verdict.route, reason: verdict.reason };
  };

  contents.setAudioMuted(true);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => check(event, event.url, event.isMainFrame));
  contents.on("will-redirect", (event) => check(event, event.url, event.isMainFrame));
  contents.on("will-frame-navigate", (event) => { if (event.isMainFrame) check(event, event.url, true); });
  contents.on("will-prevent-unload", (event) => event.preventDefault());

  return fence;
}
