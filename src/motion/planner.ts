/**
 * The Planner seam (ADR 0004): a discretized path plus per-sample joint
 * solutions in, a time-parameterized Motion Plan out. The v1 planner —
 * `createSplinePlanner` — interpolates joint angles along path length
 * per Segment with a C³ quintic spline (ADR 0022), follows a quintic
 * smoothstep S-curve Motion Profile, and iteratively scales each
 * Segment's traverse time until the Robot Model's velocity,
 * acceleration, and jerk limits hold — probed at the control rows, the
 * Segment's endpoints, and every knot crossing.
 *
 * Plan contract (the pipeline's Validation stages, GLOSSARY.md):
 *
 * - Rows sit exactly on the 20 ms control step (`CONTROL_STEP_MS`),
 *   strictly increasing, from 0 to the grid-rounded total duration.
 * - Motion is continuous: every Segment starts exactly where the
 *   previous one ended (merged joins contribute no duplicate motion),
 *   the S-curve has zero velocity and acceleration at boundaries, and
 *   the spline keeps velocity, acceleration, and jerk continuous
 *   across every knot (C³, ADR 0022).
 * - Joint positions stay within the Robot Model's position limits and
 *   the dynamic limits hold not only at the rows but between them:
 *   every plan is verified at the control rows, the Segment endpoints,
 *   and every knot crossing before it leaves the Planner.
 * - Ranges are split by Segment and Feed: each planned Segment gets one
 *   time range whose length the Feed sets (mean tangential speed =
 *   Feed), stretched by time scaling until the dynamic limits hold and
 *   floored at one control step, so every range owns at least one row
 *   and no planned Segment's motion can drop off the grid.
 * - Total duration is capped: a plan past 15 minutes fails with a named
 *   `PlanDurationExceeded` (ADR 0021) instead of delivering hours of
 *   unusable motion that downstream renderers would choke on.
 * - Input or output that cannot satisfy the contract fails with a
 *   named `MotionError`.
 */

import type { DiscretizedPath } from "../core/discretize";
import type { Feed } from "../core/trajectory";
import type { JointAngles, JointConfig, RobotModel } from "../kinematics/robot-model";
import { MotionError } from "./errors";
import { sCurveAt } from "./profile";
import { quinticSpline, type QuinticSpline } from "./spline";

/** Control step of the plan's time grid, in milliseconds (ADR 0006). */
export const CONTROL_STEP_MS = 20;

/** Safety margin applied to each time-scaling growth step (2 %). */
const TIME_SCALE_SAFETY = 1.02;

/** Iteration cap of the time-scaling loop before it fails loudly. */
const MAX_SCALE_ITERATIONS = 64;

/**
 * Total-plan duration cap. An operator's own Feed choice and the
 * dynamic limits may legitimately demand slow motion, but a plan past
 * this cap signals a pathological trajectory (e.g. a fake base
 * revolution from an ±π branch cut in the joint solutions) rather than
 * slow progress — it fails loudly instead of freezing the downstream
 * renderers on hours of rows (ADR 0021).
 */
const MAX_PLAN_DURATION_MS = 15 * 60 * 1000;

/**
 * Scaling budget: a Segment stretched beyond this multiple of its
 * Feed-nominal duration signals unusable dynamic limits (zero or
 * vanishing) rather than slow motion, and fails loudly before the grid
 * probing of the next round grows unbounded.
 */
const MAX_TIME_SCALEUP = 10_000;

/** Slack on limit comparisons, absorbing roundoff in the limit check. */
const LIMIT_SLACK = 1e-9;

/**
 * Slack on the cyclic-joint span test: a joint whose limits cover a
 * full circle minus this slack is cyclic — its (unwrapped) plan values
 * may numerically leave the stored range while naming the same physical
 * pose, so position checks compare its wrapped representative (ADR 0021).
 */
const CYCLE_SPAN_SLACK = 1e-9;

