/**
 * Motion layer: `Planner` implementations — time parameterization of a
 * discretized path (with its per-sample joint solutions) into a Motion
 * Plan: joint positions, velocities, accelerations, jerks over time,
 * within the Robot Model's limits (ADR 0004).
 *
 * May import from `core` and `kinematics`.
 */

export { CONTROL_STEP_MS, createPchipPlanner } from "./planner";
export type {
  MotionPlan,
  MotionRow,
  PlanSegmentRange,
  Planner,
  PlannerInput,
} from "./planner";
export { MotionError, type MotionErrorTag } from "./errors";
export { pchip } from "./pchip";
export type { Pchip, PchipSample } from "./pchip";
export { sCurveAt } from "./profile";
export type { ProfileSample, ProfileSpec } from "./profile";
