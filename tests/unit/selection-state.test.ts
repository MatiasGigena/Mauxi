import { describe, expect, it } from "vitest";
import { fingerprintsMatch, markSelectionsAfterDocumentChange } from "../../src/application/selection-state";
import type { ElementFingerprint, SelectionCapture } from "../../src/application/preview-contract";

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
});
