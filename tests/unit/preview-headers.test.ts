import { EventEmitter } from "node:events";
import type { BrowserWindow, HeadersReceivedResponse, OnHeadersReceivedListenerDetails, WebFrameMain } from "electron";
import { expect, it } from "vitest";
import { installPreviewHeaders, previewHeaders } from "../../src/infrastructure/electron/preview-headers";

it("preserves all non-embedding directives across repeated and comma-joined policies", () => {
  const original = {
    "x-FRAME-options": ["DENY"],
    "Content-Security-Policy": [
      "script-src 'self'; FRAME-ANCESTORS 'none'; object-src 'none'",
      "base-uri 'self', form-action 'self'; frame-ancestors 'self'; frame-ancestors *",
    ],
    "content-security-policy-report-only": ["img-src 'self'; frame-ancestors 'none'", "script-src 'none'"],
    "Set-Cookie": ["session=fixture; HttpOnly; SameSite=Lax"],
    "X-Content-Type-Options": ["nosniff"],
  };

  const before = structuredClone(original);
  expect(previewHeaders(original, "http://127.0.0.1:1234")).toEqual({
    "Content-Security-Policy": [
      "script-src 'self';frame-ancestors http://127.0.0.1:1234; object-src 'none'",
      "base-uri 'self'; frame-ancestors http://127.0.0.1:1234, form-action 'self';frame-ancestors http://127.0.0.1:1234;frame-ancestors http://127.0.0.1:1234",
    ],
    "content-security-policy-report-only": ["img-src 'self';frame-ancestors http://127.0.0.1:1234", "script-src 'none'"],
    "Set-Cookie": original["Set-Cookie"],
    "X-Content-Type-Options": ["nosniff"],
  });
  expect(original).toEqual(before);
});

it("replaces XFO-only restrictions with an explicit shell ancestor, without changing scripts", () => {
  expect(previewHeaders({ "X-Frame-Options": ["SAMEORIGIN"] }, "http://localhost:1234"))
    .toEqual({ "Content-Security-Policy": ["frame-ancestors http://localhost:1234"] });
  expect(previewHeaders({ "Content-Security-Policy": ["script-src 'none'"] }, "http://localhost:1234"))
    .toEqual({ "Content-Security-Policy": ["script-src 'none'; frame-ancestors http://localhost:1234"] });
});

interface FakeFrame { url: string; parent: FakeFrame | null; name: string; frameTreeNodeId: number; detached: boolean; frames: FakeFrame[] }

type HeaderListener = (details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void) => void;

interface FakeListenerSlot { listener: HeaderListener | null }

interface FakeWindow extends EventEmitter { isDestroyed: () => boolean; webContents: { id: number; mainFrame: WebFrameMain; session: { webRequest: { onHeadersReceived: (value: HeaderListener | null) => void } } } }

// SAFETY: installPreviewHeaders reads only url, frames, parent, name, frameTreeNodeId and detached from frames, all present on FakeFrame.
const webFrame = (frame: FakeFrame) => frame as WebFrameMain;

// SAFETY: installPreviewHeaders uses only isDestroyed, once("closed") and webContents.{id, mainFrame, session.webRequest.onHeadersReceived}, all present on FakeWindow.
const browserWindow = (window: FakeWindow) => window as BrowserWindow;

it("fails closed for missing frame identity, other windows/origins, nested frames and inactive workspaces", () => {
  const hooks: FakeListenerSlot = { listener: null };
  const session = { webRequest: { onHeadersReceived(value: HeaderListener | null) { hooks.listener = value; } } };
  const main: FakeFrame = { url: "http://127.0.0.1:1234/ui", parent: null, name: "", frameTreeNodeId: 1, detached: false, frames: [] };
  const frame: FakeFrame = { url: "http://127.0.0.1:3000/route", parent: main, name: "mauxi-preview:workspace:desktop", frameTreeNodeId: 3, detached: false, frames: [] };
  main.frames.push(frame);
  const window: FakeWindow = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { id: 1, mainFrame: webFrame(main), session } });
  let active = true;
  const options = { workspaceId: "workspace", projectOrigin: "http://127.0.0.1:3000", rendererUrl: main.url, isActive: () => active };
  installPreviewHeaders(browserWindow(window), options);

  const request: OnHeadersReceivedListenerDetails = {
    id: 1, method: "GET", referrer: "", timestamp: 0, statusLine: "HTTP/1.1 200 OK", statusCode: 200,
    resourceType: "subFrame", webContentsId: 1, frame: webFrame(frame), url: "http://127.0.0.1:3000/route", responseHeaders: { "X-Frame-Options": ["DENY"] },
  };

  const response = (change: Partial<OnHeadersReceivedListenerDetails> = {}) => {
    let result: HeadersReceivedResponse | undefined;
    hooks.listener!({ ...request, ...change }, value => { result = value; });

    return result;
  };

  for (const change of [
    { resourceType: "xhr" as const }, { webContentsId: 2 }, { url: "http://127.0.0.1:3001" },
    { frame: null }, { frame: webFrame({ ...frame, detached: true }) },
    { frame: webFrame({ ...frame, parent: frame }) },
    { frame: webFrame({ ...frame, name: "unrecognized", frameTreeNodeId: 4 }) },
  ]) expect(response(change)).toEqual({});
  expect(response()).toHaveProperty("responseHeaders.Content-Security-Policy");
  frame.name = "changed by bridge";
  expect(response()).toHaveProperty("responseHeaders.Content-Security-Policy");
  expect(response({ frame: webFrame({ ...frame, name: "mauxi-preview:workspace:desktop", frameTreeNodeId: 4 }) })).toEqual({});
  active = false;
  expect(response()).toEqual({});
  active = true;
  main.url = "http://127.0.0.1:9999";
  expect(response()).toEqual({});
  main.url = options.rendererUrl;
  const replacement: FakeWindow = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { ...window.webContents, id: 2 } });
  const oldListener = hooks.listener;
  installPreviewHeaders(browserWindow(replacement), options);
  window.emit("closed");
  expect(hooks.listener).not.toBeNull();
  expect(hooks.listener).not.toBe(oldListener);
  let oldResponse: HeadersReceivedResponse | undefined;
  oldListener!(request, value => { oldResponse = value; });
  expect(oldResponse).toEqual({});
  replacement.emit("closed");
  expect(hooks.listener).toBeNull();
  installPreviewHeaders(browserWindow(window), { ...options, projectOrigin: "https://example.com" });
  expect(response({ url: "https://example.com" })).toEqual({});
  window.emit("closed");
});
