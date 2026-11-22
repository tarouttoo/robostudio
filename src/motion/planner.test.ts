import { describe, expect, it } from "vitest";

import { discretizeTrajectory, type DiscretizedPath } from "../core/discretize";
import { line, point, trajectory, type Feed, type Trajectory } from "../core/trajectory";
import { vec3 } from "../core/vec";
import { DEFAULT_MIKO_MINI_CONFIG } from "../kinematics/miko-mini";
import { createRobotRegistry } from "../kinematics/registry";
import type { JointConfig, JointAngles, RobotModel } from "../kinematics/robot-model";
import { CONTROL_STEP_MS, createPchipPlanner, type MotionPlan, type Planner } from "./planner";
import { MotionError } from "./errors";

/** The default MiKo-mini model from validated configuration. */
function defaultModel(): RobotModel {
  const result = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG]);
  if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);
  const model = result.registry.resolve("miko-mini");
  if (!model) throw new Error("model miko-mini was not resolved");
  return model;
}

/** Discretizes the Trajectory and solves every sample with the Robot Model. */
function planFromTrajectory(planner: Planner, model: RobotModel, traj: Trajectory): MotionPlan {
  return planner.plan(planInputFromTrajectory(model, traj));
}

function planInputFromTrajectory(
  model: RobotModel,
  traj: Trajectory,
): { path: DiscretizedPath; solutions: readonly JointAngles[] } {
  const path = discretizeTrajectory(traj);
  const solutions = path.samples.map((sample) => {
    // The kinematics Vec3 is a tuple; the pipeline's IK stage converts.
    const target: [number, number, number] = [sample.position.x, sample.position.y, sample.position.z];
    const result = model.inverseKinematics(target);
    if (result.status !== "ok") throw new Error(`IK failed at (${target.join(", ")}): ${result.status}`);
    return result.joints;
  });
  return { path, solutions };
}

/** Pen speed between consecutive rows, via forward kinematics, mm/s. */
function expectRowMotionBounded(model: RobotModel, plan: MotionPlan, maxSpeedMmS: number): void {
  const pen = (q: readonly number[]): readonly [number, number, number] => {
    const p = model.forwardKinematics(q);
    return [p[0] as number, p[1] as number, p[2] as number];
  };
  for (let i = 1; i < plan.rows.length; i++) {
    const prev = plan.rows[i - 1] as (typeof plan.rows)[number];
    const cur = plan.rows[i] as (typeof plan.rows)[number];
    const [ax, ay, az] = pen(prev.q);
    const [bx, by, bz] = pen(cur.q);
    const step = Math.hypot(ax - bx, ay - by, az - bz);
    const budget = maxSpeedMmS * (CONTROL_STEP_MS / 1000) * 1.05; // grid rounding slack
    expect(step).toBeLessThanOrEqual(budget);
  }
}

function expectWithinDynamicLimits(model: RobotModel, plan: MotionPlan): void {
  for (const row of plan.rows) {
    row.q.forEach((value, j) => {
      const limit = model.joints[j] as JointConfig;
      expect(Math.abs(row.qd[j] as number)).toBeLessThanOrEqual(limit.maxVelocityRadS + 1e-9);
      expect(Math.abs(row.qdd[j] as number)).toBeLessThanOrEqual(limit.maxAccelerationRadS2 + 1e-9);
      expect(Math.abs(row.qddd[j] as number)).toBeLessThanOrEqual(limit.maxJerkRadS3 + 1e-9);
    });
  }
}

