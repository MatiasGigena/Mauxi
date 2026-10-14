export const CANVAS_GRID_SIZE = 320;
export const CANVAS_TRAIL_SPEED = 140;
export const CANVAS_TRAIL_LENGTH = 240;

export interface GridEdge { x: number; y: number; length: number; angle: number; start: number }

export interface CanvasViewBounds { x: number; y: number; width: number; height: number }

type Point = [number, number];

export function canvasTrailGeometry(width: number, height: number, views: CanvasViewBounds[]) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const columns = Math.max(1, Math.floor((width - .5) / CANVAS_GRID_SIZE));
  const rows = Math.max(1, Math.floor((height - .5) / CANVAS_GRID_SIZE));
  const cells = new Set<string>();
  const key = (x: number, y: number) => `${x},${y}`;

  for (const view of views) {
    if (![view.x, view.y, view.width, view.height].every(Number.isFinite) || view.width <= 0 || view.height <= 0) continue;
    const left = Math.max(0, view.x); const top = Math.max(0, view.y);
    const right = Math.min(width, view.x + view.width); const bottom = Math.min(height, view.y + view.height);

    if (right <= left || bottom <= top) continue;
    const firstColumn = Math.min(columns - 1, Math.floor(left / CANVAS_GRID_SIZE));
    const lastColumn = Math.min(columns, Math.ceil(right / CANVAS_GRID_SIZE));
    const firstRow = Math.min(rows - 1, Math.floor(top / CANVAS_GRID_SIZE));
    const lastRow = Math.min(rows, Math.ceil(bottom / CANVAS_GRID_SIZE));

    for (let x = firstColumn; x < lastColumn; x++) {
      for (let y = firstRow; y < lastRow; y++) cells.add(key(x, y));
    }
  }

  if (!cells.size) return null;

  const segments: { from: Point; to: Point; direction: number }[] = [];

  for (const cell of cells) {
    const [x, y] = cell.split(",").map(Number);

    if (!cells.has(key(x, y - 1))) segments.push({ from: [x, y], to: [x + 1, y], direction: 0 });

    if (!cells.has(key(x + 1, y))) segments.push({ from: [x + 1, y], to: [x + 1, y + 1], direction: 1 });

    if (!cells.has(key(x, y + 1))) segments.push({ from: [x + 1, y + 1], to: [x, y + 1], direction: 2 });

    if (!cells.has(key(x - 1, y))) segments.push({ from: [x, y + 1], to: [x, y], direction: 3 });
  }

  const outgoing = new Map<string, number[]>();
  segments.forEach((edge, i) => {
    const start = key(...edge.from);
    outgoing.set(start, [...(outgoing.get(start) ?? []), i]);
  });
  const unused = new Set(segments.map((_, i) => i));
  let outline: Point[] = [];
  let largestArea = 0;

  while (unused.size) {
    const first = unused.values().next().value!;
    let index = first;
    const points: Point[] = [];

    while (unused.has(index)) {
      const edge = segments[index];
      unused.delete(index);
      points.push(edge.from);
      const next = (outgoing.get(key(...edge.to)) ?? []).filter(i => unused.has(i));
      next.sort((a, b) => {
        const rank = (i: number) => [1, 0, 3, 2][(segments[i].direction - edge.direction + 4) % 4];

        return rank(a) - rank(b);
      });

      if (!next.length || (edge.to[0] === segments[first].from[0] && edge.to[1] === segments[first].from[1])) break;
      index = next[0];
    }

    const area = points.reduce((sum, [x, y], i) => {
      const next = points[(i + 1) % points.length];

      return sum + x * next[1] - next[0] * y;
    }, 0);

    if (area > largestArea) { largestArea = area; outline = points; }
  }

  if (!outline.length) return null;

  const corners = outline.filter(([x, y], i) => {
    const prev = outline[(i + outline.length - 1) % outline.length];
    const next = outline[(i + 1) % outline.length];

    return (x - prev[0]) * (next[1] - y) !== (y - prev[1]) * (next[0] - x);
  });

  const points = corners.map(([x, y]) => [x * CANVAS_GRID_SIZE + .5, y * CANVAS_GRID_SIZE + .5]);
  let total = 0;

  const edges: GridEdge[] = points.map(([x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length];
    const length = Math.abs(nx - x) + Math.abs(ny - y);
    const edge = { x, y, length, angle: Math.atan2(ny - y, nx - x) * 180 / Math.PI, start: total };
    total += length;

    return edge;
  });

  const trailLength = Math.min(CANVAS_TRAIL_LENGTH, total * .45);
  const initialHead = Math.min(edges[0].length, trailLength);

  return { edges, total, trailLength, initialHead };
}

export type CanvasTrailGeometry = NonNullable<ReturnType<typeof canvasTrailGeometry>>;

export function trailPointAt(geometry: CanvasTrailGeometry, distance: number): Point {
  const at = ((distance % geometry.total) + geometry.total) % geometry.total;
  const edge = geometry.edges.find(edge => at < edge.start + edge.length)!;
  const along = at - edge.start;

  return [edge.x + Math.cos(edge.angle * Math.PI / 180) * along, edge.y + Math.sin(edge.angle * Math.PI / 180) * along];
}

export function nearestTrailDistance(geometry: CanvasTrailGeometry, point: Point) {
  let closest = Infinity;
  let distance = 0;

  for (const edge of geometry.edges) {
    const dx = Math.cos(edge.angle * Math.PI / 180); const dy = Math.sin(edge.angle * Math.PI / 180);
    const along = Math.max(0, Math.min(edge.length, (point[0] - edge.x) * dx + (point[1] - edge.y) * dy));
    const error = Math.hypot(edge.x + dx * along - point[0], edge.y + dy * along - point[1]);

    if (error < closest) { closest = error; distance = edge.start + along; }
  }

  return distance % geometry.total;
}