/** One row of the Motion Plan: the joint state at one control moment. */
export interface MotionRow {
  /** Row time in milliseconds, a multiple of {@link CONTROL_STEP_MS}. */
  readonly tMs: number;
  /** Index of the Segment being traversed at this moment. */
  readonly segmentIndex: number;
  /** Joint positions in radians. */
  readonly q: JointAngles;
  /** Joint velocities in rad/s. */
  readonly qd: JointAngles;
  /** Joint accelerations in rad/s². */
  readonly qdd: JointAngles;
  /** Joint jerks in rad/s³. */
  readonly qddd: JointAngles;
}

/**
 * The time range one Segment occupies in the plan. Ranges chain end to
 * start across the plan and split it by Segment and Feed; `endMs` is
 * exclusive (equal to the next range's `startMs`), except the last
 * range whose profile end is the plan's unrounded duration.
 */
export interface PlanSegmentRange {
  /** Index of the Segment in the Trajectory. */
  readonly segmentIndex: number;
  /** Feed the traverse time of this range follows, mm/s. */
  readonly feed: Feed;
  /** Range start in milliseconds (inclusive). */
  readonly startMs: number;
  /** Range end in milliseconds (exclusive; profile end of the last). */
  readonly endMs: number;
}

/**
 * A Motion Plan (GLOSSARY.md): the time-parameterized joint motion —
 * positions, velocities, accelerations, jerks over time — within the
 * Robot Model's limits.
 */
export interface MotionPlan {
  /** Rows on the 20 ms control step, strictly increasing in time. */
  readonly rows: readonly MotionRow[];
  /** Per-Segment time ranges, chaining from 0 to the total duration. */
  readonly ranges: readonly PlanSegmentRange[];
  /** Time of the last row in milliseconds (grid-rounded duration). */
  readonly durationMs: number;
}

/** Planner input: the discretized path with one joint solution per sample. */
export interface PlannerInput {
  /** The Trajectory sampled by the Discretization. */
  readonly path: DiscretizedPath;
  /**
   * IK joint solutions, aligned with `path.samples` by index: the
   * solution for the pen pose of sample i at position i. Failed
   * (unreachable / limit-violating) samples are a pipeline validation
   * stage upstream of planning and are rejected here.
   */
  readonly solutions: readonly JointAngles[];
}

/**
 * The Planner seam: discretized path + joint solutions in,
 * time-parameterized joint motion out (ADR 0004).
 */
export interface Planner {
  /** Plans the Motion Plan for the given path and joint solutions. */
  plan(input: PlannerInput): MotionPlan;
}

/** One Segment's planning material collected from the path. */
interface SegmentPlan {
  /** Segment index in the Trajectory. */
  readonly segmentIndex: number;
  /** Feed of the Segment, mm/s. */
  readonly feed: number;
  /** Path-length window [sStart, sEnd] the Segment's motion spans, mm. */
  readonly sStart: number;
  readonly sEnd: number;
  /** C³ quintic spline interpolant per joint over the Segment's knots. */
  readonly interpolants: readonly QuinticSpline[];
  /** Normalized profile times of the Segment's interior knot crossings. */
  readonly knotTaus: readonly number[];
  /** Per-joint dynamic limits of the Robot Model. */
  readonly limits: readonly JointConfig[];
}

/** A scaled Segment: its plan, when its motion starts, and how long it takes. */
interface ScaledSegment {
  readonly seg: SegmentPlan;
  readonly tStartMs: number;
  readonly durationMs: number;
}

/**
 * The v1 Planner: per-Segment C³ quintic-spline q(s) + quintic
 * smoothstep S-curve profile + iterative time scaling against the
 * Robot Model's limits (ADR 0022).
 */
