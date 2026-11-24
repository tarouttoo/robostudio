/**
 * The Trajectory model: canonical Segments (Line, Point — the Arc lives
 * in `arc.ts` and is re-exported here) each carrying its own Feed, and
 * the Trajectory that orders them behind a Home Point. Terminology per
 * GLOSSARY.md; arc canonical form per ADR 0005.
 *
 * All speeds are millimetres per second (internal unit; the UI converts
 * from mm/min). Constructors validate and throw named `CoreError`s.
 */

import { CoreError } from "./errors";
import type { Vec3 } from "./vec";

/**
 * Segment traverse speed in millimetres per second (mm/s). The UI shows
 * mm/min (CNC convention) and converts before constructing Segments.
 */
export type Feed = number;

/**
 * The plane the operator draws on: XY, XZ, or YZ, with the third
 * coordinate fixed (CNC G17/G18/G19 conventions).
 */
export type WorkingPlane = "XY" | "XZ" | "YZ";

/** Arc travel direction: CW (по часовой) or CCW (против часовой). */
export type ArcDirection = "CW" | "CCW";

/**
 * How a Move travels (GLOSSARY.md: Motion Type): `"LIN"` follows the
 * drawn straight line — per-sample Discretization, IK and Reachability
 * along the path, drawn solid; `"PTP"` guarantees only arrival at the
 * target — the joints interpolate directly between the endpoint
 * solutions, the canvas draws the Move dashed, and Reachability is
 * checked at the target only (ADR 0016, ADR 0017).
 */
export type MotionType = "LIN" | "PTP";

/** A Segment defined by start and end. */
export interface LineSegment {
  readonly kind: "line";
  /** Start point in millimetres. */
  readonly start: Vec3;
  /** End point in millimetres. */
  readonly end: Vec3;
  /** Traverse speed for this Segment. */
  readonly feed: Feed;
}

/**
 * A Segment that moves the pen to a target without drawing geometry.
 * Points are chained: each Move starts where the previous Segment
 * ended (the first at the Home Point) and travels by its Motion Type —
 * a LIN Move follows the drawn straight line (per-sample
 * Discretization, Reachability along the path, drawn solid); a PTP
 * Move guarantees only arrival at the target, so the Discretization
 * samples the endpoints alone and Reachability is checked at the
 * target only (ADR 0016, ADR 0017).
 */
export interface PointSegment {
  readonly kind: "point";
  /** Pen target in millimetres. */
  readonly target: Vec3;
  /** Traverse speed for this Segment. */
  readonly feed: Feed;
  /** How the Move travels: along the drawn line (LIN) or arrive-only (PTP). */
  readonly motionType: MotionType;
}

/**
 * A Segment defined by Working Plane + start + end + direction (CW/CCW)
 * + a resolved center. Stored in canonical normalized form: the center
 * is always resolved (from R or given explicitly) at construction time
 * so all arc geometry derives from one canonical shape (ADR 0005).
 * Constructed by `arcFromRadius` / `arcFromCenter` in `arc.ts`.
 */
export interface ArcSegment {
  readonly kind: "arc";
  /** Working Plane the arc lies in. */
  readonly plane: WorkingPlane;
  /** Start point in millimetres. */
  readonly start: Vec3;
  /** End point in millimetres. */
  readonly end: Vec3;
  /** Travel direction. */
  readonly direction: ArcDirection;
  /** Resolved circle center in millimetres (in the Working Plane). */
  readonly center: Vec3;
  /** Circle radius in millimetres (strictly positive). */
  readonly radiusMm: number;
  /**
   * Signed sweep angle in radians from start to end: positive for CCW,
   * negative for CW, magnitude in (0, 2π]. A full circle (start = end)
   * has magnitude 2π.
   */
  readonly sweepRad: number;
  /** Traverse speed for this Segment. */
  readonly feed: Feed;
}

export type Segment = LineSegment | ArcSegment | PointSegment;

/**
 * The ordered set of Segments the operator drew — the thing the whole
 * app exists to produce — starting at the Home Point (the pen position
 * before the first Segment).
 */
export interface Trajectory {
  /** Pen position before the first Segment. */
  readonly home: Vec3;
  /** Segments in draw order. */
  readonly segments: readonly Segment[];
}

/** Builds a Line Segment. */
export function line(spec: {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly feed: Feed;
}): LineSegment {
  assertFinitePoint(spec.start, "line start");
  assertFinitePoint(spec.end, "line end");
  assertPositiveFeed(spec.feed, "line");
  return { kind: "line", start: spec.start, end: spec.end, feed: spec.feed };
}

/** Builds a Point Segment: a chained Move carrying its own Motion Type. */
export function point(spec: {
  readonly target: Vec3;
  readonly feed: Feed;
  readonly motionType: MotionType;
}): PointSegment {
  assertFinitePoint(spec.target, "point target");
  assertPositiveFeed(spec.feed, "point");
  assertMotionType(spec.motionType, "point");
  return { kind: "point", target: spec.target, feed: spec.feed, motionType: spec.motionType };
}

/**
 * Collects Segments behind a Home Point into a Trajectory. Segments are
 * validated at their own construction; this is a plain record builder.
 */
export function trajectory(home: Vec3, segments: readonly Segment[]): Trajectory {
  return { home, segments };
}

/**
 * The uniform start and end of any Segment: for Line and Arc the drawn
 * endpoints; for a Point both are its target — the Move's drawn
 * geometry is the target alone, its start is the previous Segment's
 * end (the Home Point first).
 */
export function segmentEnds(seg: Segment): { readonly start: Vec3; readonly end: Vec3 } {
  switch (seg.kind) {
    case "line":
      return { start: seg.start, end: seg.end };
    case "arc":
      return { start: seg.start, end: seg.end };
    case "point":
      return { start: seg.target, end: seg.target };
  }
}

/** Validates that a feed is a positive finite number of mm/s. */
export function assertPositiveFeed(feed: Feed, what: string): void {
  if (!(Number.isFinite(feed) && feed > 0)) {
    throw new CoreError("InvalidFeed", `${what} feed must be a positive number of mm/s, got ${feed}`);
  }
}

/**
 * Validates that a Motion Type is one of the two known kinds. A wrong
 * value can only arrive from untyped input (a Project File's JSON),
 * where it would otherwise silently change how the Move is sampled and
 * drawn.
 */
export function assertMotionType(motionType: MotionType, what: string): void {
  if (motionType !== "LIN" && motionType !== "PTP") {
    throw new CoreError(
      "InvalidMotionType",
      `${what} motion type must be "LIN" or "PTP", got ${JSON.stringify(motionType)}`,
    );
  }
}

/**
 * Validates that every coordinate of a point is a finite number of mm.
 * A NaN or infinite position would poison discretization silently: a
 * non-finite segment length makes the sampler drop the Segment (NaN)
 * or sample it forever (Infinity).
 */
export function assertFinitePoint(p: Vec3, what: string): void {
  if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) {
    throw new CoreError(
      "InvalidCoordinate",
      `${what} must be a finite position in mm, got (${p.x}, ${p.y}, ${p.z})`,
    );
  }
}
