import { describe, expect, it } from "vitest";

import { arcFromCenter } from "../core/arc";
import { line, trajectory } from "../core/trajectory";
import { vec3 } from "../core/vec";
import { DEFAULT_MIKO_MINI_CONFIG } from "../kinematics/miko-mini";
import { createRobotRegistry } from "../kinematics/registry";
import type { JointAngles, RobotModel } from "../kinematics/robot-model";
import {
  createPchipPlanner,
  type MotionRow,
  type Planner,
} from "../motion/planner";
import { MotionError } from "../motion/errors";
import { PipelineError } from "./errors";
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
const LINE_AND_ARC = trajectory(vec3(80, 0, 60), [
  line({ start: vec3(80, 0, 60), end: vec3(100, 20, 60), feed: 20 }),
  arcFromCenter({
    plane: "XY",
    start: vec3(100, 20, 60),
    end: vec3(80, 40, 60),
    center: vec3(80, 20, 60),
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
    forwardKinematics: (angles) => [angles[0] as number, angles[1] as number, angles[2] as number],
    inverseKinematics: (target) => ({ status: "ok", joints: [...target] as JointAngles }),
  };
}

describe("pipeline: stage chain", () => {
  const model = defaultModel();

  it("runs every named stage in order and reports its outcome", () => {
    const result = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createPchipPlanner(model) });

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
    const result = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createPchipPlanner(model) });

    const collision = result.stages[3];
    expect(collision?.stage).toBe("collision");
    expect(collision?.detail).toMatch(/reserved/i);
    // The no-op never stops the pipeline: export still ran.
    expect(result.robotCsv.length).toBeGreaterThan(0);
  });
});

describe("pipeline: named stage failures stop the chain", () => {
  const model = defaultModel();

  it("fails the discretization stage on an empty Trajectory", () => {
    try {
      runPipeline({ trajectory: trajectory(vec3(80, 0, 60), []), model, planner: createPchipPlanner(model) });
      throw new Error("expected the pipeline to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      const pipelineError = error as PipelineError;
      expect(pipelineError.stage).toBe("discretization");
      expect(pipelineError.message).toMatch(/no drawable geometry/i);
    }
  });

  it("fails the discretization stage on a Trajectory that draws nothing", () => {
    const degenerate = trajectory(vec3(80, 0, 60), [
      line({ start: vec3(80, 0, 60), end: vec3(80, 0, 60), feed: 20 }),
    ]);
    expect(() =>
      runPipeline({ trajectory: degenerate, model, planner: createPchipPlanner(model) }),
    ).toThrow(PipelineError);
    try {
      runPipeline({ trajectory: degenerate, model, planner: createPchipPlanner(model) });
    } catch (error) {
      expect((error as PipelineError).stage).toBe("discretization");
      expect((error as PipelineError).message).toMatch(/draws nothing/i);
    }
  });

  it("fails the ik stage naming the point outside the workspace", () => {
    const far = trajectory(vec3(80, 0, 60), [
      line({ start: vec3(80, 0, 60), end: vec3(400, 0, 60), feed: 20 }),
    ]);
    try {
      runPipeline({ trajectory: far, model, planner: createPchipPlanner(model) });
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
      runPipeline({ trajectory: folded, model, planner: createPchipPlanner(model) });
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
        planner: createPchipPlanner(stiffModel),
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
