/**
 * The headless pipeline (GLOSSARY.md: Validation stages): Segments +
 * Robot Model + Planner in → named validation stage chain → exported
 * Robot CSV and RViz CSV out.
 *
 * The chain runs five named stages in order, each validating its own
 * output and failing with a `PipelineError` naming the stage and an
 * operator-readable reason:
 *
 * 1. `discretization` — the Trajectory is sampled (core) into a dense
 *    path; a path with no samples or zero pen travel cannot drive the
 *    robot and stops the pipeline.
 * 2. `ik` — every sample is solved by the Robot Model; the first
 *    unreachable or limit-violating sample stops the pipeline, naming
 *    the Segment, the point, and the violated limit.
 * 3. `motion-plan` — the Planner time-parameterizes the path; planner
 *    failures are re-named as stage failures, and the plan itself is
 *    re-verified against the pipeline invariants (rows on the 20 ms
 *    grid, monotonic time, continuous motion, dynamic limits).
 * 4. `collision` — a reserved no-op: deliberately empty in v1, present
 *    in the chain so collision checking can be added later without
 *    reshaping the pipeline.
 * 5. `export` — the Robot CSV and RViz CSV exporters render the plan,
 *    the Motion Preview GIF is rendered from the same plan (the
 *    animated isometric preview, `robot_motion.gif`), and the exported
 *    arrays are parsed back and checked against the plan (row count,
 *    header, time column, values within formatting precision) before
 *    the bytes leave the pipeline.
 *
 * The stages are also reported as outcomes on success so the UI can
 * show a readable generation log (the stage details are English; the
 * UI layer translates per GLOSSARY.md).
 */

import { discretizeTrajectory, type DiscretizedPath, type PathSample } from "../core/discretize";
import { CoreError } from "../core/errors";
import type { Trajectory } from "../core/trajectory";
import type { IKResult, RobotModel } from "../kinematics/robot-model";
import { MotionError } from "../motion/errors";
import { CONTROL_STEP_MS, type MotionPlan, type Planner } from "../motion/planner";
import { PipelineError, type PipelineStage } from "./errors";
import { renderMotionPreviewGif } from "./motion-preview";
import { toRobotCsv } from "./robot-csv";
import { rvizAngles, toRvizCsv } from "./rviz-csv";

/** The named validation stages in run order — the chain's shape. */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  "discretization",
  "ik",
  "motion-plan",
  "collision",
  "export",
] as const;

/** Slack on the stage's limit comparisons, absorbing roundoff. */
const LIMIT_SLACK = 1e-9;

/**
 * Slack on the cyclic-joint span test: a joint whose limits cover a
 * full circle minus this slack is cyclic — its angle representation
 * wraps at ±π while the motion itself is continuous (ADR 0021).
 */
const CYCLE_SPAN_SLACK = 1e-9;

/**
 * The nearest representative of `value` within ±π of `previous`
 * (ADR 0021): a cyclic joint's solved angle continues from the previous
 * sample's representative instead of jumping 2π across atan2's branch
 * cut, so the interpolated motion never chases a fake revolution.
 */