export function createSplinePlanner(model: RobotModel): Planner {
  const jointCount = model.joints.length;

  const plan = (input: PlannerInput): MotionPlan => {
    validateInput(input, jointCount);

    const segments = collectSegmentPlans(input, model);

    // Sequentially time-scale each Segment on the global grid: the
    // start time of one Segment is the scaled end of its predecessor.
    const scaled: ScaledSegment[] = [];
    let tStartMs = 0;
    for (const seg of segments) {
      const durationMs = scaleSegmentDuration(seg, tStartMs);
      scaled.push({ seg, tStartMs, durationMs });
      tStartMs += durationMs;
    }

    const totalMs = tStartMs;
    if (totalMs > MAX_PLAN_DURATION_MS) {
      const worst = scaled.reduce((a, b) => (stretchOf(b) > stretchOf(a) ? b : a));
      throw new MotionError(
        "PlanDurationExceeded",
        `the plan would run ${(totalMs / 60000).toFixed(1)} minutes, past the ${MAX_PLAN_DURATION_MS / 60000}-minute cap — segment ${worst.seg.segmentIndex} stretches ${stretchOf(worst).toFixed(0)}× past its Feed-nominal time: check the trajectory near singular stretches and the Robot Model's dynamic limits`,
      );
    }
    const ranges: PlanSegmentRange[] = scaled.map(({ seg, tStartMs: start, durationMs }) => ({
      segmentIndex: seg.segmentIndex,
      feed: seg.feed,
      startMs: start,
      endMs: start + durationMs,
    }));

    const rows = emitRows(scaled, totalMs, jointCount);
    verifyPlan(model, scaled, ranges, rows);

    return {
      rows,
      ranges,
      durationMs: (rows[rows.length - 1] as MotionRow | undefined)?.tMs ?? 0,
    };
  };

  return { plan };
}

/** Validates the planner input; throws a named `InvalidSolution` on any defect. */
function validateInput(input: PlannerInput, jointCount: number): void {
  if (input.solutions.length !== input.path.samples.length) {
    throw new MotionError(
      "InvalidSolution",
      `solutions (${input.solutions.length}) must align with path samples (${input.path.samples.length})`,
    );
  }
  input.solutions.forEach((q, i) => {
    if (q.length !== jointCount) {
      throw new MotionError(
        "InvalidSolution",
        `solution ${i} has ${q.length} joints, the Robot Model has ${jointCount}`,
      );
    }
    if (!q.every(Number.isFinite)) {
      throw new MotionError("InvalidSolution", `solution ${i} has a non-finite joint angle`);
    }
  });
  for (const sample of input.path.samples) {
    if (!(Number.isFinite(sample.feed) && sample.feed > 0)) {
      throw new MotionError(
        "InvalidSolution",
        `sample at ${sample.pathLengthMm} mm carries a non-positive feed (${sample.feed})`,
      );
    }
  }
}

/**
 * Groups the samples into per-Segment runs and builds each run's C³
 * quintic-spline interpolants over path length. The run's s-window
 * starts where the previous planned Segment ended, so a merged join (the next
 * Segment's start sample dropped by the Discretization) is bridged by
 * prepending the shared boundary pose: duplicates produce no motion.
 * Runs without a path-length span (zero-length Segments merged away)
 * contribute no range and no rows.
 */
function collectSegmentPlans(input: PlannerInput, model: RobotModel): SegmentPlan[] {
  const samples = input.path.samples;
  const segments: SegmentPlan[] = [];
  let sStart = 0;
  let boundaryQ: JointAngles | undefined;
  let i = 0;
  while (i < samples.length) {
    const segIndex = samples[i]!.segmentIndex;
    const feed = samples[i]!.feed;
    let j = i;
    while (j < samples.length && samples[j]!.segmentIndex === segIndex) j++;
    const runLength = j - i;
    const sEnd = samples[j - 1]!.pathLengthMm;

    if (sEnd > sStart) {
      const knots: { s: number; q: JointAngles }[] = [];
      const first = samples[i]!;
      if (first.pathLengthMm > sStart) {
        // The join was merged away: start from the shared boundary pose.
        if (boundaryQ === undefined) {
          throw new MotionError(
            "InvalidSolution",
            `segment ${segIndex} starts past ${sStart} mm with no boundary pose to continue from`,
          );
        }
        knots.push({ s: sStart, q: boundaryQ });
      }
      for (let k = 0; k < runLength; k++) {
        knots.push({ s: samples[i + k]!.pathLengthMm, q: input.solutions[i + k] as JointAngles });
      }
      const interpolants: QuinticSpline[] = [];
      const knotSs = knots.map((knot) => knot.s);
      for (let joint = 0; joint < model.joints.length; joint++) {
        interpolants.push(quinticSpline(knotSs, knots.map((knot) => knot.q[joint] as number)));
      }
      segments.push({
        segmentIndex: segIndex,
        feed,
        sStart,
        sEnd,
        interpolants,
        knotTaus: knotCrossingTaus(knotSs, sStart, sEnd),
        limits: model.joints,
      });
      boundaryQ = knots[knots.length - 1]!.q;
      sStart = sEnd;
    } else {
      // Zero-length span (e.g. a Point merged into the start pose): its
      // pose still owns the boundary s for the next Segment's join.
      boundaryQ = input.solutions[j - 1];
    }
    i = j;
  }
  return segments;
}

