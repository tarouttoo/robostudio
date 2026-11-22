import { describe, expect, it } from "vitest";

import { arcFromCenter, arcFromRadius, arcLengthMm, arcPointAt, sweepRad } from "./arc";
import { CoreError } from "./errors";
import { vec2, vec3 } from "./vec";

/** Runs `fn` and returns the tag of the CoreError it throws. */
function errorTagOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CoreError) return e.tag;
    throw new Error(`expected a CoreError, got: ${String(e)}`);
  }
  throw new Error("expected the function to throw a CoreError");
}

describe("arc from center", () => {
  it("resolves radius and CCW sweep from start, end, and center", () => {
    const arc = arcFromCenter({
      plane: "XY",
      start: vec3(10, 0, 0),
      end: vec3(0, 10, 0),
      center: vec3(0, 0, 0),
      direction: "CCW",
      feed: 20,
    });
    expect(arc.kind).toBe("arc");
    expect(arc.radiusMm).toBeCloseTo(10, 12);
    expect(arc.sweepRad).toBeCloseTo(Math.PI / 2, 12);
    expect(arc.center).toEqual(vec3(0, 0, 0));
    expect(arc.direction).toBe("CCW");
  });

  it("gives CW a negative sweep of the complementary angle", () => {
    // CW from (10,0) to (0,10) around the origin travels 270°.
    const arc = arcFromCenter({
      plane: "XY",
      start: vec3(10, 0, 0),
      end: vec3(0, 10, 0),
      center: vec3(0, 0, 0),
      direction: "CW",
      feed: 20,
    });
    expect(arc.sweepRad).toBeCloseTo(-((3 * Math.PI) / 2), 12);
  });

  it("treats coincident start and end as a full circle", () => {
    const arc = arcFromCenter({
      plane: "XY",
      start: vec3(50, 0, 0),
      end: vec3(50, 0, 0),
      center: vec3(0, 0, 0),
      direction: "CCW",
      feed: 20,
    });
    expect(arc.sweepRad).toBeCloseTo(2 * Math.PI, 10);
    expect(arcLengthMm(arc)).toBeCloseTo(2 * Math.PI * 50, 9);
  });

  it("gives a CW full circle a negative full-turn sweep", () => {
    const arc = arcFromCenter({
      plane: "XY",
      start: vec3(50, 0, 0),
      end: vec3(50, 0, 0),
      center: vec3(0, 0, 0),
      direction: "CW",
      feed: 20,
    });
    expect(arc.sweepRad).toBeCloseTo(-2 * Math.PI, 10);
    expect(arcLengthMm(arc)).toBeCloseTo(2 * Math.PI * 50, 9);
  });

  it("keeps the plane's fixed coordinate constant on the center", () => {
    // XZ plane: y fixed. Center carries the same y as start/end.
    const arc = arcFromCenter({
      plane: "XZ",
      start: vec3(10, 4, 0),
      end: vec3(0, 4, 10),
      center: vec3(0, 4, 0),
      direction: "CCW",
      feed: 20,
    });
    expect(arc.center).toEqual(vec3(0, 4, 0));
    expect(arc.radiusMm).toBeCloseTo(10, 12);
  });

  it("rejects a zero radius (start coinciding with center)", () => {
    expect(
      errorTagOf(() =>
        arcFromCenter({
          plane: "XY",
          start: vec3(0, 0, 0),
          end: vec3(5, 0, 0),
          center: vec3(0, 0, 0),
          direction: "CCW",
          feed: 20,
        }),
      ),
    ).toBe("InvalidArcRadius");
  });

  it("rejects an end that does not lie on the circle", () => {
    // |end − center| = 5 but |start − center| = 10.
    expect(
      errorTagOf(() =>
        arcFromCenter({
          plane: "XY",
          start: vec3(10, 0, 0),
          end: vec3(5, 0, 0),
          center: vec3(0, 0, 0),
          direction: "CCW",
          feed: 20,
        }),
      ),
    ).toBe("ArcCenterOffCircle");
  });

  it("rejects the collinear impossibility (start and end on one ray)", () => {
    // Same ray from the center: radii 10 and 20 differ → not on one circle.
    expect(
      errorTagOf(() =>
        arcFromCenter({
          plane: "XY",
          start: vec3(10, 0, 0),
          end: vec3(20, 0, 0),
          center: vec3(0, 0, 0),
          direction: "CCW",
          feed: 20,
        }),
      ),
    ).toBe("ArcCenterOffCircle");
  });

  it("rejects endpoints disagreeing on the plane's fixed coordinate", () => {
    expect(
      errorTagOf(() =>
        arcFromCenter({
          plane: "XY",
          start: vec3(10, 0, 1),
          end: vec3(0, 10, 0),
          center: vec3(0, 0, 0),
          direction: "CCW",
          feed: 20,
        }),
      ),
    ).toBe("ArcOffPlane");
  });

  it("rejects a center off the working plane", () => {
    expect(
      errorTagOf(() =>
        arcFromCenter({
          plane: "XY",
          start: vec3(10, 0, 0),
          end: vec3(0, 10, 0),
          center: vec3(0, 0, 2),
          direction: "CCW",
          feed: 20,
        }),
      ),
    ).toBe("ArcOffPlane");
  });
});

