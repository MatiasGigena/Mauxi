import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultCanvas, dragBoard, fitBoards, fitCamera, isCanvasState, unfocus, zoomAt } from "../../src/application/canvas-state";
import { RouteLink, supportedRoute } from "../../src/application/route-link";
import { isBridgeMessage, isShellMessage, BRIDGE_PROTOCOL } from "../../src/application/preview-contract";
import { WorkspaceStore } from "../../src/infrastructure/project/workspace-store";

const origin = "http://127.0.0.1:45173";
describe("canvas geometry", () => {
  it.each([.25, .5, 1, 2])("tracks the grab offset 1:1 at %s without resizing viewports", (zoom) => {
    const board = defaultCanvas().boards.mobile;
    const moved = dragBoard(board, { x: 37, y: -29 }, zoom);
    expect((moved.x - board.x) * zoom).toBeCloseTo(37);
    expect((moved.y - board.y) * zoom).toBeCloseTo(-29);
    expect([moved.width, moved.height]).toEqual([390, 844]);
  });
  it("keeps the world point under the zoom anchor and clamps camera range", () => {
    const camera = { x: 25, y: -72, zoom: .5 }; const anchor = { x: 320, y: 150 };
    for (const requested of [0, .25, 1, 2, 8]) {
      const next = zoomAt(camera, requested, anchor);
      expect((anchor.x - next.x) / next.zoom).toBe((anchor.x - camera.x) / camera.zoom);
      expect((anchor.y - next.y) / next.zoom).toBe((anchor.y - camera.y) / camera.zoom);
      expect(next.zoom).toBeGreaterThanOrEqual(.25); expect(next.zoom).toBeLessThanOrEqual(2);
    }
  });
  it("fits displaced boards including fixed-height headers into the canvas, not the chat", () => {
    const boards = [{ x: -120, y: 84, width: 1440, height: 900 }, { x: 1430, y: -250, width: 390, height: 844 }];
    const area = { width: 1280, height: 550 }; const camera = fitCamera(boards, area);
    for (const b of boards) {
      const x = camera.x + b.x * camera.zoom; const y = camera.y + b.y * camera.zoom;
      expect(x).toBeGreaterThanOrEqual(24 - .001); expect(y).toBeGreaterThanOrEqual(24 - .001);
      expect(x + b.width * camera.zoom).toBeLessThanOrEqual(area.width - 24 + .001);
      expect(y + 48 + b.height * camera.zoom).toBeLessThanOrEqual(area.height - 24 + .001);
    }
  });
  it("centers the actual preview bounds without a minimum header width", () => {
    const board = { x: 1518, y: 0, width: 390, height: 844 };
    const area = { width: 800, height: 450 };
    const camera = fitCamera([board], area);
    const width = board.width * camera.zoom;
    expect(width).toBeLessThan(240);
    expect(camera.x + board.x * camera.zoom).toBeCloseTo((area.width - width) / 2);
    expect(camera.y + 48 + board.height * camera.zoom).toBeCloseTo(area.height - 24);
  });
  it("restores focus camera and positions while keeping explicit viewport changes", () => {
    const initial = defaultCanvas(); const focused = structuredClone(initial);
    focused.focus = { previewId: "mobile", camera: initial.camera, positions: initial.boards };
    focused.camera = { x: 42, y: 24, zoom: 1 }; focused.boards.mobile.x = 99; focused.boards.mobile.width = 600;
    const restored = unfocus(focused);
    expect(restored.camera).toEqual(initial.camera); expect(restored.boards.mobile.x).toBe(initial.boards.mobile.x);
    expect(restored.boards.mobile.width).toBe(600); expect(restored.focus).toBeNull();
  });
  it("fits restored board positions when leaving a focus in which a board was moved", () => {
    const initial = defaultCanvas(); const focused = structuredClone(initial);
    focused.focus = { previewId: "desktop", camera: initial.camera, positions: { desktop: { x: 0, y: 0 }, mobile: { x: 1518, y: 0 } } };
    focused.boards.desktop.x = 4000; focused.boards.desktop.y = 3000;
    const area = { width: 1280, height: 720 };
    const fitted = fitBoards(focused, ["desktop", "mobile"], area);
    expect(fitted.focus).toBeNull(); expect(fitted.boards.desktop).toMatchObject({ x: 0, y: 0 });
    expect(fitted.camera).toEqual(fitCamera(Object.values(unfocus(focused).boards), area));
    for (const b of Object.values(fitted.boards)) {
      expect(fitted.camera.x + b.x * fitted.camera.zoom).toBeGreaterThanOrEqual(24 - .001);
      expect(fitted.camera.x + (b.x + b.width) * fitted.camera.zoom).toBeLessThanOrEqual(area.width - 24 + .001);
    }
  });
  it("rejects corrupt/unbounded persisted state", () => {
    expect(isCanvasState(defaultCanvas())).toBe(true);
    expect(isCanvasState({ ...defaultCanvas(), camera: { x: 0, y: 0, zoom: Infinity } })).toBe(false);
    expect(isCanvasState({ ...defaultCanvas(), boards: {} })).toBe(false);
    expect(isCanvasState({ ...defaultCanvas(), chatHeight: 5000 })).toBe(true); // Ignored legacy field, no longer used for layout.
  });
});

