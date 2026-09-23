import type { BrowserWindow, OnHeadersReceivedListenerDetails, Session } from "electron";

type Headers = Record<string, string[]>;

function localOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url.origin : null;
  } catch { return null; }
}

// A header can contain several independently enforced policies. Preserve every
// other directive (including duplicate policies), changing only embedding.
function allowAncestor(value: string, origin: string, addMissing: boolean): string {
  return value.split(",").map(policy => {
    let found = false;
    const replaced = policy.split(";").map(directive => {
      if (!/^\s*frame-ancestors(?:\s|$)/i.test(directive)) return directive;
      found = true;
      return `frame-ancestors ${origin}`;
    }).join(";");
    return found || !addMissing ? replaced : `${replaced}; frame-ancestors ${origin}`;
  }).join(",");
}

export function previewHeaders(headers: Headers, rendererOrigin: string): Headers {
  const result: Headers = {};
  let hasCsp = false;
  for (const [key, values] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name === "x-frame-options") continue;
    if (name === "content-security-policy") {
      hasCsp ||= values.length > 0;
      result[key] = values.map(value => allowAncestor(value, rendererOrigin, true));
    } else if (name === "content-security-policy-report-only") {
      result[key] = values.map(value => allowAncestor(value, rendererOrigin, false));
    } else result[key] = values;
  }
  if (!hasCsp) result["Content-Security-Policy"] = [`frame-ancestors ${rendererOrigin}`];
  return result;
}

const owners = new WeakMap<Session, () => void>();

export function installPreviewHeaders(window: BrowserWindow, options: {
  workspaceId: string;
  projectOrigin: string;
  rendererUrl: string;
  isActive: () => boolean;
}): void {
  const session = window.webContents.session;
  owners.get(session)?.();
  const projectOrigin = localOrigin(options.projectOrigin);
  const rendererOrigin = localOrigin(options.rendererUrl);
  const frames = new Map<string, number>();
  let disposed = false;
  const eligible = (details: OnHeadersReceivedListenerDetails): boolean => {
    if (disposed || !projectOrigin || !rendererOrigin || !options.isActive() || window.isDestroyed()
      || details.resourceType !== "subFrame" || details.webContentsId !== window.webContents.id
      || new URL(details.url).origin !== projectOrigin) return false;
    const main = window.webContents.mainFrame;
    const frame = details.frame;
    if (!frame || frame.detached || frame.parent !== main || new URL(main.url).origin !== rendererOrigin) return false;
    if ([...frames.values()].includes(frame.frameTreeNodeId)) return true;
    // The trusted shell names its two direct children before their first request.
    // Keep Chromium's stable identity because the bridge later changes window.name.
    for (const id of ["desktop", "mobile"]) {
      if (frame.name !== `mauxi-preview:${options.workspaceId}:${id}`) continue;
      const previous = frames.get(id);
      if (previous !== undefined && main.frames.some(child => child.frameTreeNodeId === previous)) return false;
      frames.set(id, frame.frameTreeNodeId);
      return true;
    }
    return false;
  };
  session.webRequest.onHeadersReceived((details, callback) => {
    try {
      if (eligible(details)) {
        callback({ responseHeaders: previewHeaders(details.responseHeaders ?? {}, rendererOrigin!) });
        return;
      }
    } catch { /* Missing/detached frame metadata must retain the original policy. */ }
    callback({});
  });
  const dispose = () => {
    disposed = true;
    frames.clear();
    if (owners.get(session) === dispose) {
      session.webRequest.onHeadersReceived(null);
      owners.delete(session);
    }
  };
  owners.set(session, dispose);
  window.once("closed", dispose);
}
