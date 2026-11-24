/**
 * Live Reachability (Достижимость, GLOSSARY.md): whether a 3D point or
 * a whole Segment lies in the Robot Model's workspace and admits joint
 * angles within limits. The same check runs live while drawing and
 * again as a pipeline validation stage, so it lives next to the
 * `RobotModel` seam and speaks only in named statuses — never throws.
 *
 * A point maps its `IKResult` onto a three-valued status; a Segment is
 * sampled along its geometry (endpoints included) so a violation is
 * caught where it happens along the path, not only at its ends. A PTP
 * Move (a chained Point Segment) is exempt: only its target is checked,
 * because only arrival there is guaranteed.
 */

import {
  arcLengthMm,
  arcPointAt,
  distance,
  lerp,
  segmentEnds,
  type Segment,
  type Vec3 as CoreVec3,
} from "../core";
import type { RobotModel, Vec3 } from "./robot-model";

/**
 * Reachability of one 3D point against a Robot Model: `ok` when the
 * inverse kinematics admit joint angles within limits, `unreachable`
 * when the point lies outside the workspace (an `fk-error` is treated
 * as unreachable: the robot demonstrably cannot hold the point),
 * `angle-limit` when the point is reachable but the solution violates
 * a joint limit.
 */
export type PointReachability = "ok" | "unreachable" | "angle-limit";

/**
 * The first place along a Segment where Reachability fails. `atMm` is
 * the sampled point that failed, in the Segment geometry's coordinates
 * (the core `{x, y, z}` millimetre point); for `angle-limit` the
 * violating joint and bound are named as in the underlying `IKResult`.
 */
export type ReachabilityViolation =
  | { readonly status: "unreachable"; readonly atMm: CoreVec3 }
  | {
      readonly status: "angle-limit";
      readonly atMm: CoreVec3;
      /** Name of the first joint whose limit the solution violates. */
      readonly joint: string;
      /** Which bound was violated. */
      readonly bound: "min" | "max";
    };

/** Spacing between Reachability samples along a Segment, in mm. */
export const SEGMENT_SAMPLE_STEP_MM = 2;

/**
 * Checks one 3D point against the Robot Model. Named status out, never
 * an exception — the drawing UI calls this on every sample. The
 * `IKResult` → status mapping is defined once, in
 * {@link checkPointViolation}; this is its plain-status view.
 */
export function checkPointReachability(model: RobotModel, p: Vec3): PointReachability {
  const violation = checkPointViolation(model, p);
  return violation === null ? "ok" : violation.status;
}

/**
 * The Reachability violation at one 3D point, or null when the point
 * admits joint angles within limits. This is the PTP Move check: only
 * arrival at the target is guaranteed, so only the target is checked —
 * the drawing UI uses it for the pending Move preview and the committed
 * Segment walk, and the pipeline's ik stage checks the same Move
 * endpoints the Discretization emitted.
 */
export function checkPointViolation(model: RobotModel, p: Vec3): ReachabilityViolation | null {
  const atMm: CoreVec3 = { x: p[0], y: p[1], z: p[2] };
  const ik = model.inverseKinematics(p);
  switch (ik.status) {
    case "ok":
      return null;
    case "angle-limit":
      return { status: "angle-limit", atMm, joint: ik.joint, bound: ik.bound };
    case "unreachable":
    case "fk-error":
      return { status: "unreachable", atMm };
  }
}

/**
 * Checks a Segment: samples its geometry at {@link SEGMENT_SAMPLE_STEP_MM}
 * spacing (endpoints included; a Point Segment by its target alone — a
 * PTP Move guarantees only arrival) and returns the first violation, or
 * null when the whole Segment admits joint angles within limits.
 */
export function checkSegmentReachability(
  model: RobotModel,
  segment: Segment,
): ReachabilityViolation | null {
  for (const p of segmentSamples(segment)) {
    const violation = checkPointViolation(model, [p.x, p.y, p.z]);
    if (violation !== null) return violation;
  }
  return null;
}

/** Samples a Segment along its geometry, endpoints included. */
function segmentSamples(segment: Segment): readonly CoreVec3[] {
  if (segment.kind === "point") return [segment.target];
  const ends = segmentEnds(segment);
  const lengthMm =
    segment.kind === "line" ? distance(ends.start, ends.end) : arcLengthMm(segment);
  const steps = Math.max(1, Math.ceil(lengthMm / SEGMENT_SAMPLE_STEP_MM));
  const samples: CoreVec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    samples.push(
      segment.kind === "line" ? lerp(ends.start, ends.end, t) : arcPointAt(segment, t),
    );
  }
  return samples;
}