function unwrapAngle(value: number, previous: number): number {
  const delta = ((value - previous + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return previous + delta;
}

/**
 * Slack on the row-to-row continuity budget: joint motion between two
 * rows may slightly exceed `maxVelocity · 20 ms` because velocity
 * peaks between grid rows; 5 % absorbs that without letting real
 * jumps through.
 */
const CONTINUITY_SLACK = 1.05;

/** One validation stage's outcome, as shown in the generation log. */
export interface PipelineStageOutcome {
  /** The stage that ran. */
  readonly stage: PipelineStage;
  /** Operator-readable summary of what the stage produced. */
  readonly detail: string;
}

/** Pipeline input: the drawn Segments, the Robot Model, and the Planner. */
export interface PipelineInput {
  /** The Trajectory the operator drew (Home Point + Segments). */
  readonly trajectory: Trajectory;
  /** The Robot Model solving IK and verifying limits. */
  readonly model: RobotModel;
  /** The Planner time-parameterizing the solved path. */
  readonly planner: Planner;
}

/** Pipeline output: the Motion Plan, both exporters' CSVs, and the Motion Preview GIF. */
export interface PipelineResult {
  /** The validated Motion Plan (input to plots and charts). */
  readonly plan: MotionPlan;
  /** Robot CSV bytes — the file the real controller consumes (ADR 0006). */
  readonly robotCsv: string;
  /** RViz CSV bytes — the sign-transformed visualization variant. */
  readonly rvizCsv: string;
  /**
   * Motion Preview GIF bytes — the animated isometric preview of the
   * plan (robot skeleton, Trajectory, travelled highlight, Home Point,
   * PTP TCP trace), written as `robot_motion.gif` next to the CSVs.
   */
  readonly motionGif: Uint8Array;
  /** Every stage's outcome, in run order; all succeeded. */
  readonly stages: readonly PipelineStageOutcome[];
}

/**
 * Runs the full headless pipeline: discretizes the Trajectory, solves
 * every sample with the Robot Model, plans the joint motion, applies
 * the reserved collision no-op, and renders both CSV exports — each
 * stage validating its own output. Throws a `PipelineError` naming the
 * first stage that fails; on success returns the plan, the exported
 * bytes, and every stage's outcome.
 */
export function runPipeline(input: PipelineInput): PipelineResult {
  const { path, outcome: discretizationOutcome } = runDiscretizationStage(input.trajectory);
  const { solutions, outcome: ikOutcome } = runIkStage(path, input.model);
  const { plan, outcome: planOutcome } = runMotionPlanStage(input, path, solutions);
  const stages: PipelineStageOutcome[] = [discretizationOutcome, ikOutcome, planOutcome, runCollisionStage()];

  const robotCsv = toRobotCsv(plan);
  const rvizCsv = toRvizCsv(plan);
  const motionGif = renderMotionPreviewGif({ trajectory: input.trajectory, plan, model: input.model });
  stages.push({
    stage: "export",
    detail: `Robot CSV: ${plan.rows.length} rows, ${robotCsv.length} characters; RViz CSV: ${rvizCsv.length} characters; Motion Preview GIF: ${motionGif.frameCount} frames, ${motionGif.bytes.length} bytes (robot_motion.gif)`,
  });
  verifyExportedArrays(robotCsv, rvizCsv, plan);

  return { plan, robotCsv, rvizCsv, motionGif: motionGif.bytes, stages };
}

/**
 * Stage 1 — discretization: samples the Trajectory and validates the
 * path: non-empty, positive pen travel, finite positions, positive
 * feeds, non-decreasing cumulative length.
 */
function runDiscretizationStage(traj: Trajectory): {
  readonly path: DiscretizedPath;
  readonly outcome: PipelineStageOutcome;
} {
  let path: DiscretizedPath;
  try {
    path = discretizeTrajectory(traj);
  } catch (error) {
    if (error instanceof CoreError) {
      throw new PipelineError("discretization", `the trajectory cannot be sampled: ${error.message}`);
    }
    throw error;
  }
  if (path.samples.length === 0) {
    throw new PipelineError(
      "discretization",
      "the trajectory has no drawable geometry: it holds no Segments to sample",
    );
  }
  if (!(path.totalLengthMm > 0)) {
    throw new PipelineError(
      "discretization",
      "the trajectory draws nothing: total pen travel is 0 mm",
    );
  }
  path.samples.forEach((sample, i) => {
    const p = sample.position;
    if (![p.x, p.y, p.z, sample.pathLengthMm, sample.feed].every(Number.isFinite)) {
      throw new PipelineError(
        "discretization",
        `sample ${i} has a non-finite position, path length, or feed`,
      );
    }
    if (!(sample.feed > 0)) {
      throw new PipelineError("discretization", `sample ${i} carries a non-positive feed (${sample.feed})`);
    }
    const prev = path.samples[i - 1];
    if (prev && sample.pathLengthMm < prev.pathLengthMm) {
      throw new PipelineError(
        "discretization",
        `sample ${i} sits at ${sample.pathLengthMm} mm, behind sample ${i - 1} at ${prev.pathLengthMm} mm`,
      );
    }
  });
  return {
    path,
    outcome: {
      stage: "discretization",
      detail: `path sampled: ${path.samples.length} points over ${path.totalLengthMm.toFixed(1)} mm of pen travel`,
    },
  };
}

/**
 * Stage 2 — ik: solves every sample with the Robot Model. The first
 * named IK failure stops the pipeline with the Segment, the point, and
 * the violated limit spelled out.
 */
function runIkStage(
  path: DiscretizedPath,
  model: RobotModel,
): {
  readonly solutions: readonly (readonly number[])[];
  readonly outcome: PipelineStageOutcome;
} {
  const solutions: (readonly number[])[] = [];
  // Cyclic joints (limits spanning the full circle, e.g. MiKo-mini's
  // q1) unwrap sample-to-sample; limited joints can never jump 2π
  // between adjacent samples and keep their solved values (ADR 0021).
  const cyclic = model.joints.map((joint) => joint.maxRad - joint.minRad >= 2 * Math.PI - CYCLE_SPAN_SLACK);
  for (let i = 0; i < path.samples.length; i++) {
    const sample = path.samples[i] as PathSample;
    const target: [number, number, number] = [sample.position.x, sample.position.y, sample.position.z];
    const result = model.inverseKinematics(target);
    if (result.status !== "ok") {
      throw new PipelineError("ik", describeIkFailure(result, sample, model.joints.length));
    }
    if (result.joints.length !== model.joints.length || !result.joints.every(Number.isFinite)) {
      throw new PipelineError(
        "ik",
        `segment ${sample.segmentIndex}: the model returned ${result.joints.length} joint angle(s) at ${fmtPoint(sample.position)}, expected ${model.joints.length} finite ones`,
      );
    }
    const previous = solutions[solutions.length - 1];
    solutions.push(
      result.joints.map((value, j) =>
        cyclic[j] && previous ? unwrapAngle(value, previous[j] as number) : value,
      ),
    );
  }
  return {
    solutions,
    outcome: {
      stage: "ik",
      detail: `inverse kinematics: ${solutions.length} of ${path.samples.length} samples solved, all within joint limits`,
    },
  };
}

/** Turns a named IK failure into an operator-readable stage reason. */
function describeIkFailure(
  result: Exclude<IKResult, { status: "ok" }>,
  sample: PathSample,
  jointCount: number,
): string {
  const where = `segment ${sample.segmentIndex}: point ${fmtPoint(sample.position)} (path position ${sample.pathLengthMm.toFixed(1)} mm)`;
  switch (result.status) {
    case "unreachable":
      return `${where} is outside the robot's workspace — the robot cannot reach it`;
    case "angle-limit":
      return `${where} needs joint ${result.joint} at ${result.valueRad.toFixed(4)} rad, past its ${result.bound} limit of ${result.limitRad.toFixed(4)} rad`;
    case "fk-error":
      return `${where} cannot be verified: the solved ${jointCount} joint angles land at ${fmtVec(result.achieved)}, not on the requested point`;
  }
}

/**
 * Stage 3 — motion-plan: runs the Planner on the solved path. Planner
 * failures (`MotionError`s are the planner's named operator errors)
 * are re-thrown as motion-plan stage failures; the plan itself is then
 * verified against the pipeline invariants.
 */
function runMotionPlanStage(
  input: PipelineInput,
  path: DiscretizedPath,
  solutions: readonly (readonly number[])[],
): { readonly plan: MotionPlan; readonly outcome: PipelineStageOutcome } {
  let plan: MotionPlan;
  try {
    plan = input.planner.plan({ path, solutions });
  } catch (error) {
    if (error instanceof MotionError) {
      throw new PipelineError("motion-plan", error.message);
    }
    throw error;
  }
  verifyMotionPlan(plan, input.model, path.totalLengthMm);
  return {
    plan,
    outcome: {
      stage: "motion-plan",
      detail: `motion plan: ${plan.rows.length} rows over ${plan.durationMs} ms across ${plan.ranges.length} planned segment(s)`,
    },
  };
}

/**
 * Validates the Motion Plan against the pipeline invariants: rows on
 * the 20 ms control grid and strictly increasing, `durationMs` matching
 * the last row, ranges chaining from 0, every value finite, motion
 * continuous between rows, and every row within the Robot Model's
 * dynamic limits.
 */
function verifyMotionPlan(plan: MotionPlan, model: RobotModel, totalLengthMm: number): void {
  if (plan.rows.length === 0) {
    throw new PipelineError(
      "motion-plan",
      `the Motion Plan holds no rows for a ${totalLengthMm.toFixed(1)} mm path`,
    );
  }
  plan.rows.forEach((row, i) => {
    if (row.tMs !== i * CONTROL_STEP_MS) {
      throw new PipelineError(
        "motion-plan",
        `row ${i} sits at ${row.tMs} ms, expected ${i * CONTROL_STEP_MS} ms on the 20 ms control grid`,
      );
    }
  });
  const last = plan.rows[plan.rows.length - 1];
  if (!last || plan.durationMs !== last.tMs) {
    throw new PipelineError(
      "motion-plan",
      `the plan duration ${plan.durationMs} ms does not match the last row at ${last?.tMs} ms`,
    );
  }
  plan.ranges.forEach((range, i) => {
    const expectedStart = i === 0 ? 0 : (plan.ranges[i - 1] as (typeof plan.ranges)[number]).endMs;
    if (range.startMs !== expectedStart) {
      throw new PipelineError(
        "motion-plan",
        `range ${i} (segment ${range.segmentIndex}) starts at ${range.startMs} ms, expected to continue at ${expectedStart} ms`,
      );
    }
  });
  const stepS = CONTROL_STEP_MS / 1000;
  for (let i = 0; i < plan.rows.length; i++) {
    const row = plan.rows[i] as (typeof plan.rows)[number];
    const prev = plan.rows[i - 1];
    row.q.forEach((value, j) => {
      if (![value, row.qd[j], row.qdd[j], row.qddd[j]].every(Number.isFinite)) {
        throw new PipelineError("motion-plan", `row ${i} has a non-finite value at joint ${j}`);
      }
      const limit = model.joints[j];
      if (limit === undefined) {
        throw new PipelineError(
          "motion-plan",
          `row ${i} carries joint ${j}, but the Robot Model has ${model.joints.length} joints`,
        );
      }
      const prevQ = prev?.q[j];
      if (prevQ !== undefined && Math.abs(value - prevQ) > limit.maxVelocityRadS * stepS * CONTINUITY_SLACK) {
        throw new PipelineError(
          "motion-plan",
          `motion jumps ${Math.abs(value - prevQ).toFixed(4)} rad between rows ${i - 1} and ${i} at joint ${j} — the path is not continuous`,
        );
      }
      if (
        Math.abs(row.qd[j] as number) > limit.maxVelocityRadS + LIMIT_SLACK ||
        Math.abs(row.qdd[j] as number) > limit.maxAccelerationRadS2 + LIMIT_SLACK ||
        Math.abs(row.qddd[j] as number) > limit.maxJerkRadS3 + LIMIT_SLACK
      ) {
        throw new PipelineError(
          "motion-plan",
          `row ${i} at ${row.tMs} ms exceeds joint ${j}'s dynamic limits (velocity ${row.qd[j]}, acceleration ${row.qdd[j]}, jerk ${row.qddd[j]})`,
        );
      }
    });
  }
}

/**
 * Stage 4 — collision: reserved no-op. Deliberately empty in v1
 * (GLOSSARY.md); it stays in the chain so collision checking can be
 * added later without reshaping the pipeline.
 */
function runCollisionStage(): PipelineStageOutcome {
  return {
    stage: "collision",
    detail: "collision check: skipped — reserved stage, no collision checking in this version",
  };
}

/**
 * Stage 5 validation — exported arrays: parses both CSV exports back
 * and checks them against the plan (header, one row per plan row, the
 * integer-millisecond time column, joint values within the six-decimal
 * formatting precision). A defect here means an exporter bug, and the
 * bytes must not leave the pipeline.
 */
function verifyExportedArrays(robotCsv: string, rvizCsv: string, plan: MotionPlan): void {
  checkExportedArrays(robotCsv, plan, (row) => [...row.q], "Robot CSV");
  checkExportedArrays(rvizCsv, plan, (row) => [...rvizAngles(row.q)], "RViz CSV");
}

/** Checks one exported CSV's arrays against the plan rows. */
function checkExportedArrays(
  csv: string,
  plan: MotionPlan,
  expectedJoints: (row: (typeof plan.rows)[number]) => readonly number[],
  what: string,
): void {
  const lines = csv.split("\n");
  if (lines[lines.length - 1] !== "") {
    throw new PipelineError("export", `${what} must end with a newline`);
  }
  const body = lines.slice(0, -1);
  if (body[0] !== "t,q1,q2,q3") {
    throw new PipelineError("export", `${what} header must be exactly "t,q1,q2,q3", got "${body[0]}"`);
  }
  const dataRows = body.slice(1);
  if (dataRows.length !== plan.rows.length) {
    throw new PipelineError(
      "export",
      `${what} holds ${dataRows.length} data rows for a plan of ${plan.rows.length} rows`,
    );
  }
  for (let i = 0; i < dataRows.length; i++) {
    const cells = (dataRows[i] as string).split(",");
    if (cells.length !== 4) {
      throw new PipelineError("export", `${what} row ${i} has ${cells.length} columns, expected 4`);
    }
    if (cells[0] !== String((plan.rows[i] as (typeof plan.rows)[number]).tMs)) {
      throw new PipelineError(
        "export",
        `${what} row ${i} has time "${cells[0]}", expected "${String((plan.rows[i] as (typeof plan.rows)[number]).tMs)}" ms on the 20 ms grid`,
      );
    }
    const expected = expectedJoints(plan.rows[i] as (typeof plan.rows)[number]);
    for (let j = 1; j < cells.length; j++) {
      const parsed = Number(cells[j]);
      if (!Number.isFinite(parsed)) {
        throw new PipelineError("export", `${what} row ${i} joint ${j - 1} is not a finite number ("${cells[j]}")`);
      }
      if (Math.abs(parsed - (expected[j - 1] as number)) > 5e-7) {
        throw new PipelineError(
          "export",
          `${what} row ${i} joint ${j - 1} is ${parsed} rad, expected ${expected[j - 1]} rad within formatting precision`,
        );
      }
    }
  }
}

/** Formats a core position for operator-readable messages, in mm. */
function fmtPoint(p: { readonly x: number; readonly y: number; readonly z: number }): string {
  return `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`;
}

/** Formats a kinematics tuple position for operator-readable messages, in mm. */
function fmtVec(v: readonly [number, number, number]): string {
  return `(${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)})`;
}
