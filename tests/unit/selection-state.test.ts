import { describe, expect, it } from "vitest";
import { fingerprintsMatch, markSelectionsAfterDocumentChange, markSelectionsAfterRouteChange } from "../../src/application/selection-state";
import { BRIDGE_PROTOCOL, isBridgeMessage, type ElementFingerprint, type SelectionCapture } from "../../src/application/preview-contract";

const fingerprint: ElementFingerprint = { selector: "[data-testid=known-target]", tag: "button", testId: "known-target", text: "Run action", sourceKey: "/src/ProofCard.tsx:8:7" };

function capture(generation = "generation-1"): SelectionCapture {
  return {
    selectionId: "selection-1", previewId: "desktop", documentGeneration: generation,
    capturedAt: new Date(0).toISOString(), url: "http://127.0.0.1:45173", viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    coordinates: { clientX: 100, clientY: 100, space: "preview-css-pixels" },
    element: { tag: "button", label: "Run action", role: null, html: "<button>Run action</button>" },
    bounds: { x: 50, y: 50, width: 120, height: 40 },
    source: { filePath: "/src/ProofCard.tsx", lineNumber: 8, columnNumber: 7, componentName: "ProofCard", method: "react-grab", fileFingerprint: "abc123" },
    fingerprint, computedStyles: {},
  };
}

describe("selection freshness", () => {
  it("requires source and rendered identity to match", () => {
    expect(fingerprintsMatch(fingerprint, { ...fingerprint })).toBe(true);
    expect(fingerprintsMatch(fingerprint, { ...fingerprint, text: "Different instance" })).toBe(false);
    expect(fingerprintsMatch(fingerprint, { ...fingerprint, sourceKey: "/src/Other.tsx:1:1" })).toBe(false);
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

  it("rejects malformed bridge payloads before presentation or IPC use", () => {
    const { previewId: _previewId, ...bridgeCapture } = capture();
    expect(isBridgeMessage({
      protocol: BRIDGE_PROTOCOL,
      kind: "selection",
      session: "session",
      generation: "generation-1",
      capture: bridgeCapture,
    })).toBe(true);
    expect(isBridgeMessage({ protocol: BRIDGE_PROTOCOL, kind: "selection", session: "session", generation: "generation-1", capture: {} })).toBe(false);
    expect(isBridgeMessage({ protocol: BRIDGE_PROTOCOL, kind: "ready", session: "session", generation: "generation-1", url: "file:///forged", viewport: {}, reactGrab: true })).toBe(false);
  });
});
