import { describe, expect, it } from "vitest";

import { resolveCenterFromRadius, vec2, type Vec2 } from "../../core";
import { arcPreviewPoints } from "./draw";

/** The chord every scenario below draws along: (0,0) → (8,0). */
const START = vec2(0, 0);
const END = vec2(8, 0);

/** The CCW minor-arc center for the chord: 90° left of it. */
const CCW_CENTER = resolveCenterFromRadius(START, END, 10, "CCW")!;
/** The CW minor-arc center: mirrored below the chord. */
const CW_CENTER = resolveCenterFromRadius(START, END, 10, "CW")!;

/** Midpoint sample of a preview, for shape assertions. */
function midPoint(points: readonly Vec2[]): Vec2 {
  return points[Math.floor(points.length / 2)]!;
}

describe("arc preview points", () => {
  it("spans the draft exactly: first point is the start, last the on-circle end of the cursor ray", () => {
    const points = arcPreviewPoints({
      center: CCW_CENTER,
      radiusMm: 10,
      start: START,
      cursor: END,
      direction: "CCW",
    });
    expect(points[0]).toEqual(START);
    const last = points[points.length - 1]!;
    // The cursor defines the angle; the end sits on the circle.
    expect(last.x).toBeCloseTo(END.x, 12);
    expect(last.y).toBeCloseTo(END.y, 12);
  });

  it("keeps every sample on the circle", () => {
    const points = arcPreviewPoints({
      center: CCW_CENTER,
      radiusMm: 10,
      start: START,
      cursor: vec2(14, 3),
      direction: "CCW",
    });
    for (const p of points) {
      expect(Math.hypot(p.x - CCW_CENTER.x, p.y - CCW_CENTER.y)).toBeCloseTo(10, 9);
    }
  });

  it("bends CW and CCW previews to opposite sides: direction is visible before the click", () => {
    const ccw = arcPreviewPoints({ center: CCW_CENTER, radiusMm: 10, start: START, cursor: END, direction: "CCW" });
    const cw = arcPreviewPoints({ center: CW_CENTER, radiusMm: 10, start: START, cursor: END, direction: "CW" });
    const ccwMid = midPoint(ccw);
    const cwMid = midPoint(cw);
    // The CCW center lies above the chord, its arc bulges below it; CW mirrors.
    expect(ccwMid.y).toBeLessThan(0);
    expect(cwMid.y).toBeGreaterThan(0);
  });

  it("follows a moved cursor: the preview sweep tracks the cursor angle", () => {
    const near = arcPreviewPoints({ center: CCW_CENTER, radiusMm: 10, start: START, cursor: END, direction: "CCW" });
    const far = arcPreviewPoints({
      center: CCW_CENTER,
      radiusMm: 10,
      start: START,
      cursor: vec2(CCW_CENTER.x, CCW_CENTER.y - 10),
      direction: "CCW",
    });
    // The second cursor sits at the circle's bottom: a larger CCW sweep.
    expect(far.length).toBeGreaterThan(0);
    expect(midPoint(far)).not.toEqual(midPoint(near));
  });
});