/** A scaled Segment's duration as a multiple of its Feed-nominal time. */
function stretchOf(scaled: ScaledSegment): number {
  const nominalMs = Math.max(1, ((scaled.seg.sEnd - scaled.seg.sStart) / scaled.seg.feed) * 1000);
  return scaled.durationMs / nominalMs;
}

/**
 * Iteratively stretches the Segment's duration until velocity,
 * acceleration, and jerk at every probe time — the control rows, the
 * Segment's endpoints, and every knot crossing — respect every joint's
 * dynamic limits. The nominal duration follows the Feed (mean
 * tangential speed = Feed), floored at one control step: a Segment
 * finishing inside a single grid gap would own no row and its motion
 * would vanish from the plan. Each round grows the duration by the
 * worst required factor — velocity scales as 1/T, acceleration as 1/T²,
 * jerk as 1/T³ — plus a small safety margin.
 */
function scaleSegmentDuration(seg: SegmentPlan, tStartMs: number): number {
  const lengthMm = seg.sEnd - seg.sStart;
  const nominalMs = (lengthMm / seg.feed) * 1000;
  let durationMs = Math.max(nominalMs, CONTROL_STEP_MS);
  for (let iteration = 0; iteration < MAX_SCALE_ITERATIONS; iteration++) {
    let needed = 1;
    for (const tau of probeTaus(seg, tStartMs, durationMs)) {
      const profile = sCurveAt({ lengthMm, durationS: durationMs / 1000 }, (tau * durationMs) / 1000);
      seg.interpolants.forEach((interp, joint) => {
        const limit = seg.limits[joint] as JointConfig;
        const { qd, qdd, qddd } = jointMotionAt(interp, seg.sStart + profile.s, profile);
        needed = Math.max(
          needed,
          Math.abs(qd) / limit.maxVelocityRadS,
          Math.sqrt(Math.abs(qdd) / limit.maxAccelerationRadS2),
          Math.cbrt(Math.abs(qddd) / limit.maxJerkRadS3),
        );
      });
    }
    if (needed <= 1) return durationMs;
    durationMs *= needed * TIME_SCALE_SAFETY;
    if (!Number.isFinite(durationMs) || durationMs > nominalMs * MAX_TIME_SCALEUP) {
      throw new MotionError(
        "TimeScalingFailed",
        `segment ${seg.segmentIndex} needs more than a ${MAX_TIME_SCALEUP}× stretch of its ${nominalMs} ms nominal duration: the dynamic limits cannot be met`,
      );
    }
  }
  throw new MotionError(
    "TimeScalingFailed",
    `segment ${seg.segmentIndex} could not meet the dynamic limits within ${MAX_SCALE_ITERATIONS} scaling iterations`,
  );
}

/**
 * The normalized profile times the scaling loop and the verifier both
 * probe: both profile endpoints (where the quintic S-curve's jerk
 * peaks), every control-grid moment inside the Segment's window, and
 * every interior knot crossing (where the spline's derivatives move
 * fastest). Scaling and verification share this set, so what scaling
 * accepted is exactly what verification re-checks.
 */
function* probeTaus(seg: SegmentPlan, tStartMs: number, durationMs: number): Generator<number> {
  yield 0;
  const tEndMs = tStartMs + durationMs;
  for (let tMs = Math.ceil(tStartMs / CONTROL_STEP_MS) * CONTROL_STEP_MS; tMs <= tEndMs; tMs += CONTROL_STEP_MS) {
    if (tMs > tStartMs) yield (tMs - tStartMs) / durationMs;
  }
  yield* seg.knotTaus;
  yield 1;
}