describe("arc from radius", () => {
  it("resolves the center to the left of the chord for CCW", () => {
    // Unit circle, CCW quarter from (1,0) to (0,1): center is the origin.
    const arc = arcFromRadius({
      plane: "XY",
      start: vec3(1, 0, 0),
      end: vec3(0, 1, 0),
      radiusMm: 1,
      direction: "CCW",
      feed: 20,
    });
    expect(arc.center.x).toBeCloseTo(0, 12);
    expect(arc.center.y).toBeCloseTo(0, 12);
    expect(arc.center.z).toBe(0);
    expect(arc.radiusMm).toBe(1);
    expect(arc.sweepRad).toBeCloseTo(Math.PI / 2, 12);
    expect(arc.start).toEqual(vec3(1, 0, 0));
    expect(arc.end).toEqual(vec3(0, 1, 0));
  });

  it("resolves the center to the right of the chord for CW", () => {
    // CW minor arc from (1,0) to (0,1) with R = 1 centers at (1,1).
    const arc = arcFromRadius({
      plane: "XY",
      start: vec3(1, 0, 0),
      end: vec3(0, 1, 0),
      radiusMm: 1,
      direction: "CW",
      feed: 20,
    });
    expect(arc.center.x).toBeCloseTo(1, 12);
    expect(arc.center.y).toBeCloseTo(1, 12);
    expect(arc.center.z).toBe(0);
    expect(arc.sweepRad).toBeCloseTo(-Math.PI / 2, 12);
  });

  it("resolves a half-circle when the endpoints are diametral", () => {
    const arc = arcFromRadius({
      plane: "XY",
      start: vec3(-5, 0, 0),
      end: vec3(5, 0, 0),
      radiusMm: 5,
      direction: "CCW",
      feed: 20,
    });
    expect(arc.center.x).toBeCloseTo(0, 12);
    expect(arc.center.y).toBeCloseTo(0, 12);
    expect(arc.sweepRad).toBeCloseTo(Math.PI, 12);
    expect(arcLengthMm(arc)).toBeCloseTo(5 * Math.PI, 10);
  });

  it("rejects endpoints farther apart than the radius allows", () => {
    // Chord 30 > diameter 2·10.
    expect(
      errorTagOf(() =>
        arcFromRadius({
          plane: "XY",
          start: vec3(-15, 0, 0),
          end: vec3(15, 0, 0),
          radiusMm: 10,
          direction: "CCW",
          feed: 20,
        }),
      ),
    ).toBe("ArcRadiusTooSmall");
  });

  it("rejects coincident endpoints (center would be ambiguous)", () => {
    expect(
      errorTagOf(() =>
        arcFromRadius({
          plane: "XY",
          start: vec3(10, 0, 0),
          end: vec3(10, 0, 0),
          radiusMm: 10,
          direction: "CCW",
          feed: 20,
        }),
      ),
    ).toBe("ArcAmbiguousCenter");
  });

  it("rejects a non-positive radius", () => {
    expect(
      errorTagOf(() =>
        arcFromRadius({
          plane: "XY",
          start: vec3(0, 0, 0),
          end: vec3(1, 0, 0),
          radiusMm: 0,
          direction: "CCW",
          feed: 20,
        }),
      ),
    ).toBe("InvalidArcRadius");
  });

  it("rejects a non-positive feed", () => {
    expect(
      errorTagOf(() =>
        arcFromRadius({
          plane: "XY",
          start: vec3(0, 0, 0),
          end: vec3(1, 0, 0),
          radiusMm: 5,
          direction: "CCW",
          feed: 0,
        }),
      ),
    ).toBe("InvalidFeed");
  });

  it("rejects endpoints disagreeing on the plane's fixed coordinate", () => {
    // YZ plane: x is fixed, so x = 2 vs x = 3 is off-plane.
    expect(
      errorTagOf(() =>
        arcFromRadius({
          plane: "YZ",
          start: vec3(2, 10, 0),
          end: vec3(3, 0, 10),
          radiusMm: 10,
          direction: "CCW",
          feed: 20,
        }),
      ),
    ).toBe("ArcOffPlane");
  });
});

