/**
 * CNC-canonical Arc geometry (ADR 0005): Working Plane + start + end +
 * direction (CW/CCW) + radius R or explicit center. There is no
 * three-point arc. All arc geometry — center resolution from R,
 * validity, sweep, sampled points, arc length — derives here, in one
 * place, from the canonical form.
 *
 * Direction is CCW/CW in the plane's (u, v) coordinates (see
 * `planeAxes`). `radiusMm` is strictly positive; major arcs (> 180°)
 * are defined via the explicit-center form. Full circles are defined
 * via the center form with coincident start and end (CNC semantics);
 * the radius form cannot resolve a center then.
 *
 * Every constructor validates and throws a named `CoreError`.
 */

import { CoreError } from "./errors";
import {
  assertFinitePoint,
  assertPositiveFeed,
  type ArcDirection,
  type ArcSegment,
  type Feed,
  type WorkingPlane,
} from "./trajectory";
import { vec2, vec3, type Vec2, type Vec3 } from "./vec";

/** Two coordinates agree (in-plane, on-circle) below this many mm. */
const COORD_EPS_MM = 1e-6;
/** A chord counts as zero below this many mm. */
const CHORD_EPS_MM = 1e-9;
/** Two radii agree (on-circle check) below this many mm. */
const RADIUS_EPS_MM = 1e-6;
/** Full turn in radians. */
const TAU = 2 * Math.PI;

/**
 * The (u, v) in-plane coordinate axes and the fixed w axis of each
 * Working Plane. CCW/CW direction is defined in the (u, v) pair: CCW
 * appears counter-clockwise viewed from the (u × v) side, which per
 * plane is:
 *
 * - XY: (x, y), z fixed — viewed from +z (standard math orientation).
 * - XZ: (x, z), y fixed — viewed from −y (x right, z up, as drawn).
 * - YZ: (y, z), x fixed — viewed from +x.
 *
 * Note the XZ sign: ISO G18 defines the plane as ZX viewed from +y, so
 * a future G-code bridge must flip the direction when mapping to or
 * from G18. That mapping belongs to the exporter/importer, not to the
 * stored canonical form (ADR 0005).
 */
export const planeAxes: Record<WorkingPlane, { readonly u: 0 | 1 | 2; readonly v: 0 | 1 | 2; readonly w: 0 | 1 | 2 }> = {
  XY: { u: 0, v: 1, w: 2 },
  XZ: { u: 0, v: 2, w: 1 },
  YZ: { u: 1, v: 2, w: 0 },
};

/** Projects a 3D point into a Working Plane's (u, v) plus its fixed w. */
export function planeCoords(plane: WorkingPlane, p: Vec3): { u: number; v: number; w: number } {
  const axes = planeAxes[plane];
  const coords = [p.x, p.y, p.z] as const;
  return { u: coords[axes.u], v: coords[axes.v], w: coords[axes.w] };
}

/** Rebuilds a 3D point from in-plane (u, v) and the plane's fixed w. */
export function planePoint(plane: WorkingPlane, u: number, v: number, w: number): Vec3 {
  const axes = planeAxes[plane];
  const coords = [0, 0, 0];
  coords[axes.u] = u;
  coords[axes.v] = v;
  coords[axes.w] = w;
  return vec3(coords[0] as number, coords[1] as number, coords[2] as number);
}

/**
 * Resolves the circle center from a radius and the chord start → end.
 * For CCW the center lies 90° left of the chord; for CW 90° right,
 * giving the minor arc (≤ 180°) in both directions. Returns null when
 * the endpoints are farther apart than `2·radiusMm` allows; throws an
 * `ArcAmbiguousCenter` `CoreError` when the endpoints coincide (a chord
 * of zero cannot resolve a center).
 */
