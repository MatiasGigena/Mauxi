import type { SelectionCapture } from "../../src/application/preview-contract";

export function selectionCapture(selectionId = "selection-1", label = "Run action"): SelectionCapture {
  return {
    selectionId, workspaceId: "workspace-1", previewId: "desktop", documentGeneration: "generation-1",
    capturedAt: new Date(0).toISOString(), url: "http://127.0.0.1:45173/", viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    coordinates: { clientX: 100, clientY: 100, space: "preview-css-pixels" },
    element: { tag: "button", label, role: null, text: label, html: `<button>${label}</button>` },
    bounds: { x: 50, y: 50, width: 120, height: 40 },
    source: { filePath: "/src/ProofCard.tsx", lineNumber: 8, columnNumber: 7, componentName: "ProofCard", method: "react-grab", fileFingerprint: "abc123", role: "jsx-element", ownership: "application", verification: "verified" },
    componentOwners: [], domAncestry: [{ tag: "button", label, selector: "[data-testid=known-target]", testId: "known-target", selected: true }],
    support: { status: "supported", reason: null },
    fingerprint: { selector: "[data-testid=known-target]", tag: "button", testId: "known-target", text: label, sourceKey: "/src/ProofCard.tsx:8:7", instanceKey: selectionId },
    computedStyles: {},
    screenshot: { status: "captured", crop: { x: 2, y: 2, width: 216, height: 136, space: "preview-css-pixels" }, path: "/capture.png", width: 216, height: 136 },
  };
}
