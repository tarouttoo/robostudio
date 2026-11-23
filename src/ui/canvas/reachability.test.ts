import { describe, expect, it } from "vitest";

import { DEFAULT_MIKO_MINI_CONFIG } from "../../kinematics/miko-mini";
import { createRobotRegistry } from "../../kinematics/registry";
import type { RobotModel } from "../../kinematics/robot-model";
import { REACHABILITY_CELL_MM, createReachabilitySampler } from "./reachability";

function defaultModel(): RobotModel {
  const result = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG]);
  if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);
  const model = result.registry.resolve("miko-mini");
  if (!model) throw new Error("model miko-mini was not resolved");
  return model;
}

describe("createReachabilitySampler", () => {
  const model = defaultModel();

  it("classifies cells of the XY plane at the fixed coordinate: allowed near the workspace, blocked far out", () => {
    // XY at fixed z = 0: (102.5, 2.5) is reachable, (202.5, 2.5) is not.
    const sampler = createReachabilitySampler(model, "XY", 0);
    expect(sampler.cellMm).toBe(REACHABILITY_CELL_MM);
    expect(sampler.statusAt(102.5, 2.5)).toBe("ok");
    expect(sampler.statusAt(202.5, 2.5)).toBe("unreachable");
  });

  it("marks limit-violating cells distinctly from unreachable ones", () => {
    // The z = 0 region near the origin needs q2 below its minimum.
    const sampler = createReachabilitySampler(model, "XY", 0);
    expect(sampler.statusAt(2.5, 2.5)).toBe("angle-limit");
  });

  it("classifies by the cell containing the queried point, so any point of a cell answers alike", () => {
    const sampler = createReachabilitySampler(model, "XY", 0);
    // Both points fall into the lattice cell spanning u ∈ [100, 105), v ∈ [0, 5).
    expect(sampler.statusAt(100.1, 0.2)).toBe(sampler.statusAt(103.9, 3.9));
    // Negative coordinates floor into their own cells symmetrically.
    expect(sampler.statusAt(-2.5, 2.5)).toBe("angle-limit");
  });

  it("answers from the fixed coordinate: a plane beyond the workspace is blocked everywhere", () => {
    const reachable = createReachabilitySampler(model, "XY", 0);
    const lifted = createReachabilitySampler(model, "XY", 500);
    expect(reachable.statusAt(102.5, 2.5)).toBe("ok");
    expect(lifted.statusAt(102.5, 2.5)).toBe("unreachable");
  });

  it("answers from the plane: the XZ cross-section through y = 0 is reachable at shoulder height", () => {
    // planePoint("XZ", u=100, v=60, w=0) is the world point (100, 0, 60).
    const sampler = createReachabilitySampler(model, "XZ", 0);
    expect(sampler.statusAt(100, 60)).toBe("ok");
    expect(sampler.statusAt(100, 500)).toBe("unreachable");
  });
});
