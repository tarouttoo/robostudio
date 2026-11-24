/**
 * Millimetre grid geometry for the drawing canvas: which grid lines fall
 * inside the visible Working Plane range. Pure functions over the
 * transform's {@link worldBounds}; the grid is always on whole
 * millimetres regardless of fractional viewport bounds.
 */

import type { WorldBounds } from "./transform";

/** Distance between minor grid lines, in millimetres, at drawing scales. */
export const GRID_MINOR_MM = 1;

/** Distance between major grid lines, in millimetres, at drawing scales. */
export const GRID_MAJOR_MM = 10;

/** Smallest readable on-screen spacing between grid lines, in CSS pixels. */
export const MIN_GRID_SPACING_PX = 2;

/** The 1-2-5 ladder (in millimetres) the minor grid step may take. */
const GRID_LADDER_MM = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;

/** The minor and major grid steps, in millimetres, for one zoom level. */
export interface GridSteps {
  /** Distance between minor grid lines, in millimetres. */
  readonly minorMm: number;
  /** Distance between major grid lines, in millimetres (ten minors). */
  readonly majorMm: number;
}

/**
 * Picks the grid steps for the current scale: the smallest 1-2-5 ladder
 * step whose on-screen spacing stays at least
 * {@link MIN_GRID_SPACING_PX}, with the major step ten minors. Zooming
 * out (the fitted zone view runs below 1 px/mm) steps the grid up, so
 * the lines never merge into a solid fill that would hide the scene
 * painted beneath them; at drawing scales (≥ 4 px/mm) the classic
 * 1 mm/10 mm grid is unchanged.
 */
export function gridStepsMm(pxPerMm: number): GridSteps {
  for (const minorMm of GRID_LADDER_MM) {
    if (minorMm * pxPerMm >= MIN_GRID_SPACING_PX) {
      return { minorMm, majorMm: minorMm * 10 };
    }
  }
  const minorMm = GRID_LADDER_MM[GRID_LADDER_MM.length - 1] as number;
  return { minorMm, majorMm: minorMm * 10 };
}

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