describe("planner seam: time grid", () => {
  const model = defaultModel();
  const planner = createPchipPlanner(model);

  it("plans a gentle line into strictly monotonic rows at the 20 ms control step", () => {
    const traj = trajectory(vec3(80, 0, 60), [
      line({ start: vec3(80, 0, 60), end: vec3(80, 40, 60), feed: 20 }),
    ]);
    const plan = planFromTrajectory(planner, model, traj);

    expect(plan.rows.length).toBeGreaterThan(10);
    plan.rows.forEach((row, i) => {
      expect(row.tMs).toBe(i * CONTROL_STEP_MS);
    });
    for (let i = 1; i < plan.rows.length; i++) {
      const prev = plan.rows[i - 1] as (typeof plan.rows)[number];
      const cur = plan.rows[i] as (typeof plan.rows)[number];
      expect(cur.tMs).toBeGreaterThan(prev.tMs);
    }
    expect(plan.durationMs).toBe(plan.rows[plan.rows.length - 1]?.tMs ?? 0);
  });

  it("starts at the first sample's joints and ends at the last sample's joints", () => {
    const traj = trajectory(vec3(80, 0, 60), [
      line({ start: vec3(80, 0, 60), end: vec3(80, 40, 60), feed: 20 }),
    ]);
    const { path, solutions } = planInputFromTrajectory(model, traj);
    const plan = planner.plan({ path, solutions });

    const first = path.samples[0];
    const last = path.samples[path.samples.length - 1];
    expect(plan.rows[0]?.q).toEqual(solutions[0]);
    expect(plan.rows[0]?.tMs).toBe(0);
    plan.rows[plan.rows.length - 1]?.q.forEach((value, j) => {
      expect(value).toBeCloseTo(solutions[solutions.length - 1]?.[j] as number, 9);
    });
    void first;
    void last;
  });
  it("keeps velocity, acceleration, and jerk within the Robot Model's dynamic limits", () => {
    const traj = trajectory(vec3(80, 0, 60), [
      line({ start: vec3(80, 0, 60), end: vec3(100, 20, 60), feed: 20 }),
      // Quarter arc, r = 20, about (80, 20, 60).
      {
        kind: "arc",
        plane: "XY",
        start: vec3(100, 20, 60),
        end: vec3(80, 40, 60),
        direction: "CCW",
        center: vec3(80, 20, 60),
        radiusMm: 20,
        sweepRad: Math.PI / 2,
        feed: 20,
      },
    ]);
    const plan = planFromTrajectory(planner, model, traj);
    expect(plan.rows.length).toBeGreaterThan(50);
    expectWithinDynamicLimits(model, plan);
    // Pen motion stays bounded by the peak tangential speed of the profile.
    expectRowMotionBounded(model, plan, 1.875 * 20);
  });

  it("scales traverse time so even an aggressive Segment respects the jerk limit", () => {
    // 2 mm at 200 mm/s: nominal 10 ms, but the joint-space jerk of the
    // tight corner far exceeds 25 rad/s³ — time scaling must stretch it.
    const traj = trajectory(vec3(80, 0, 60), [
      line({ start: vec3(80, 0, 60), end: vec3(80, 2, 60), feed: 200 }),
    ]);
    const plan = planFromTrajectory(planner, model, traj);
    expect(plan.durationMs).toBeGreaterThan((2 / 200) * 1000); // beyond nominal
    expectWithinDynamicLimits(model, plan);
  });

  it("makes the per-Segment Feed set the traverse time of that Segment", () => {
    // A long line keeps the nominal regime (no dynamic-limit scaling).
    const planAt = (feed: Feed): MotionPlan =>
      planFromTrajectory(planner, model, trajectory(vec3(80, 0, 60), [
        line({ start: vec3(80, 0, 60), end: vec3(80, 100, 60), feed }),
      ]));

    const slow = planAt(20);
    const fast = planAt(40);
    // 100 mm at 20 mm/s ≈ 5000 ms; at 40 mm/s ≈ 2500 ms (grid-rounded).
    expect(slow.durationMs).toBeGreaterThanOrEqual(5000);
    expect(slow.durationMs).toBeLessThan(5040);
    expect(fast.durationMs).toBeGreaterThanOrEqual(2500);
    expect(fast.durationMs).toBeLessThan(2540);
  });
});

