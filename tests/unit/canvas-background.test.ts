import { describe, expect, it } from "vitest";
import { CANVAS_GRID_SIZE, CANVAS_TRAIL_LENGTH, CANVAS_TRAIL_SPEED, canvasTrailGeometry, nearestTrailDistance, trailPointAt } from "../../src/presentation/canvas-background";

describe("canvas background trail", () => {
  it("keeps the approved grid, short trail and steady speed", () => {
    expect([CANVAS_GRID_SIZE, CANVAS_TRAIL_LENGTH, CANVAS_TRAIL_SPEED]).toEqual([320, 240, 140]);
  });
  it.each([[390, 700], [768, 600], [1280, 740], [1440, 900], [1920, 1600], [240, 240]])("builds a closed, grid-aligned route near a preview at %sx%s", (width, height) => {
    const result = canvasTrailGeometry(width, height, [{ x: 30, y: 40, width: width / 2, height: height / 2 }])!;
    expect(result.edges.length).toBeGreaterThanOrEqual(4);
    expect(result.total).toBe(result.edges.reduce((sum, edge) => sum + edge.length, 0));
    let distance = 0;

    for (const [index, edge] of result.edges.entries()) {
      expect((edge.x - .5) % CANVAS_GRID_SIZE).toBe(0);
      expect((edge.y - .5) % CANVAS_GRID_SIZE).toBe(0);
      expect(edge.x).toBeGreaterThanOrEqual(0); expect(edge.x).toBeLessThan(width + CANVAS_GRID_SIZE);
      expect(edge.y).toBeGreaterThanOrEqual(0); expect(edge.y).toBeLessThan(height + CANVAS_GRID_SIZE);

      if (width > CANVAS_GRID_SIZE) expect(edge.x).toBeLessThan(width);

      if (height > CANVAS_GRID_SIZE) expect(edge.y).toBeLessThan(height);
      expect(edge.length).toBeGreaterThan(0);
      expect(edge.length % CANVAS_GRID_SIZE).toBe(0);
      expect(edge.angle % 90).toBeCloseTo(0);
      expect(edge.start).toBe(distance);
      distance += edge.length;
      const next = result.edges[(index + 1) % result.edges.length];
      expect(edge.x + Math.cos(edge.angle * Math.PI / 180) * edge.length).toBeCloseTo(next.x);
      expect(edge.y + Math.sin(edge.angle * Math.PI / 180) * edge.length).toBeCloseTo(next.y);
    }

    expect(result.trailLength).toBe(CANVAS_TRAIL_LENGTH);
    expect(result.initialHead).toBeLessThan(result.total);
  });
  it("hugs a small preview instead of following the screen perimeter", () => {
    const result = canvasTrailGeometry(2560, 1440, [{ x: 700, y: 350, width: 200, height: 200 }])!;
    expect(result.edges.map(({ x, y }) => [x, y])).toEqual([[640.5, 320.5], [960.5, 320.5], [960.5, 640.5], [640.5, 640.5]]);
  });
  it("snaps different initial preview layouts to their nearby grid cells", () => {
    const a = canvasTrailGeometry(2560, 1440, [{ x: 700, y: 350, width: 200, height: 200 }])!;
    expect(canvasTrailGeometry(2560, 1440, [{ x: 710, y: 360, width: 200, height: 200 }])).toEqual(a);
    const moved = canvasTrailGeometry(2560, 1440, [{ x: 1020, y: 350, width: 200, height: 200 }])!;
    expect(moved.edges[0].x).toBe(a.edges[0].x + 320);
  });
  it("traces a stepped outline around adjacent previews rather than their empty bounding box", () => {
    const result = canvasTrailGeometry(1600, 1200, [
      { x: 20, y: 20, width: 600, height: 600 }, { x: 650, y: 20, width: 250, height: 260 },
    ])!;

    expect(result.edges).toHaveLength(6);
    expect(result.edges.map(({ x, y }) => [x, y])).toContainEqual([640.5, 320.5]);
    expect(result.edges.map(({ x, y }) => [x, y])).not.toContainEqual([960.5, 640.5]);
  });
  it("does not connect distant or diagonal-only previews across empty space", () => {
    for (const second of [{ x: 2200, y: 900, width: 100, height: 100 }, { x: 640, y: 640, width: 100, height: 100 }]) {
      const result = canvasTrailGeometry(2560, 1440, [{ x: 10, y: 10, width: 600, height: 600 }, second])!;
      expect(result.edges).toHaveLength(4);
      expect(Math.max(...result.edges.map(edge => edge.x))).toBe(640.5);
    }
  });
  it("ignores offscreen and invalid views, and stops when there is nothing nearby", () => {
    const views = [{ x: -1000, y: -1000, width: 100, height: 100 }, { x: 1400, y: 0, width: 200, height: 200 }, { x: NaN, y: 0, width: 100, height: 100 }];
    expect(canvasTrailGeometry(1280, 800, views)).toBeNull();
    expect(canvasTrailGeometry(1280, 800, [])).toBeNull();
    expect(canvasTrailGeometry(1280, 800, [{ x: -40, y: -40, width: 100, height: 100 }])!.edges).toHaveLength(4);
  });
  it.each([[0, 0], [-1, 800], [NaN, 900], [900, Infinity]])("omits routes for invalid surfaces: %sx%s", (width, height) => {
    expect(canvasTrailGeometry(width, height, [{ x: 0, y: 0, width: 100, height: 100 }])).toBeNull();
  });
  it("preserves the trail head on shared edges when the outline changes", () => {
    const before = canvasTrailGeometry(1600, 1000, [{ x: 20, y: 20, width: 600, height: 260 }])!;
    const after = canvasTrailGeometry(1600, 1000, [{ x: 20, y: 20, width: 900, height: 260 }])!;
    const point = trailPointAt(before, 400);
    expect(trailPointAt(after, nearestTrailDistance(after, point))).toEqual(point);
    expect(trailPointAt(before, before.total + 400)).toEqual(point);
    const projected = trailPointAt(after, nearestTrailDistance(after, [800.5, 500.5]));
    expect(projected[0]).toBeCloseTo(800.5); expect(projected[1]).toBeCloseTo(320.5);
  });
});
