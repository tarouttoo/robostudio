import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { arcFromCenter } from "../core/arc";
import { line, point, trajectory } from "../core/trajectory";
import { vec3 } from "../core/vec";
import { DEFAULT_MIKO_MINI_CONFIG } from "../kinematics/miko-mini";
import { createRobotRegistry } from "../kinematics/registry";
import { parseProject } from "../project/file";
import type { JointAngles, RobotModel } from "../kinematics/robot-model";
import {
  createSplinePlanner,
  type MotionRow,
  type Planner,
} from "../motion/planner";
import { MotionError } from "../motion/errors";
import { PipelineError } from "./errors";
import { MOTION_PREVIEW_MAX_FRAMES } from "./motion-preview";
import { decodeGifFrames } from "./gif-test-support";
import { PIPELINE_STAGES, runPipeline } from "./pipeline";

/** The default MiKo-mini model from validated configuration. */
function defaultModel(): RobotModel {
  const result = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG]);
  if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);
  const model = result.registry.resolve("miko-mini");
  if (!model) throw new Error("model miko-mini was not resolved");
  return model;
}

/** A line into the workspace followed by a quarter arc, both reachable. */
const LINE_AND_ARC = trajectory(vec3(240, 0, 260), [
  line({ start: vec3(240, 0, 260), end: vec3(260, 20, 260), feed: 20 }),
  arcFromCenter({
    plane: "XY",
    start: vec3(260, 20, 260),
    end: vec3(240, 40, 260),
    center: vec3(240, 20, 260),
    direction: "CCW",
    feed: 10,
  }),
]);

/** Builds one MotionRow sitting on the control grid. */
function planRow(tMs: number, q: readonly number[]): MotionRow {
  return { tMs, segmentIndex: 0, q, qd: [0, 0, 0], qdd: [0, 0, 0], qddd: [0, 0, 0] };
}

/** A Robot Model with trivial identity kinematics and chosen dynamic limits. */
function identityModel(dynamicLimits?: {
  readonly maxVelocityRadS: number;
}): RobotModel {
  const base = DEFAULT_MIKO_MINI_CONFIG.joints;
  const joints = base.map((joint) => ({
    ...joint,
    minRad: -1e6,
    maxRad: 1e6,
    maxVelocityRadS: dynamicLimits?.maxVelocityRadS ?? joint.maxVelocityRadS,
  }));
  return {
    id: "identity-test",
    name: "Identity test model",
    joints,
    // Unused by these tests; the interface requires a finite bound.
    workspaceRadiusMm: 1000,
    forwardKinematics: (angles) => [angles[0] as number, angles[1] as number, angles[2] as number],
    chainPoints: (angles) => [
      [0, 0, 0],
      [0, 0, 0],
      [angles[0] as number, 0, 0],
      [angles[1] as number, 0, 0],
      [angles[2] as number, 0, 0],
    ],
    inverseKinematics: (target) => ({ status: "ok", joints: [...target] as JointAngles }),
  };
}

describe("pipeline: stage chain", () => {
  const model = defaultModel();

  it("runs every named stage in order and reports its outcome", () => {
    const result = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createSplinePlanner(model) });

    expect(result.stages.map((s) => s.stage)).toEqual(PIPELINE_STAGES);
    expect(result.stages.map((s) => s.stage)).toEqual([
      "discretization",
      "ik",
      "motion-plan",
      "collision",
      "export",
    ]);
    for (const stage of result.stages) {
      expect(stage.detail.length).toBeGreaterThan(0);
    }
    expect(result.plan.rows.length).toBeGreaterThan(50);
    expect(result.robotCsv.startsWith("t,q1,q2,q3\n")).toBe(true);
    expect(result.rvizCsv.startsWith("t,q1,q2,q3\n")).toBe(true);
    // The export stage reports the exported bytes.
    const dataRows = result.robotCsv.split("\n").length - 2; // header + trailing newline
    expect(dataRows).toBe(result.plan.rows.length);
  });

  it("keeps collision checking as a reserved no-op stage between planning and export", () => {
    const result = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createSplinePlanner(model) });

    const collision = result.stages[3];
    expect(collision?.stage).toBe("collision");
    expect(collision?.detail).toMatch(/reserved/i);
    // The no-op never stops the pipeline: export still ran.
    expect(result.robotCsv.length).toBeGreaterThan(0);
  });

  it("carries the Motion Preview GIF bytes next to the CSVs", () => {
    const result = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createSplinePlanner(model) });

    const gif = result.motionGif;
    expect(gif).toBeInstanceOf(Uint8Array);
    expect(gif.length).toBeGreaterThan(0);
    expect(String.fromCharCode(gif[0] as number, gif[1] as number, gif[2] as number)).toBe("GIF");
    // The animation samples the plan's rows: exactly one frame per row
    // for a plan inside the ~300-frame budget, paced over the duration.
    const decoded = decodeGifFrames(gif);
    expect(decoded.frames.length).toBe(Math.min(result.plan.rows.length, MOTION_PREVIEW_MAX_FRAMES));
    expect(decoded.frames.length).toBeLessThanOrEqual(300);
    const totalDelayS = decoded.delays.reduce((sum, d) => sum + d, 0);
    expect(totalDelayS * 1000).toBeGreaterThanOrEqual(result.plan.durationMs - 350);
    expect(totalDelayS * 1000).toBeLessThanOrEqual(result.plan.durationMs + 350);
  });

  it("reports the GIF in the export stage's outcome detail", () => {
    const result = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createSplinePlanner(model) });
    const exportStage = result.stages[result.stages.length - 1];
    expect(exportStage?.stage).toBe("export");
    expect(exportStage?.detail).toMatch(/robot_motion\.gif/i);
  });

  it("renders the GIF deterministically for identical input", () => {
    const a = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createSplinePlanner(model) });
    const b = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createSplinePlanner(model) });
    expect(a.motionGif).toEqual(b.motionGif);
  });
});