export function resolveCenterFromRadius(
  start2: Vec2,
  end2: Vec2,
  radiusMm: number,
  direction: ArcDirection,
): Vec2 | null {
  const dx = end2.x - start2.x;
  const dy = end2.y - start2.y;
  const chord = Math.hypot(dx, dy);
  if (chord <= CHORD_EPS_MM) {
    throw new CoreError(
      "ArcAmbiguousCenter",
      `coincident endpoints ${fmt(start2.x, start2.y)} give no unique center for radius ${radiusMm}`,
    );
  }
  if (chord > 2 * radiusMm + CHORD_EPS_MM) return null;
  // Left normal of the chord; the right normal is its negation.
  const nx = -dy / chord;
  const ny = dx / chord;
  const half = chord / 2;
  const h = Math.sqrt(Math.max(0, radiusMm * radiusMm - half * half));
  const side = direction === "CCW" ? 1 : -1;
  const mx = (start2.x + end2.x) / 2;
  const my = (start2.y + end2.y) / 2;
  return vec2(mx + side * h * nx, my + side * h * ny);
}

/**
 * Signed sweep angle in radians from `start2` to `end2` around
 * `center2`: positive for CCW, negative for CW, magnitude in (0, 2π].
 * Coincident start and end give a full circle (magnitude 2π).
 */
export function sweepRad(
  start2: Vec2,
  end2: Vec2,
  center2: Vec2,
  direction: ArcDirection,
): number {
  const startAngle = Math.atan2(start2.y - center2.y, start2.x - center2.x);
  const endAngle = Math.atan2(end2.y - center2.y, end2.x - center2.x);
  const raw = direction === "CCW" ? endAngle - startAngle : startAngle - endAngle;
  const positive = ((raw % TAU) + TAU) % TAU;
  // A dust-level chord means coincident endpoints — a full circle. The
  // test is on distance, not on the sweep angle: an angle epsilon would
  // misclassify a real, near-zero-length arc on a huge radius (a 0.1 µm
  // chord on a 1 m radius sweeps 1e-10 rad but is not a full circle).
  const chord = Math.hypot(end2.x - start2.x, end2.y - start2.y);
  const sweep = chord <= CHORD_EPS_MM ? TAU : positive;
  return sweep * (direction === "CCW" ? 1 : -1);
}

/**
 * Builds an Arc from Working Plane + start + end + direction + explicit
 * center. The radius is taken from the start; the end must lie on the
 * same circle. Coincident start and end form a full circle.
 */
export function arcFromCenter(spec: {
  readonly plane: WorkingPlane;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly center: Vec3;
  readonly direction: ArcDirection;
  readonly feed: Feed;
}): ArcSegment {
  assertPositiveFeed(spec.feed, "arc");
  assertFinitePoint(spec.start, "arc start");
  assertFinitePoint(spec.end, "arc end");
  assertFinitePoint(spec.center, "arc center");
  const s = planeCoords(spec.plane, spec.start);
  const e = planeCoords(spec.plane, spec.end);
  const c = planeCoords(spec.plane, spec.center);
  assertOnPlane(spec.plane, s, e, c);
  const radiusMm = Math.hypot(s.u - c.u, s.v - c.v);
  if (radiusMm <= COORD_EPS_MM) {
    throw new CoreError(
      "InvalidArcRadius",
      `arc radius is zero: start ${fmt(s.u, s.v)} coincides with center ${fmt(c.u, c.v)}`,
    );
  }
  const endRadius = Math.hypot(e.u - c.u, e.v - c.v);
  if (Math.abs(endRadius - radiusMm) > RADIUS_EPS_MM) {
    throw new CoreError(
      "ArcCenterOffCircle",
      `arc end ${fmt(e.u, e.v)} does not lie on the radius-${radiusMm} circle around ${fmt(c.u, c.v)} (distance ${endRadius}); collinear placements with unequal radii are impossible`,
    );
  }
  const sweep = sweepRad(vec2(s.u, s.v), vec2(e.u, e.v), vec2(c.u, c.v), spec.direction);
  return {
    kind: "arc",
    plane: spec.plane,
    start: spec.start,
    end: spec.end,
    direction: spec.direction,
    center: spec.center,
    radiusMm,
    sweepRad: sweep,
    feed: spec.feed,
  };
}

/**
 * Builds an Arc from Working Plane + start + end + direction + radius
 * R. The center is resolved from R: 90° left of the chord for CCW,
 * right for CW, so the arc is the minor one (≤ 180°). The endpoints
 * must be distinct (else the center is ambiguous — use the center form
 * for full circles) and no farther apart than `2·R`.
 */