describe("arc geometry", () => {
  it("evaluates points along the sweep from start to end", () => {
    const arc = arcFromCenter({
      plane: "XY",
      start: vec3(10, 0, 0),
      end: vec3(0, 10, 0),
      center: vec3(0, 0, 0),
      direction: "CCW",
      feed: 20,
    });
    expect(arcPointAt(arc, 0)).toEqual(vec3(10, 0, 0));
    const quarter = arcPointAt(arc, 0.5);
    expect(quarter.x).toBeCloseTo(10 * Math.cos(Math.PI / 4), 12);
    expect(quarter.y).toBeCloseTo(10 * Math.sin(Math.PI / 4), 12);
    expect(quarter.z).toBe(0);
    expect(arcPointAt(arc, 1)).toEqual(vec3(0, 10, 0));
  });

  it("evaluates points in a non-XY plane with the fixed coordinate held", () => {
    const arc = arcFromCenter({
      plane: "XZ",
      start: vec3(10, 4, 0),
      end: vec3(0, 4, 10),
      center: vec3(0, 4, 0),
      direction: "CCW",
      feed: 20,
    });
    const mid = arcPointAt(arc, 0.5);
    expect(mid.y).toBe(4);
    expect(mid.x).toBeCloseTo(10 * Math.cos(Math.PI / 4), 12);
    expect(mid.z).toBeCloseTo(10 * Math.sin(Math.PI / 4), 12);
  });

  it("builds and evaluates a YZ arc with (y, z) as the in-plane pair", () => {
    // CCW in (y, z) viewed from +x: from +y toward +z around the origin.
    const arc = arcFromCenter({
      plane: "YZ",
      start: vec3(0, 10, 0),
      end: vec3(0, 0, 10),
      center: vec3(0, 0, 0),
      direction: "CCW",
      feed: 20,
    });
    expect(arc.radiusMm).toBeCloseTo(10, 12);
    // A swapped (u, v) mapping would sweep the complementary 3π/2 here.
    expect(arc.sweepRad).toBeCloseTo(Math.PI / 2, 12);
    // An asymmetric sample (the diagonal midpoint is transposition-proof).
    const eighth = arcPointAt(arc, 0.25);
    expect(eighth.x).toBe(0);
    expect(eighth.y).toBeCloseTo(10 * Math.cos(Math.PI / 8), 12);
    expect(eighth.z).toBeCloseTo(10 * Math.sin(Math.PI / 8), 12);
    expect(arcLengthMm(arc)).toBeCloseTo(5 * Math.PI, 10);
  });

  it("computes arc length as radius times sweep magnitude", () => {
    const arc = arcFromCenter({
      plane: "XY",
      start: vec3(10, 0, 0),
      end: vec3(0, 10, 0),
      center: vec3(0, 0, 0),
      direction: "CW",
      feed: 20,
    });
    expect(arcLengthMm(arc)).toBeCloseTo(10 * (3 * Math.PI / 2), 10);
  });

  it("promotes only a coincident chord to a full circle sweep", () => {
    const origin = vec2(0, 0);
    // Exactly coincident endpoints → full turn.
    expect(sweepRad(vec2(50, 0), vec2(50, 0), origin, "CCW")).toBeCloseTo(2 * Math.PI, 12);
    expect(sweepRad(vec2(50, 0), vec2(50, 0), origin, "CW")).toBeCloseTo(-2 * Math.PI, 12);
    // Distinct endpoints on one circle a dust-level angle apart → the
    // real sweep, not a full turn.
    const angle = 1e-10;
    const tiny = sweepRad(
      vec2(50, 0),
      vec2(50 * Math.cos(angle), 50 * Math.sin(angle)),
      origin,
      "CCW",
    );
    expect(tiny).toBeGreaterThan(0);
    expect(tiny).toBeLessThan(1e-8);
  });

  it("keeps a dust chord on a huge radius a tiny arc, not a full circle", () => {
    // A 0.1 µm chord on a 1 m radius sweeps 1e-10 rad: a real,
    // near-zero-length arc. It must not be promoted to a full circle,
    // whose length here would exceed it by 11 orders of magnitude.
    const arc = arcFromRadius({
      plane: "XY",
      start: vec3(0, 0, 0),
      end: vec3(1e-4, 0, 0),
      radiusMm: 1e6,
      direction: "CCW",
      feed: 20,
    });
    expect(Math.abs(arc.sweepRad)).toBeLessThan(1e-8);
    expect(arcLengthMm(arc)).toBeCloseTo(1e-4, 9);
  });
});
