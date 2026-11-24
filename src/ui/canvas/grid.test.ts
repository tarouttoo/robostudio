import { describe, expect, it } from "vitest";

import { makeCanvasTransform, worldBounds } from "./transform";
import { GRID_MAJOR_MM, GRID_MINOR_MM, gridLinesMm, gridStepsMm } from "./grid";

describe("millimetre grid", () => {
  it("puts minor lines every 1 mm and major lines every 10 mm", () => {
    const lines = gridLinesMm({ minU: -12, maxU: 12, minV: -30, maxV: 30 });
    expect(lines.minorU).toEqual([-12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(lines.majorU).toEqual([-10, 0, 10]);
    expect(lines.minorV).toHaveLength(61);
    expect(lines.majorV).toEqual([-30, -20, -10, 0, 10, 20, 30]);
  });

  it("snaps to integer millimetres on fractional bounds", () => {
    // A viewport whose centre is not on a whole mm gives fractional
    // bounds; the grid lines themselves still land on whole mm.
    const lines = gridLinesMm({ minU: -10.4, maxU: 10.6, minV: -5.5, maxV: 5.5 });
    expect(lines.minorU[0]).toBe(-10);
    expect(lines.minorU[lines.minorU.length - 1]).toBe(10);
    for (const u of lines.minorU) expect(Math.abs(u % GRID_MINOR_MM)).toBe(0);
    for (const v of lines.minorV) expect(Math.abs(v % GRID_MINOR_MM)).toBe(0);
    for (const u of lines.majorU) expect(Math.abs(u % GRID_MAJOR_MM)).toBe(0);
    for (const v of lines.majorV) expect(Math.abs(v % GRID_MAJOR_MM)).toBe(0);
  });

  it("is empty when the bounds are inverted or degenerate", () => {
    const lines = gridLinesMm({ minU: 5, maxU: -5, minV: 0, maxV: 10 });
    expect(lines.minorU).toEqual([]);
    expect(lines.majorU).toEqual([]);
    const degenerate = gridLinesMm({ minU: 3, maxU: 3.2, minV: 0, maxV: 1 });
    expect(degenerate.minorU).toEqual([3]);
  });

  it("covers every visible millimetre of a real viewport", () => {
    const t = makeCanvasTransform({ widthPx: 800, heightPx: 600, devicePixelRatio: 1 });
    const bounds = worldBounds(t);
    const lines = gridLinesMm(bounds);
    // Every integer mm inside the bounds is present, exactly once.
    const firstU = Math.ceil(bounds.minU);
    const lastU = Math.floor(bounds.maxU);
    expect(lines.minorU).toEqual(
      Array.from({ length: lastU - firstU + 1 }, (_, i) => firstU + i),
    );
    const firstV = Math.ceil(bounds.minV);
    const lastV = Math.floor(bounds.maxV);
    expect(lines.minorV).toEqual(
      Array.from({ length: lastV - firstV + 1 }, (_, i) => firstV + i),
    );
  });

  it("keeps a 1 mm minor step after a resize (grid stays in millimetres)", () => {
    for (const widthPx of [400, 800, 1600, 3000]) {
      const t = makeCanvasTransform({ widthPx, heightPx: 600, devicePixelRatio: 1 });
      const { minorU } = gridLinesMm(worldBounds(t));
      for (let i = 1; i < minorU.length; i++) {
        expect(minorU[i]! - minorU[i - 1]!).toBe(1);
      }
    }
  });
});

describe("gridStepsMm (issue #44)", () => {
  it("keeps the 1 mm/10 mm steps at the classic drawing scales", () => {
    // At 4 px/mm a minor line sits 4 px from its neighbour: readable.
    expect(gridStepsMm(4)).toEqual({ minorMm: 1, majorMm: 10 });
    expect(gridStepsMm(20)).toEqual({ minorMm: 1, majorMm: 10 });
  });

  it("steps the grid up as the view zooms out, keeping lines apart on screen", () => {
    // The fitted zone view runs near 1 px/mm, where 1 mm lines merge
    // into a solid fill; the 1-2-5 ladder keeps ≥ 2 px between lines.
    expect(gridStepsMm(1.018)).toEqual({ minorMm: 2, majorMm: 20 });
    expect(gridStepsMm(0.9)).toEqual({ minorMm: 5, majorMm: 50 });
    expect(gridStepsMm(0.5)).toEqual({ minorMm: 5, majorMm: 50 });
  });

  it("lands exactly on the 2 px spacing boundary", () => {
    // 2 mm at 1 px/mm is exactly 2 px: still a grid, not a fill.
    expect(gridStepsMm(1)).toEqual({ minorMm: 2, majorMm: 20 });
  });
});
