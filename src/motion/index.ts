/**
 * Motion layer: `Planner` implementations — time parameterization of a
 * discretized path (with its per-sample joint solutions) into a Motion
 * Plan: joint positions, velocities, accelerations, jerks over time,
 * within the Robot Model's limits (ADR 0004).
 *
 * May import from `core` and `kinematics`.
 */

export { CONTROL_STEP_MS, createSplinePlanner } from "./planner";
export type {
  MotionPlan,
  MotionRow,
  PlanSegmentRange,
  Planner,
  PlannerInput,
} from "./planner";
export { MotionError, type MotionErrorTag } from "./errors";
export { quinticSpline } from "./spline";
export type { QuinticSpline, SplineSample } from "./spline";
export { sCurveAt } from "./profile";
export type { ProfileSample, ProfileSpec } from "./profile";