export function arcFromRadius(spec: {
  readonly plane: WorkingPlane;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly radiusMm: number;
  readonly direction: ArcDirection;
  readonly feed: Feed;
}): ArcSegment {
  assertPositiveFeed(spec.feed, "arc");
  assertFinitePoint(spec.start, "arc start");
  assertFinitePoint(spec.end, "arc end");
  if (!(Number.isFinite(spec.radiusMm) && spec.radiusMm > 0)) {
    throw new CoreError(
      "InvalidArcRadius",
      `arc radius must be a positive number of mm, got ${spec.radiusMm}`,
    );
  }
  const s = planeCoords(spec.plane, spec.start);
  const e = planeCoords(spec.plane, spec.end);
  assertOnPlane(spec.plane, s, e);
  const chord = Math.hypot(e.u - s.u, e.v - s.v);
  if (chord <= CHORD_EPS_MM) {
    throw new CoreError(
      "ArcAmbiguousCenter",
      `arc start and end coincide at ${fmt(s.u, s.v)}: a radius of ${spec.radiusMm} mm cannot resolve a unique center; define a full circle via its center`,
    );
  }
  const center2 = resolveCenterFromRadius(
    vec2(s.u, s.v),
    vec2(e.u, e.v),
    spec.radiusMm,
    spec.direction,
  );
  if (center2 === null) {
    throw new CoreError(
      "ArcRadiusTooSmall",
      `arc endpoints are ${Math.hypot(e.u - s.u, e.v - s.v)} mm apart, farther than the diameter ${2 * spec.radiusMm} mm of radius ${spec.radiusMm} allows`,
    );
  }
  const center = planePoint(spec.plane, center2.x, center2.y, s.w);
  const sweep = sweepRad(vec2(s.u, s.v), vec2(e.u, e.v), center2, spec.direction);
  return {
    kind: "arc",
    plane: spec.plane,
    start: spec.start,
    end: spec.end,
    direction: spec.direction,
    center,
    radiusMm: spec.radiusMm,
    sweepRad: sweep,
    feed: spec.feed,
  };
}

/** Position at fraction `f` (0 = start, 1 = end) along the arc. */
export function arcPointAt(arc: ArcSegment, f: number): Vec3 {
  // The endpoints are exact: consecutive geometry joins on them.
  if (f === 0) return arc.start;
  if (f === 1) return arc.end;
  const s = planeCoords(arc.plane, arc.start);
  const c = planeCoords(arc.plane, arc.center);
  const angle = Math.atan2(s.v - c.v, s.u - c.u) + f * arc.sweepRad;
  return planePoint(
    arc.plane,
    c.u + arc.radiusMm * Math.cos(angle),
    c.v + arc.radiusMm * Math.sin(angle),
    s.w,
  );
}

/** Analytic arc length: radius times sweep magnitude, in millimetres. */
export function arcLengthMm(arc: ArcSegment): number {
  return Math.abs(arc.sweepRad) * arc.radiusMm;
}

/**
 * Validates that all given plane projections agree on the Working
 * Plane's fixed coordinate.
 */
function assertOnPlane(
  plane: WorkingPlane,
  ...points: readonly { u: number; v: number; w: number }[]
): void {
  const axes = planeAxes[plane];
  const first = points[0];
  if (first === undefined) return;
  for (const p of points) {
    if (Math.abs(p.w - first.w) > COORD_EPS_MM) {
      throw new CoreError(
        "ArcOffPlane",
        `arc points disagree on the ${plane} plane's fixed ${axisName(axes.w)} coordinate (e.g. ${first.w} vs ${p.w}); an arc lies entirely in its Working Plane`,
      );
    }
  }
}

/** Human-readable axis letter for an axis index. */
function axisName(index: 0 | 1 | 2): string {
  return (["x", "y", "z"] as const)[index] as string;
}

/** Formats an in-plane coordinate pair for error messages. */
function fmt(u: number, v: number): string {
  return `(${u}, ${v})`;
}
