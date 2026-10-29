/** Tile bounding box of one Area (inclusive). */
export interface AreaBounds {
  minC: number;
  maxC: number;
  minR: number;
  maxR: number;
}

let cache: { tiles: unknown; bounds: Map<string, AreaBounds> } | null = null;

/**
 * Every Area's bounding box, from the layout's `areaTiles`. Memoized on the
 * areaTiles array identity — the layout replaces it on every Area edit — so
 * the per-frame overlays can call this freely.
 */
export function areaBoundingBoxes(layout: {
  cols: number;
  areaTiles?: Array<string | null>;
}): Map<string, AreaBounds> {
  if (cache && cache.tiles === layout.areaTiles) return cache.bounds;
  const bounds = new Map<string, AreaBounds>();
  const tiles = layout.areaTiles ?? [];
  for (let i = 0; i < tiles.length; i++) {
    const label = tiles[i];
    if (!label) continue;
    const c = i % layout.cols;
    const r = Math.floor(i / layout.cols);
    const b = bounds.get(label);
    if (!b) {
      bounds.set(label, { minC: c, maxC: c, minR: r, maxR: r });
    } else {
      b.minC = Math.min(b.minC, c);
      b.maxC = Math.max(b.maxC, c);
      b.minR = Math.min(b.minR, r);
      b.maxR = Math.max(b.maxR, r);
    }
  }
  cache = { tiles: layout.areaTiles, bounds };
  return bounds;
}
