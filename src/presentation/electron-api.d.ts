export {};

declare global {
  interface Window {
    mauxi?: {
      resolveFixtureSource(input: { fixture: "vite" | "next"; hint: string }): Promise<{ filePath: string; fileFingerprint: string } | null>;
      capturePreview(input: { previewId: string; x: number; y: number; width: number; height: number }): Promise<{ path: string; width: number; height: number }>;
    };
  }
}
