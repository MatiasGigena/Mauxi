import { EventEmitter } from "node:events";
import type { BrowserWindow, OnHeadersReceivedListenerDetails } from "electron";
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

it("fails closed for missing frame identity, other windows/origins, nested frames and inactive workspaces", () => {
  type HeaderListener = (details: OnHeadersReceivedListenerDetails, callback: (response: unknown) => void) => void;
  let listener: HeaderListener | null = null;
  const session = { webRequest: { onHeadersReceived(value: typeof listener) { listener = value; } } };
  const main = { url: "http://127.0.0.1:1234/ui", frames: [] as object[] };
  const frame = { parent: main, name: "mauxi-preview:workspace:desktop", frameTreeNodeId: 3, detached: false };
  main.frames.push(frame);
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { id: 1, mainFrame: main, session } });
  let active = true;
  const options = { workspaceId: "workspace", projectOrigin: "http://127.0.0.1:3000", rendererUrl: main.url, isActive: () => active };
  installPreviewHeaders(window as unknown as BrowserWindow, options);
  const request = { resourceType: "subFrame", webContentsId: 1, frame, url: "http://127.0.0.1:3000/route", responseHeaders: { "X-Frame-Options": ["DENY"] } };
  const response = (change: object = {}) => {
    let result: unknown;
    listener!({ ...request, ...change } as unknown as OnHeadersReceivedListenerDetails, value => { result = value; });
    return result;
  };
  for (const change of [
    { resourceType: "xhr" }, { webContentsId: 2 }, { url: "http://127.0.0.1:3001" },
    { frame: null }, { frame: { ...frame, detached: true } },
    { frame: { ...frame, parent: frame } },
    { frame: { ...frame, name: "unrecognized", frameTreeNodeId: 4 } },
  ]) expect(response(change)).toEqual({});
  expect(response()).toHaveProperty("responseHeaders.Content-Security-Policy");
  frame.name = "changed by bridge";
  expect(response()).toHaveProperty("responseHeaders.Content-Security-Policy");
  expect(response({ frame: { ...frame, name: "mauxi-preview:workspace:desktop", frameTreeNodeId: 4 } })).toEqual({});
  active = false;
  expect(response()).toEqual({});
  active = true;
  main.url = "http://127.0.0.1:9999";
  expect(response()).toEqual({});
  main.url = options.rendererUrl;
  // Replacing a window in the same persistent partition must not let the old
  // window's close event remove the new owner's handler.
  const replacement = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { ...window.webContents, id: 2 } });
  const oldListener = listener as HeaderListener | null;
  installPreviewHeaders(replacement as unknown as BrowserWindow, options);
  window.emit("closed");
  expect(listener).not.toBeNull();
  expect(listener).not.toBe(oldListener);
  let oldResponse: unknown;
  oldListener!(request as unknown as OnHeadersReceivedListenerDetails, value => { oldResponse = value; });
  expect(oldResponse).toEqual({});
  replacement.emit("closed");
  expect(listener).toBeNull();
  installPreviewHeaders(window as unknown as BrowserWindow, { ...options, projectOrigin: "https://example.com" });
  expect(response({ url: "https://example.com" })).toEqual({});
  window.emit("closed");
});
