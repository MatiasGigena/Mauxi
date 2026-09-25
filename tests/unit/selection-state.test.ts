import { describe, expect, it } from "vitest";
import { fingerprintsMatch, markSelectionsAfterDocumentChange, markSelectionsAfterRouteChange } from "../../src/application/selection-state";
import { BRIDGE_PROTOCOL, isBridgeMessage, type ElementFingerprint, type SelectionCapture } from "../../src/application/preview-contract";
import { selectionCropToShell } from "../../src/application/selection-geometry";

const fingerprint: ElementFingerprint = { selector: "[data-testid=known-target]", tag: "button", testId: "known-target", text: "Run action", sourceKey: "/src/ProofCard.tsx:8:7", instanceKey: "instance-1" };

function capture(generation = "generation-1"): SelectionCapture {
  return {
    selectionId: "selection-1", workspaceId: "workspace-1", previewId: "desktop", documentGeneration: generation,
    capturedAt: new Date(0).toISOString(), url: "http://127.0.0.1:45173", viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    coordinates: { clientX: 100, clientY: 100, space: "preview-css-pixels" },
    element: { tag: "button", label: "Run action", role: null, text: "Run action", html: "<button>Run action</button>" },
    bounds: { x: 50, y: 50, width: 120, height: 40 },
    source: { filePath: "/src/ProofCard.tsx", lineNumber: 8, columnNumber: 7, componentName: "ProofCard", method: "react-grab", fileFingerprint: "abc123", role: "jsx-element", ownership: "application", verification: "verified" },
    componentOwners: [], domAncestry: [{ tag: "button", label: "Run action", selector: "[data-testid=known-target]", testId: "known-target", selected: true }],
    support: { status: "supported", reason: null }, fingerprint, computedStyles: {},
    screenshot: { status: "captured", crop: { x: 2, y: 2, width: 216, height: 136, space: "preview-css-pixels" }, path: "/capture.png", width: 216, height: 136 },
  };
}

describe("selection crop geometry", () => {
  it.each([.25, .5, 1, 2])("maps preview pixels through %s camera zoom", (zoom) => {
    const frame = { left: 100, top: 80, right: 100 + 1440 * zoom, bottom: 80 + 900 * zoom };
    const result = selectionCropToShell({ x: 200, y: 100, width: 300, height: 180 }, { width: 1440, height: 900 }, frame,
      { left: 0, top: 0, right: 2000, bottom: 1200 }, { left: 0, top: 0, right: 2000, bottom: 1200 });
    expect(result?.shell).toEqual({ x: 100 + 200 * zoom, y: 80 + 100 * zoom, width: 300 * zoom, height: 180 * zoom });
    expect(result?.preview).toEqual({ x: 200, y: 100, width: 300, height: 180 });
  });

  it("clips to visible canvas while preserving the actual frame-local crop", () => {
    const result = selectionCropToShell({ x: 0, y: 0, width: 300, height: 200 }, { width: 1000, height: 800 },
      { left: -100, top: 20, right: 900, bottom: 820 }, { left: 0, top: 50, right: 800, bottom: 700 }, { left: 0, top: 0, right: 1200, bottom: 900 });
    expect(result).toEqual({ shell: { x: 0, y: 50, width: 200, height: 170 }, preview: { x: 100, y: 30, width: 200, height: 170 } });
  });
});

describe("selection freshness", () => {
  it("requires source and rendered identity to match", () => {
    expect(fingerprintsMatch(fingerprint, { ...fingerprint })).toBe(true);
    expect(fingerprintsMatch(fingerprint, { ...fingerprint, text: "Different instance" })).toBe(false);
    expect(fingerprintsMatch(fingerprint, { ...fingerprint, sourceKey: "/src/Other.tsx:1:1" })).toBe(false);
    expect(fingerprintsMatch(fingerprint, { ...fingerprint, selector: "main > button:nth-of-type(2)" })).toBe(true);
    expect(fingerprintsMatch(fingerprint, { ...fingerprint, instanceKey: "replacement" })).toBe(false);
  });

  it("marks only selections from the replaced document stale", () => {
    const result = markSelectionsAfterDocumentChange([
      { capture: capture(), status: "current" },
      { capture: { ...capture(), selectionId: "mobile", previewId: "mobile" }, status: "current" },
    ], "desktop", "generation-2");
    expect(result[0].status).toBe("stale");
    expect(result[1].status).toBe("current");
  });

  it("invalidates only the navigating preview and requires a fresh pick even without a new document", () => {
    const original = [
      { capture: capture(), status: "current" as const },
      { capture: { ...capture(), selectionId: "mobile", previewId: "mobile" as const }, status: "current" as const },
    ];
    const result = markSelectionsAfterRouteChange(original, "desktop");
    expect(result[0]).toMatchObject({ status: "stale", requiresRepick: true, capture: { documentGeneration: "generation-1" } });
    expect(result[0].staleReason).toContain("route changed");
    expect(result[1]).toBe(original[1]);
    expect(original[0].status).toBe("current");
    expect(markSelectionsAfterRouteChange(result, "desktop")[0].requiresRepick).toBe(true);
  });

  it("accepts pointer/keyboard selection origins, but rejects unknown modalities", () => {
    const message = { protocol: BRIDGE_PROTOCOL, kind: "selection", session: "session", generation: "generation-1", capture: capture() };
    for (const interaction of [undefined, "pointer", "keyboard"]) expect(isBridgeMessage({ ...message, interaction })).toBe(true);
    expect(isBridgeMessage({ ...message, interaction: "unknown" })).toBe(false);
  });

  it("rejects malformed bridge payloads before presentation or IPC use", () => {
    const { previewId: _previewId, workspaceId: _workspaceId, ...bridgeCapture } = capture();
    expect(isBridgeMessage({
      protocol: BRIDGE_PROTOCOL,
      kind: "selection",
      session: "session",
      generation: "generation-1",
      capture: bridgeCapture,
    })).toBe(true);
    expect(isBridgeMessage({ protocol: BRIDGE_PROTOCOL, kind: "selection", session: "session", generation: "generation-1", capture: {} })).toBe(false);
    expect(isBridgeMessage({ protocol: BRIDGE_PROTOCOL, kind: "selection", session: "session", generation: "generation-1", capture: { ...bridgeCapture, screenshot: { ...bridgeCapture.screenshot, crop: { ...bridgeCapture.screenshot.crop, width: 1e9 } } } })).toBe(false);
    expect(isBridgeMessage({ protocol: BRIDGE_PROTOCOL, kind: "ready", session: "session", generation: "generation-1", url: "file:///forged", viewport: {}, reactGrab: true })).toBe(false);
  });
});
