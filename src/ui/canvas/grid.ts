/**
 * Millimetre grid geometry for the drawing canvas: which grid lines fall
 * inside the visible Working Plane range. Pure functions over the
 * transform's {@link worldBounds}; the grid is always on whole
 * millimetres regardless of fractional viewport bounds.
 */

import type { WorldBounds } from "./transform";

/** Distance between minor grid lines, in millimetres. */
export const GRID_MINOR_MM = 1;

/** Distance between major grid lines, in millimetres. */
export const GRID_MAJOR_MM = 10;

/** The grid lines (constant-u verticals and constant-v horizontals) to draw. */
export interface GridLines {
  /** Vertical lines' u coordinates, in millimetres. */
  readonly minorU: readonly number[];
  /** Emphasised vertical lines' u coordinates, in millimetres. */
  readonly majorU: readonly number[];
  /** Horizontal lines' v coordinates, in millimetres. */
  readonly minorV: readonly number[];
  /** Emphasised horizontal lines' v coordinates, in millimetres. */
  readonly majorV: readonly number[];
}

/**
 * Computes the grid lines inside `bounds`: minor lines every
 * {@link GRID_MINOR_MM} and major lines every {@link GRID_MAJOR_MM},
 * all on whole millimetres. Coordinates are iterated as integer
 * multiples of the step, so no floating-point drift accumulates.
 */
export function gridLinesMm(
  bounds: WorldBounds,
  minorMm: number = GRID_MINOR_MM,
  majorMm: number = GRID_MAJOR_MM,
): GridLines {
  return {
    minorU: rangeMm(bounds.minU, bounds.maxU, minorMm),
    majorU: rangeMm(bounds.minU, bounds.maxU, majorMm),
    minorV: rangeMm(bounds.minV, bounds.maxV, minorMm),
    majorV: rangeMm(bounds.minV, bounds.maxV, majorMm),
  };
}

/** Whole multiples of `stepMm` inside `[from, to]`, ascending. */
function rangeMm(from: number, to: number, stepMm: number): number[] {
  const firstIndex = Math.ceil(from / stepMm);
  const lastIndex = Math.floor(to / stepMm);
  const out: number[] = [];
  for (let i = firstIndex; i <= lastIndex; i++) out.push(i * stepMm);
  return out;
}
