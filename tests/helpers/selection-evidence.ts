import { expect, type Page } from "@playwright/test";
import { BRIDGE_PROTOCOL, type SelectionCapture } from "../../src/application/preview-contract";

type Capture = Omit<SelectionCapture, "workspaceId" | "previewId"> & { previewId: "desktop" | "mobile" };
declare global { interface Window { selectionEvidence?: Capture[] } }

export async function observeSelections(page: Page) {
  await page.evaluate(protocol => {
    if (window.selectionEvidence) return;
    window.selectionEvidence = [];
    window.addEventListener("message", event => {
      const frame = [...document.querySelectorAll<HTMLIFrameElement>('[data-testid$="-preview"]')].find(node => node.contentWindow === event.source);
      if (!frame || event.origin !== new URL(frame.src).origin || event.data?.protocol !== protocol || event.data.kind !== "selection") return;
      window.selectionEvidence!.push({ ...event.data.capture, previewId: frame.dataset.testid === "desktop-preview" ? "desktop" : "mobile" });
    });
  }, BRIDGE_PROTOCOL);
}

export async function latestSelection(page: Page): Promise<Capture> {
  const key = await page.locator('.selection-list .selection-chip').first().getAttribute('data-selection-id');
  await expect.poll(() => page.evaluate(key => window.selectionEvidence?.some(item => item.selectionId === key), key)).toBe(true);
  return page.evaluate(key => window.selectionEvidence!.find(item => item.selectionId === key)!, key);
}

export async function resolvedSelection(page: Page) {
  const capture = await latestSelection(page);
  const source = await page.evaluate(async capture => {
    const input = { hint: capture.source.filePath, lineNumber: capture.source.lineNumber, columnNumber: capture.source.columnNumber, locator: { tag: capture.element.tag, testIds: [...new Set(capture.domAncestry.flatMap(entry => entry.testId ? [entry.testId] : []))] } };
    const bootstrap = await window.mauxi!.getBootstrap();
    if (bootstrap.active) return window.mauxi!.resolveSource({ workspaceId: bootstrap.active.workspaceId, ...input });
    const fixture = new URL(capture.url).port === "45000" ? "next" : "vite";
    return window.mauxi!.resolveFixtureSource({ fixture, ...input });
  }, capture);
  return { capture, source };
}

export async function revalidateSelection(page: Page) {
  const capture = await latestSelection(page);
  return page.evaluate(({ capture, protocol }) => new Promise<"valid" | "stale">((resolve, reject) => {
    const frame = document.querySelector<HTMLIFrameElement>(`[data-testid="${capture.previewId}-preview"]`)!;
    const origin = new URL(frame.src).origin;
    const timer = setTimeout(() => { window.removeEventListener('message', receive); reject(new Error('No bridge revalidation reply')); }, 3000);
    function receive(event: MessageEvent) {
      if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.kind !== 'revalidation' || event.data.selectionId !== capture.selectionId) return;
      clearTimeout(timer); window.removeEventListener('message', receive); resolve(event.data.status);
    }
    window.addEventListener('message', receive);
    frame.contentWindow!.postMessage({ protocol, session: new URL(frame.src).searchParams.get('mauxiSession'), generation: capture.documentGeneration, kind: 'revalidate', selectionId: capture.selectionId, fingerprint: capture.fingerprint }, origin);
  }), { capture, protocol: BRIDGE_PROTOCOL });
}