/**
 * The normalized profile times at which the Segment's path length
 * crosses each interior knot: `sStart + length·sig(τ) = knotS` solved
 * by bisection (the S-curve's σ is monotone non-decreasing). The taus
 * depend only on the Segment's geometry, not its duration, so they are
 * computed once at planning time.
 */
function knotCrossingTaus(knotSs: readonly number[], sStart: number, sEnd: number): number[] {
  const lengthMm = sEnd - sStart;
  const taus: number[] = [];
  for (const knotS of knotSs) {
    if (!(knotS > sStart + 1e-9 && knotS < sEnd - 1e-9)) continue;
    let lo = 0;
    let hi = 1;
    for (let step = 0; step < 60; step++) {
      const mid = (lo + hi) / 2;
      const sigma = 6 * mid ** 5 - 15 * mid ** 4 + 10 * mid ** 3;
      if (sStart + lengthMm * sigma < knotS) lo = mid;
      else hi = mid;
    }
    taus.push((lo + hi) / 2);
  }
  return taus;
}

/**
 * One probe's joint velocities, accelerations, and jerks: the spline's
 * path-length derivatives chained with the Motion Profile's time
 * derivatives (the Planner's single definition of joint motion).
 */
function jointMotionAt(
  interp: QuinticSpline,
  s: number,
  profile: { readonly ds: number; readonly dds: number; readonly ddds: number },
): { readonly qd: number; readonly qdd: number; readonly qddd: number } {
  const { dq, ddq, dddq } = interp.evalWithDerivatives(s);
  return {
    qd: dq * profile.ds,
    qdd: ddq * profile.ds * profile.ds + dq * profile.dds,
    qddd: dddq * profile.ds ** 3 + 3 * ddq * profile.ds * profile.dds + dq * profile.ddds,
  };
}

/**
 * Emits the plan's rows on the global control grid: row j at exactly
 * j·20 ms, owned by the last Segment whose window contains it (so a
 * boundary moment shows the Segment starting there), each Segment
 * evaluated through its S-curve and spline interpolants with the
 * chain-rule derivatives in time. The final row clamps to the last
 * Segment's end pose when the duration is not grid-aligned.
 */
function emitRows(scaled: readonly ScaledSegment[], totalMs: number, jointCount: number): MotionRow[] {
  const rows: MotionRow[] = [];
  if (scaled.length === 0 || totalMs === 0) return rows;
  const lastRow = Math.ceil(totalMs / CONTROL_STEP_MS);
  for (let j = 0; j <= lastRow; j++) {
    const tMs = j * CONTROL_STEP_MS;
    let k = scaled.length - 1;
    while (k > 0 && scaled[k]!.tStartMs > tMs) k--;
    const { seg, tStartMs, durationMs } = scaled[k]!;
    const tau = Math.min(1, Math.max(0, (tMs - tStartMs) / durationMs));
    const profile = sCurveAt({ lengthMm: seg.sEnd - seg.sStart, durationS: durationMs / 1000 }, (tau * durationMs) / 1000);
    const s = seg.sStart + profile.s;

    const q: number[] = [];
    const qd: number[] = [];
    const qdd: number[] = [];
    const qddd: number[] = [];
    for (let joint = 0; joint < jointCount; joint++) {
      const interp = seg.interpolants[joint] as QuinticSpline;
      q.push(interp.evalWithDerivatives(s).q);
      const { qd: jointQd, qdd: jointQdd, qddd: jointQddd } = jointMotionAt(interp, s, profile);
      qd.push(jointQd);
      qdd.push(jointQdd);
      qddd.push(jointQddd);
    }
    rows.push({ tMs, segmentIndex: seg.segmentIndex, q, qd, qdd, qddd });
  }
  return rows;
}

/**
 * Validates the plan output against the contract: every range owns at
 * least one row (no Segment's motion dropped off the grid), rows sit
 * on the control grid, strictly increasing, finite, within the Robot
 * Model's position and dynamic limits — and the motion between rows
 * holds those limits too, probed at the Segment endpoints and every
 * knot crossing through the same probe set the scaling loop used
 * (ADR 0022: the spline may overshoot between knots; a plan that
 * exceeds any limit anywhere fails here, never in export). The stages
 * of the pipeline validate their own output (GLOSSARY.md); a defect
 * here is a named `VerificationFailed`.
 */