describe("route-only linking", () => {
  it.each(["https://example.com/a", "/api/run", "/auth/callback", "/oauth2/authorize", "/checkout", "/account/delete", "/home?access_token=secret", "/home#code=secret", "/%61uth/callback", "javascript:alert(1)"])("does not mirror %s", (url) => {
    expect(supportedRoute(url, origin)).toBeNull();
  });
  it("strips only bridge parameters and preserves ordinary query/hash navigation", () => {
    expect(supportedRoute("/products?sort=name&mauxiSession=x&mauxiPreview=desktop&mauxiParent=null#details", origin)).toBe("/products?sort=name#details");
  });
  it("sends a change once, suppresses echo/redirect loops, and supports unlink/manual copy", () => {
    const link = new RouteLink(origin);
    expect(link.observe("desktop", "/", null, true)).toBeNull(); expect(link.observe("mobile", "/", null, true)).toBeNull();
    const command = link.observe("desktop", "/products", null, true)!;
    expect(command).toMatchObject({ previewId: "mobile", route: "/products" });
    expect(link.observe("desktop", "/products", null, true)).toBeNull();
    expect(link.observe("mobile", "/products/", command.navigationId, true)).toBeNull();
    expect(link.observe("desktop", "/unlinked", null, false)).toBeNull();
    expect(link.copy("desktop")).toMatchObject({ previewId: "mobile", route: "/unlinked" });
    expect(link.copy("desktop")).toBeNull();
    expect(link.observe("desktop", "/submitted", null, true, false)).toBeNull();
    expect(link.observe("desktop", "/auth/callback", null, true)).toBeNull();
    expect(link.copy("desktop")).toBeNull();
  });
  it("validates new bridge commands and rejects malformed picker commands", () => {
    const envelope = { protocol: BRIDGE_PROTOCOL, session: "s", generation: "g" };
    expect(isShellMessage({ ...envelope, kind: "selection-mode", enabled: "yes" })).toBe(false);
    expect(isShellMessage({ ...envelope, kind: "picker-refine", action: "parent" })).toBe(true);
    expect(isShellMessage({ ...envelope, kind: "picker-refine", action: "arbitrary" })).toBe(false);
    expect(isShellMessage({ ...envelope, kind: "revalidate", selectionId: "id" })).toBe(false);
    expect(isShellMessage({ ...envelope, kind: "navigate", route: "/a", navigationId: "n" })).toBe(true);
    expect(isBridgeMessage({ ...envelope, kind: "route", url: "/a", navigationId: null, safe: true })).toBe(true);
    expect(isBridgeMessage({ ...envelope, kind: "route", url: "/a", navigationId: {} })).toBe(false);
  });
});

it("persists layout through the existing workspace record without losing the plan", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-layout-"));
  const store = new WorkspaceStore(directory); const layout = defaultCanvas(); layout.linked = false;
  await store.remember("/project", "plan-a");
  await Promise.all([store.saveCanvas("/project", layout), store.remember("/project", "plan-b")]);
  expect(await store.rememberedPlan("/project")).toBe("plan-b");
  expect(await new WorkspaceStore(directory).canvas("/project")).toEqual(layout);
  expect(await store.canvas("/other")).toBeNull();
  const files = await readdir(directory); expect(files).toHaveLength(1);
  const saved = JSON.parse(await readFile(path.join(directory, files[0]), "utf8"));
  expect(saved).toMatchObject({ version: 1, planId: "plan-b", canvas: layout });
  saved.canvas.chatHeight = 208;
  await writeFile(path.join(directory, files[0]), JSON.stringify(saved));
  const restored = (await store.canvas("/project"))!;
  expect(restored).toEqual(layout); expect(restored).not.toHaveProperty("chatHeight");
  await store.saveCanvas("/project", restored);
  expect(JSON.parse(await readFile(path.join(directory, files[0]), "utf8")).canvas).not.toHaveProperty("chatHeight");
  await rm(directory, { recursive: true, force: true });
});