describe("planner seam: segment boundaries", () => {
  const model = defaultModel();
  const planner = createPchipPlanner(model);

  /** Pen position per row via forward kinematics. */
  const penPositions = (plan: MotionPlan): readonly (readonly number[])[] =>
    plan.rows.map((row) => {
      const p = model.forwardKinematics(row.q);
      return [p[0] as number, p[1] as number, p[2] as number];
    });

  it("keeps motion continuous across a joined Segment boundary", () => {
    const traj = trajectory(vec3(80, 0, 60), [
      line({ start: vec3(80, 0, 60), end: vec3(100, 20, 60), feed: 20 }),
      {
        kind: "arc",
        plane: "XY",
        start: vec3(100, 20, 60),
        end: vec3(80, 40, 60),
        direction: "CCW",
        center: vec3(80, 20, 60),
        radiusMm: 20,
        sweepRad: Math.PI / 2,
        feed: 20,
      },
    ]);
    const plan = planFromTrajectory(planner, model, traj);

    // Time does not jump: every consecutive row pair is exactly one step.
    for (let i = 1; i < plan.rows.length; i++) {
      const prev = plan.rows[i - 1] as (typeof plan.rows)[number];
      const cur = plan.rows[i] as (typeof plan.rows)[number];
      expect(cur.tMs - prev.tMs).toBe(CONTROL_STEP_MS);
    }

    // The pen crosses the boundary in one smooth step, like any other.
    const pens = penPositions(plan);
    const boundaryRow = plan.rows.findIndex((row) => row.segmentIndex === 1);
    expect(boundaryRow).toBeGreaterThan(0);
    const budget = 1.875 * 20 * (CONTROL_STEP_MS / 1000) * 1.05;
    for (const i of [boundaryRow - 1, boundaryRow, boundaryRow + 1]) {
      const a = pens[i] as readonly number[];
      const b = pens[i + 1] as readonly number[];
      expect(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)).toBeLessThanOrEqual(budget);
    }
  });

  it("removes duplicates at an exact Segment join: no zero-length ranges, no repeated poses", () => {
    const traj = trajectory(vec3(80, 0, 60), [
      line({ start: vec3(80, 0, 60), end: vec3(80, 40, 60), feed: 20 }),
      line({ start: vec3(80, 40, 60), end: vec3(80, 80, 60), feed: 20 }),
    ]);
    const plan = planFromTrajectory(planner, model, traj);

    // Both Segments planned, neither as a zero-length stub.
    expect(plan.ranges.map((r) => r.segmentIndex)).toEqual([0, 1]);
    for (const range of plan.ranges) {
      expect(range.endMs).toBeGreaterThan(range.startMs);
    }

    // No two consecutive rows hold the same pose (duplicate motion removed).
    for (let i = 1; i < plan.rows.length; i++) {
      const prev = plan.rows[i - 1] as (typeof plan.rows)[number];
      const cur = plan.rows[i] as (typeof plan.rows)[number];
      expect(cur.q).not.toEqual(prev.q);
    }
  });

  it("splits the plan into ranges by Segment and Feed", () => {
    const traj = trajectory(vec3(80, 0, 60), [
      line({ start: vec3(80, 0, 60), end: vec3(80, 40, 60), feed: 20 }),
      line({ start: vec3(80, 40, 60), end: vec3(80, 80, 60), feed: 5 }),
    ]);
    const plan = planFromTrajectory(planner, model, traj);

    expect(plan.ranges).toHaveLength(2);
    const [first, second] = plan.ranges;
    expect(first?.feed).toBe(20);
    expect(second?.feed).toBe(5);
    // Ranges chain end to start and cover the whole plan.
    expect(first?.startMs).toBe(0);
    expect(second?.startMs).toBe(first?.endMs);
    expect(second?.endMs).toBeCloseTo(plan.durationMs, 9);

    // Ranges own their rows; the slower Feed takes about 4× the time.
    const slowRows = plan.rows.filter((row) => row.segmentIndex === 1).length;
    const fastRows = plan.rows.filter((row) => row.segmentIndex === 0).length;
    expect(slowRows).toBeGreaterThan(fastRows * 3);
    for (const row of plan.rows) {
      const range = plan.ranges[row.segmentIndex];
      expect(range).toBeDefined();
      expect(row.tMs).toBeGreaterThanOrEqual(range!.startMs);
    }
  });

  it("plans a Point Segment transit with its own Feed", () => {
    const traj = trajectory(vec3(80, 0, 60), [
      line({ start: vec3(80, 0, 60), end: vec3(80, 40, 60), feed: 20 }),
      point({ target: vec3(60, 0, 60), feed: 50 }),
      line({ start: vec3(60, 0, 60), end: vec3(60, 40, 60), feed: 20 }),
    ]);
    const plan = planFromTrajectory(planner, model, traj);

    expect(plan.ranges.map((r) => r.segmentIndex)).toEqual([0, 1, 2]);
    expect(plan.ranges[1]?.feed).toBe(50);
    // Time is continuous through the transit; the pen lands on the target.
    for (let i = 1; i < plan.rows.length; i++) {
      expect(plan.rows[i]!.tMs).toBe(plan.rows[i - 1]!.tMs + CONTROL_STEP_MS);
    }
    const [tx, ty, tz] = model.forwardKinematics(plan.rows[plan.rows.length - 1]!.q);
    expect(tx).toBeCloseTo(60, 6);
    expect(ty).toBeCloseTo(40, 6);
    void tz;
  });

  it("plans a Trajectory whose first Segment is a Point coinciding with Home", () => {
    // The Point stands in for the Home Point (within the merge distance):
    // its run contributes no motion, and the joined next Segment starts
    // from its pose instead of crashing on a missing boundary pose.
    const traj = trajectory(vec3(80, 0, 60), [
      point({ target: vec3(80, 0.5, 60), feed: 30 }),
      line({ start: vec3(80, 0.5, 60), end: vec3(80, 40, 60), feed: 20 }),
    ]);
    const plan = planFromTrajectory(planner, model, traj);

    expect(plan.ranges.map((r) => r.segmentIndex)).toEqual([1]);
    expect(plan.rows[0]?.q).toBeDefined();
    // The motion starts from the Point's pose (≈ Home) and stays continuous.
    const [px, py, pz] = model.forwardKinematics(plan.rows[0]!.q);
    expect(px).toBeCloseTo(80, 6);
    expect(py).toBeGreaterThan(0.4);
    expect(py).toBeLessThan(0.6);
    expect(pz).toBeCloseTo(60, 6);
  });

  it("plans an empty Trajectory to an empty plan", () => {
    const plan = planFromTrajectory(planner, model, trajectory(vec3(80, 0, 60), []));
    expect(plan.rows).toEqual([]);
    expect(plan.ranges).toEqual([]);
    expect(plan.durationMs).toBe(0);
  });

  it("rejects defective solutions with named errors", () => {
    const traj = trajectory(vec3(80, 0, 60), [
      line({ start: vec3(80, 0, 60), end: vec3(80, 40, 60), feed: 20 }),
    ]);
    const path = discretizeTrajectory(traj);
    const good = path.samples.map(() => [0, 0, 0] as const);

    expect(() => planner.plan({ path, solutions: good.slice(1) })).toThrow(MotionError);
    expect(() => planner.plan({ path, solutions: good.slice(1) })).toThrow(/align with path samples/);
    expect(() => planner.plan({ path, solutions: path.samples.map(() => [0, 0]) as never })).toThrow(/joints/);
    expect(() => planner.plan({ path, solutions: path.samples.map(() => [Number.NaN, 0, 0]) as never })).toThrow(
      /non-finite/,
    );
    try {
      planner.plan({ path, solutions: good.slice(1) });
      throw new Error("expected a MotionError");
    } catch (error) {
      expect(error).toBeInstanceOf(MotionError);
      expect((error as MotionError).tag).toBe("InvalidSolution");
    }
  });
});