describe("pipeline: chained Points", () => {
  const model = defaultModel();

  /** A drawing as the Point tool places it: a chain of reachable PTP Moves. */
  const POINT_CHAIN = trajectory(vec3(240, 0, 260), [
    point({ target: vec3(240, 113, 260), feed: 30, motionType: "PTP" }),
    point({ target: vec3(240, 40, 260), feed: 30, motionType: "PTP" }),
  ]);

  it("runs a chained-Points drawing through every stage and exports the contract CSV", () => {
    const result = runPipeline({ trajectory: POINT_CHAIN, model, planner: createSplinePlanner(model) });

    expect(result.stages.map((s) => s.stage)).toEqual(PIPELINE_STAGES);
    // The Robot CSV contract (ADR 0006) is untouched: header, one row
    // per plan row, radians at fixed precision.
    expect(result.robotCsv.startsWith("t,q1,q2,q3\n")).toBe(true);
    const dataRows = result.robotCsv.split("\n").length - 2; // header + trailing newline
    expect(dataRows).toBe(result.plan.rows.length);
    expect(result.plan.rows.length).toBeGreaterThan(1);
    // Arrival at the last Move's target in joint space.
    const [tx, ty] = model.forwardKinematics(result.plan.rows[result.plan.rows.length - 1]!.q);
    expect(tx).toBeCloseTo(240, 6);
    expect(ty).toBeCloseTo(40, 6);
  });

  it("checks Reachability at Move targets only: an unreachable target stops at the ik stage", () => {
    const outOfReach = trajectory(vec3(240, 0, 260), [
      point({ target: vec3(240, 113, 260), feed: 30, motionType: "PTP" }),
      point({ target: vec3(500, 0, 60), feed: 30, motionType: "PTP" }),
    ]);
    try {
      runPipeline({ trajectory: outOfReach, model, planner: createSplinePlanner(model) });
      throw new Error("expected the pipeline to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      const pipelineError = error as PipelineError;
      expect(pipelineError.stage).toBe("ik");
      expect(pipelineError.message).toContain("segment 1");
    }
  });

  it("plans and exports a mixed LIN/PTP chain end-to-end", () => {
    // A LIN Move along the drawn line, then a PTP jump to the next
    // target: one pipeline run, both Motion Types in one plan.
    const mixed = trajectory(vec3(240, 0, 260), [
      point({ target: vec3(240, 40, 260), feed: 30, motionType: "LIN" }),
      point({ target: vec3(240, 80, 260), feed: 30, motionType: "PTP" }),
    ]);
    const result = runPipeline({ trajectory: mixed, model, planner: createSplinePlanner(model) });

    expect(result.stages.map((s) => s.stage)).toEqual(PIPELINE_STAGES);
    expect(result.plan.ranges.map((r) => r.segmentIndex)).toEqual([0, 1]);
    // The LIN range keeps the TCP on the drawn chord.
    const linRows = result.plan.rows.filter((row) => row.segmentIndex === 0);
    const ax = 240;
    const ay = 0;
    const bx = 240;
    const by = 40;
    for (const row of linRows) {
      const [mx, my] = model.forwardKinematics(row.q);
      const t = ((mx - ax) * (bx - ax) + (my - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2);
      const cx = ax + t * (bx - ax);
      const cy = ay + t * (by - ay);
      expect(Math.hypot(mx - cx, my - cy)).toBeLessThan(1);
    }
    // Arrival at the last target; the CSV contract holds.
    const [tx, ty] = model.forwardKinematics(result.plan.rows[result.plan.rows.length - 1]!.q);
    expect(tx).toBeCloseTo(240, 6);
    expect(ty).toBeCloseTo(80, 6);
    expect(result.robotCsv.startsWith("t,q1,q2,q3\n")).toBe(true);
  });

  it("checks a LIN Move along its path: dead ground mid-line stops at the ik stage", () => {
    // Both ends of the drawn line are solvable, but the line dips near
    // the base axis, into the joint-limit-only zone — a LIN Move must
    // fail the pipeline where a PTP Move with the same ends passes.
    const ends = { home: vec3(200, 200, 260), target: vec3(200, -200, 260) };
    const lin = trajectory(ends.home, [
      point({ target: ends.target, feed: 30, motionType: "LIN" }),
    ]);
    try {
      runPipeline({ trajectory: lin, model, planner: createSplinePlanner(model) });
      throw new Error("expected the pipeline to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      const pipelineError = error as PipelineError;
      expect(pipelineError.stage).toBe("ik");
      expect(pipelineError.message).toContain("segment 0");
    }
    // The same drawing as PTP passes: only the endpoints are checked.
    const ptp = trajectory(ends.home, [
      point({ target: ends.target, feed: 30, motionType: "PTP" }),
    ]);
    const result = runPipeline({ trajectory: ptp, model, planner: createSplinePlanner(model) });
    expect(result.stages.map((s) => s.stage)).toEqual(PIPELINE_STAGES);
  });
});

describe("pipeline: named stage failures stop the chain", () => {
  const model = defaultModel();

  it("fails the discretization stage on an empty Trajectory", () => {
    try {
      runPipeline({ trajectory: trajectory(vec3(240, 0, 260), []), model, planner: createSplinePlanner(model) });
      throw new Error("expected the pipeline to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      const pipelineError = error as PipelineError;
      expect(pipelineError.stage).toBe("discretization");
      expect(pipelineError.message).toMatch(/no drawable geometry/i);
    }
  });

  it("fails the discretization stage on a Trajectory that draws nothing", () => {
    const degenerate = trajectory(vec3(240, 0, 260), [
      line({ start: vec3(240, 0, 260), end: vec3(240, 0, 260), feed: 20 }),
    ]);
    expect(() =>
      runPipeline({ trajectory: degenerate, model, planner: createSplinePlanner(model) }),
    ).toThrow(PipelineError);
    try {
      runPipeline({ trajectory: degenerate, model, planner: createSplinePlanner(model) });
    } catch (error) {
      expect((error as PipelineError).stage).toBe("discretization");
      expect((error as PipelineError).message).toMatch(/draws nothing/i);
    }
  });

  it("fails the ik stage naming the point outside the workspace", () => {
    // The whole drawing sits beyond the geometric reach, so the very
    // first ik sample — the Home Point — is named as unreachable. (A
    // line walking out of the workspace from inside would first hit the
    // measured q3 limit band and fail with the angle-limit message
    // instead — see the next test.)
    const far = trajectory(vec3(500, 0, 60), [
      line({ start: vec3(500, 0, 60), end: vec3(550, 0, 60), feed: 20 }),
    ]);
    try {
      runPipeline({ trajectory: far, model, planner: createSplinePlanner(model) });
      throw new Error("expected the pipeline to fail");
    } catch (error) {
      const pipelineError = error as PipelineError;
      expect(error).toBeInstanceOf(PipelineError);
      expect(pipelineError.stage).toBe("ik");
      expect(pipelineError.message).toMatch(/outside the robot's workspace/);
      expect(pipelineError.message).toMatch(/segment 0/);
    }
  });

  it("fails the ik stage naming the joint that would exceed its limits", () => {
    // Behind the base axis above the shoulder, the shoulder-up solution
    // folds q2 past +π.
    const folded = trajectory(vec3(40, 0, 170), [
      line({ start: vec3(40, 0, 170), end: vec3(40, 10, 170), feed: 20 }),
    ]);
    try {
      runPipeline({ trajectory: folded, model, planner: createSplinePlanner(model) });
      throw new Error("expected the pipeline to fail");
    } catch (error) {
      const pipelineError = error as PipelineError;
      expect(pipelineError.stage).toBe("ik");
      expect(pipelineError.message).toMatch(/joint q2/);
      expect(pipelineError.message).toMatch(/limit/);
    }
  });

  it("wraps a planner failure as a motion-plan stage failure", () => {
    // An identity model whose joints may barely move: planning the same
    // line needs more than a 10000× stretch of its nominal duration.
    const stiffModel = identityModel({ maxVelocityRadS: 1e-9 });
    try {
      runPipeline({
        trajectory: LINE_AND_ARC,
        model: stiffModel,
        planner: createSplinePlanner(stiffModel),
      });
      throw new Error("expected the pipeline to fail");
    } catch (error) {
      const pipelineError = error as PipelineError;
      expect(pipelineError.stage).toBe("motion-plan");
      expect(pipelineError.message).toMatch(/dynamic limits/);
    }
  });

  it("fails the motion-plan stage on a plan with no rows", () => {
    const emptyPlanner: Planner = {
      plan: () => ({ rows: [], ranges: [], durationMs: 0 }),
    };
    try {
      runPipeline({ trajectory: LINE_AND_ARC, model, planner: emptyPlanner });
      throw new Error("expected the pipeline to fail");
    } catch (error) {
      const pipelineError = error as PipelineError;
      expect(pipelineError.stage).toBe("motion-plan");
      expect(pipelineError.message).toMatch(/no rows/i);
    }
  });

  it("fails the motion-plan stage on rows off the 20 ms control grid", () => {
    const offGridPlanner: Planner = {
      plan: () => ({
        rows: [planRow(0, [0, 0, 0]), planRow(30, [0.1, 0, 0])],
        ranges: [{ segmentIndex: 0, feed: 20, startMs: 0, endMs: 30 }],
        durationMs: 30,
      }),
    };
    try {
      runPipeline({ trajectory: LINE_AND_ARC, model, planner: offGridPlanner });
      throw new Error("expected the pipeline to fail");
    } catch (error) {
      const pipelineError = error as PipelineError;
      expect(pipelineError.stage).toBe("motion-plan");
      expect(pipelineError.message).toMatch(/20 ms/);
    }
  });

  it("never masks non-pipeline errors as stage failures", () => {
    const throwingPlanner: Planner = {
      plan: () => {
        throw new RangeError("internal defect");
      },
    };
    expect(() => runPipeline({ trajectory: LINE_AND_ARC, model, planner: throwingPlanner })).toThrow(
      RangeError,
    );
  });
});

describe("pipeline: cyclic joint unwrap (ADR 0021)", () => {
  const model = defaultModel();
  const planner = createSplinePlanner(model);

  /** The operator's 4-corner square whose last Move crosses atan2's ±π branch cut. */
  function squareFourCorners() {
    const project = parseProject(
      readFileSync(join(import.meta.dirname, "../project/fixtures/square-4-corners.json"), "utf8"),
    );
    if (!project.home) throw new Error("fixture has no Home Point");
    return trajectory(project.home, project.segments);
  }

  it("plans the branch-cut crossing Segment in Feed-nominal time, not as a fake base revolution", () => {
    const result = runPipeline({ trajectory: squareFourCorners(), model, planner });

    // Without the unwrap this Segment stretched to ~12 774.6 s chasing a
    // fake 360° revolution across the ±π representation cut (641 628
    // rows); with it, the base keeps rotating through the "back" and the
    // Segment plans in Feed-nominal time (~21.7 s).
    const crossing = result.plan.ranges.find((range) => range.segmentIndex === 3);
    expect(crossing).toBeDefined();
    const durationS = ((crossing as (typeof result.plan.ranges)[number]).endMs -
      (crossing as (typeof result.plan.ranges)[number]).startMs) / 1000;
    expect(durationS).toBeGreaterThan(15);
    expect(durationS).toBeLessThan(30);
    expect(result.plan.durationMs).toBeLessThan(2 * 60 * 1000);
  });

  it("keeps q1 continuous across rows through the branch cut", () => {
    const result = runPipeline({ trajectory: squareFourCorners(), model, planner });
    for (let i = 1; i < result.plan.rows.length; i++) {
      const prev = result.plan.rows[i - 1] as (typeof result.plan.rows)[number];
      const row = result.plan.rows[i] as (typeof result.plan.rows)[number];
      if (prev.segmentIndex !== 3 || row.segmentIndex !== 3) continue;
      const delta = Math.abs((row.q[0] as number) - (prev.q[0] as number));
      // The fake revolution moved q1 by up to ~6.28 rad inside one 0.5 mm
      // knot; real base motion between 20 ms rows stays orders below.
      expect(delta).toBeLessThan(0.02);
    }
  });
});

describe("pipeline error identity", () => {
  it("carries the stage and a stable tag for narrow handling", () => {
    const error = new PipelineError("ik", "reason");
    expect(error).toBeInstanceOf(Error);
    expect(error.tag).toBe("PipelineStageFailed");
    expect(error.stage).toBe("ik");
    expect(error.message).toBe("reason");
    expect(error.name).toBe("PipelineStageFailed");
  });

  it("is distinguishable from the motion layer's own named errors", () => {
    const motionError = new MotionError("InvalidSolution", "reason");
    expect(motionError).not.toBeInstanceOf(PipelineError);
  });
});
