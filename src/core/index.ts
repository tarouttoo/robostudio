/**
 * Core layer: the in-house math core shared by every other layer —
 * Trajectory model (canonical Segments), Arc geometry, and
 * Discretization. Zero runtime dependencies, fully unit-tested
 * (ADR 0004). Everything below is pure TypeScript; validation failures
 * throw named `CoreError`s tagged for narrow handling.
 *
 * Terminology follows GLOSSARY.md. Speeds (Feed) are millimetres per
 * second internally; lengths are millimetres; angles radians.
 */

export { CoreError, type CoreErrorTag } from "./errors";
export {
  arcFromCenter,
  arcFromRadius,
  arcLengthMm,
  arcPointAt,
  planeAxes,
  planeCoords,
  planePoint,
  resolveCenterFromRadius,
  sweepRad,
} from "./arc";
export type { Vec2, Vec3 } from "./vec";
export { add, distance, length, lerp, scale, sub, vec2, vec3 } from "./vec";
export {
  assertPositiveFeed,
  line,
  point,
  segmentEnds,
  trajectory,
} from "./trajectory";
export type {
  ArcDirection,
  ArcSegment,
  Feed,
  LineSegment,
  PointSegment,
  Segment,
  Trajectory,
  WorkingPlane,
} from "./trajectory";
export {
  DEFAULT_MAX_STEP_MM,
  DEFAULT_MERGE_DISTANCE_MM,
  discretizeTrajectory,
} from "./discretize";
export type { DiscretizeOptions, DiscretizedPath, PathSample } from "./discretize";
