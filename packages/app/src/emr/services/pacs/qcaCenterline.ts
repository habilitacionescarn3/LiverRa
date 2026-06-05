// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// QCA Centerline Pathfinding — Dijkstra-based vessel centerline tracing
// ============================================================================
// When a user clicks two points on a blood vessel in an angiogram, we need to
// find the path that follows the vessel between them. This is like GPS routing:
// the "cost image" (from qcaImageProcessing.ts) assigns low cost to bright
// vessel pixels and high cost to dark background. Dijkstra's algorithm finds
// the cheapest path — which naturally follows the vessel center.
//
// After finding the raw path, we smooth it (reduce pixel-level jitter) and
// resample it at even spacing for downstream diameter measurements.
// ============================================================================

/**
 * A 2D point in image coordinates (pixels).
 */
export interface Point {
  x: number;
  y: number;
}

// ============================================================================
// MinHeap — Binary min-heap priority queue for Dijkstra
// ============================================================================
// Dijkstra needs to always process the lowest-cost node next. A min-heap gives
// us O(log n) insert and O(log n) extract-min, much faster than scanning a
// flat array each time.

export class MinHeap {
  private nodes: Uint32Array;
  private costs: Float32Array;
  private _size: number;

  constructor(capacity = 1024) {
    this.nodes = new Uint32Array(capacity);
    this.costs = new Float32Array(capacity);
    this._size = 0;
  }

  get size(): number {
    return this._size;
  }

  /** Add a node with its cost to the heap. */
  push(node: number, cost: number): void {
    if (this._size >= this.nodes.length) {
      this.grow();
    }
    const i = this._size++;
    this.nodes[i] = node;
    this.costs[i] = cost;
    this.bubbleUp(i);
  }

  /** Remove and return the node with the smallest cost, or undefined if empty. */
  pop(): { node: number; cost: number } | undefined {
    if (this._size === 0) {
      return undefined;
    }
    const node = this.nodes[0];
    const cost = this.costs[0];
    this._size--;
    if (this._size > 0) {
      this.nodes[0] = this.nodes[this._size];
      this.costs[0] = this.costs[this._size];
      this.bubbleDown(0);
    }
    return { node, cost };
  }

  private grow(): void {
    const newCap = this.nodes.length * 2;
    const newNodes = new Uint32Array(newCap);
    const newCosts = new Float32Array(newCap);
    newNodes.set(this.nodes);
    newCosts.set(this.costs);
    this.nodes = newNodes;
    this.costs = newCosts;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.costs[i] >= this.costs[parent]) {
        break;
      }
      this.swap(i, parent);
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < this._size && this.costs[left] < this.costs[smallest]) {
        smallest = left;
      }
      if (right < this._size && this.costs[right] < this.costs[smallest]) {
        smallest = right;
      }
      if (smallest === i) {
        break;
      }
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tmpNode = this.nodes[a];
    const tmpCost = this.costs[a];
    this.nodes[a] = this.nodes[b];
    this.costs[a] = this.costs[b];
    this.nodes[b] = tmpNode;
    this.costs[b] = tmpCost;
  }
}

// ============================================================================
// Dijkstra Centerline — 8-connected shortest path through a cost image
// ============================================================================

/** 8 neighbor offsets: [dx, dy, moveCost multiplier] */
const SQRT2 = Math.sqrt(2);
const NEIGHBORS: readonly [number, number, number][] = [
  [-1, -1, SQRT2],
  [0, -1, 1],
  [1, -1, SQRT2],
  [-1, 0, 1],
  [1, 0, 1],
  [-1, 1, SQRT2],
  [0, 1, 1],
  [1, 1, SQRT2],
];

/**
 * Find the lowest-cost path between two points in a cost image using Dijkstra.
 *
 * @param costImage - Flat Float32Array of size w*h where lower values = easier to traverse
 * @param w - Image width in pixels
 * @param h - Image height in pixels
 * @param start - Starting point (user's first click)
 * @param end - Ending point (user's second click)
 * @returns Array of Points tracing the path from start to end
 */
