/**
 * The RViz CSV Exporter (GLOSSARY.md): the sign-transformed Robot CSV
 * variant used for visualization. The format is a contract pinned by
 * golden fixtures (ADR 0006) — same bytes as the Robot CSV except the
 * joint columns:
 *
 * - `q1` (base rotation) is unchanged — the base turns the same way
 *   for the controller and the visualization model.
 * - `q2` (shoulder pitch) and `q3` (elbow pitch) flip sign — the
 *   visualization model (URDF) counts both pitches from the opposite
 *   direction as the robot controller, so feeding the controller's
 *   angles in untransformed would show the arm bending the wrong way.
 *
 * This transform encodes the mounting convention; losing it would
 * silently corrupt every future visual check. Changing it means
 * updating the committed golden fixture and an ADR.
 */

import type { MotionPlan } from "../motion/planner";
import { CSV_JOINT_COUNT, formatPlanCsv } from "./robot-csv";

/**
 * Applies the RViz mounting-convention sign transform to one joint
 * vector: `[q1, −q2, −q3]`. The transform is defined for exactly the
 * MiKo-mini's three joints — a shorter vector would silently produce
 * `NaN` columns and a longer one would silently drop an axis, so any
 * other length throws a `RangeError`.
 */
export function rvizAngles(q: readonly number[]): readonly number[] {
  if (q.length !== CSV_JOINT_COUNT) {
    throw new RangeError(
      `the RViz sign transform is defined for ${CSV_JOINT_COUNT} joint angles (q1, q2, q3), got ${q.length}`,
    );
  }
  return [q[0] as number, -(q[1] as number), -(q[2] as number)];
}

/**
 * Renders the Motion Plan as RViz CSV bytes: the Robot CSV layout
 * (header `t,q1,q2,q3`, integer milliseconds, radians at fixed
 * precision) with the sign-transformed joint vector per row.
 */
export function toRvizCsv(plan: MotionPlan): string {
  return formatPlanCsv(plan, rvizAngles);
}