function verifyPlan(model: RobotModel, scaled: readonly ScaledSegment[], ranges: readonly PlanSegmentRange[], rows: readonly MotionRow[]): void {
  const cyclic = model.joints.map((joint) => joint.maxRad - joint.minRad >= 2 * Math.PI - CYCLE_SPAN_SLACK);
  const checkPosition = (where: string, joint: number, value: number): void => {
    const limit = model.joints[joint] as JointConfig;
    // Cyclic joints (unwrapped across ±π, ADR 0021) name the same pose
    // at value and value ± 2π: compare the wrapped representative.
    const comparable = cyclic[joint]
      ? limit.minRad + (((value - limit.minRad) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      : value;
    if (comparable < limit.minRad - LIMIT_SLACK || comparable > limit.maxRad + LIMIT_SLACK) {
      throw new MotionError(
        "VerificationFailed",
        `${where} exceeds joint ${joint} position limits (q=${value} against [${limit.minRad}, ${limit.maxRad}])`,
      );
    }
  };
  const checkDynamic = (where: string, joint: number, limit: JointConfig, qd: number, qdd: number, qddd: number): void => {
    if (
      Math.abs(qd) > limit.maxVelocityRadS + LIMIT_SLACK ||
      Math.abs(qdd) > limit.maxAccelerationRadS2 + LIMIT_SLACK ||
      Math.abs(qddd) > limit.maxJerkRadS3 + LIMIT_SLACK
    ) {
      throw new MotionError(
        "VerificationFailed",
        `${where} exceeds joint ${joint} dynamic limits (qd=${qd}, qdd=${qdd}, qddd=${qddd})`,
      );
    }
  };

  for (const range of ranges) {
    const ownsARow = rows.some((row) => row.tMs >= range.startMs && row.tMs < range.endMs);
    if (!ownsARow) {
      throw new MotionError(
        "VerificationFailed",
        `segment ${range.segmentIndex} range [${range.startMs}, ${range.endMs}] ms owns no control rows: its motion dropped off the grid`,
      );
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as MotionRow;
    if (row.tMs !== i * CONTROL_STEP_MS) {
      throw new MotionError(
        "VerificationFailed",
        `row ${i} sits at ${row.tMs} ms, expected ${i * CONTROL_STEP_MS} ms on the control grid`,
      );
    }
    row.q.forEach((value, joint) => {
      const limit = model.joints[joint] as JointConfig;
      if (![value, row.qd[joint], row.qdd[joint], row.qddd[joint]].every(Number.isFinite)) {
        throw new MotionError("VerificationFailed", `row ${i} joint ${joint} has a non-finite value`);
      }
      checkPosition(`row ${i} at ${row.tMs} ms`, joint, value);
      checkDynamic(`row ${i} at ${row.tMs} ms`, joint, limit, row.qd[joint] as number, row.qdd[joint] as number, row.qddd[joint] as number);
    });
  }
  // Between the rows: probe every Segment's endpoints and knot crossings
  // through the same interpolants and profile the rows were emitted from.
  for (const { seg, tStartMs, durationMs } of scaled) {
    const lengthMm = seg.sEnd - seg.sStart;
    for (const tau of probeTaus(seg, tStartMs, durationMs)) {
      const profile = sCurveAt({ lengthMm, durationS: durationMs / 1000 }, (tau * durationMs) / 1000);
      const s = seg.sStart + profile.s;
      const tMs = tStartMs + tau * durationMs;
      seg.interpolants.forEach((interp, joint) => {
        const limit = seg.limits[joint] as JointConfig;
        const value = interp.evalWithDerivatives(s).q;
        const { qd, qdd, qddd } = jointMotionAt(interp, s, profile);
        checkPosition(`segment ${seg.segmentIndex} probe at ${tMs.toFixed(1)} ms`, joint, value);
        checkDynamic(`segment ${seg.segmentIndex} probe at ${tMs.toFixed(1)} ms`, joint, limit, qd, qdd, qddd);
      });
    }
  }
}