export function dijkstraCenterline(
  costImage: Float32Array,
  w: number,
  h: number,
  start: Point,
  end: Point
): Point[] {
  // Edge case: start and end are the same pixel
  if (start.x === end.x && start.y === end.y) {
    return [{ x: start.x, y: start.y }];
  }

  const n = w * h;
  const dist = new Float32Array(n).fill(Infinity);
  const visited = new Uint8Array(n);
  const parent = new Int32Array(n).fill(-1);
  const heap = new MinHeap();

  const startIdx = start.y * w + start.x;
  const endIdx = end.y * w + end.x;

  dist[startIdx] = 0;
  heap.push(startIdx, 0);

  while (heap.size > 0) {
    const current = heap.pop()!;
    const idx = current.node;

    if (visited[idx]) {
      continue;
    }
    visited[idx] = 1;

    // Reached destination — reconstruct path
    if (idx === endIdx) {
      break;
    }

    const cx = idx % w;
    const cy = (idx - cx) / w;

    for (const [dx, dy, moveCost] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
        continue;
      }
      const nIdx = ny * w + nx;
      if (visited[nIdx]) {
        continue;
      }
      const newDist = dist[idx] + moveCost * costImage[nIdx];
      if (newDist < dist[nIdx]) {
        dist[nIdx] = newDist;
        parent[nIdx] = idx;
        heap.push(nIdx, newDist);
      }
    }
  }

  // Backtrack from end to start using the parent array
  const path: Point[] = [];
  let cur = endIdx;
  while (cur !== -1) {
    path.push({ x: cur % w, y: ((cur - (cur % w)) / w) });
    cur = parent[cur];
  }
  path.reverse();
  return path;
}

// ============================================================================
// Smooth Centerline — Moving-average filter to reduce pixel jitter
// ============================================================================

/**
 * Smooth a path using a moving average window. Each interior point is replaced
 * by the average of itself and its neighbors within `windowSize` steps.
 * Endpoint regions are kept unchanged to preserve start/end accuracy.
 */
export function smoothCenterline(path: Point[], windowSize = 5): Point[] {
  if (path.length <= windowSize * 2) {
    return path.map((p) => ({ ...p }));
  }

  const result: Point[] = path.map((p) => ({ ...p }));

  for (let i = windowSize; i < path.length - windowSize; i++) {
    let sumX = 0;
    let sumY = 0;
    const count = 2 * windowSize + 1;
    for (let j = i - windowSize; j <= i + windowSize; j++) {
      sumX += path[j].x;
      sumY += path[j].y;
    }
    result[i] = { x: sumX / count, y: sumY / count };
  }

  return result;
}

// ============================================================================
// Resample Centerline — Evenly spaced points along the path
// ============================================================================

/**
 * Walk along the path and emit a new point every `spacing` pixels of arc
 * length. This gives evenly-distributed sample points for diameter measurement.
 * The first and last points are always included.
 */
export function resampleCenterline(path: Point[], spacing = 2.0): Point[] {
  if (path.length <= 1) {
    return path.map((p) => ({ ...p }));
  }

  const result: Point[] = [{ ...path[0] }];
  let accumulated = 0;

  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x;
    const dy = path[i].y - path[i - 1].y;
    const segLen = Math.sqrt(dx * dx + dy * dy);

    if (segLen === 0) {
      continue;
    }

    let remaining = segLen;
    let fromX = path[i - 1].x;
    let fromY = path[i - 1].y;
    const ux = dx / segLen; // unit vector x
    const uy = dy / segLen; // unit vector y

    while (accumulated + remaining >= spacing) {
      const step = spacing - accumulated;
      fromX += ux * step;
      fromY += uy * step;
      result.push({ x: fromX, y: fromY });
      remaining -= step;
      accumulated = 0;
    }

    accumulated += remaining;
  }

  // Always include the last point
  const last = path[path.length - 1];
  const prev = result[result.length - 1];
  if (prev.x !== last.x || prev.y !== last.y) {
    result.push({ ...last });
  }

  return result;
}
