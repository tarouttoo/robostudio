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

/** A model whose workspace is exactly the disc of `radiusMm` around the origin. */
function discModel(radiusMm: number): RobotModel {
  return {
    id: "disc-test",
    name: "Disc test model",
    joints: DEFAULT_MIKO_MINI_CONFIG.joints,
    workspaceRadiusMm: radiusMm,
    forwardKinematics: () => [0, 0, 0],
    chainPoints: () => [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    inverseKinematics: (target) => {
      const r = Math.hypot(target[0] ?? 0, target[1] ?? 0, target[2] ?? 0);
      return r <= radiusMm ? { status: "ok", joints: [0, 0, 0] } : { status: "unreachable" };
    },
  };
}

describe("createReachabilitySampler", () => {
  const model = defaultModel();

  it("classifies cells of the XY plane at the fixed coordinate: allowed near the workspace, blocked far out", () => {
    // XY at fixed z = 160 (shoulder height): (202.5, 2.5) is reachable,
    // (452.5, 2.5) is past the geometric reach and is not.
    const sampler = createReachabilitySampler(model, "XY", 160);
    expect(sampler.cellMm).toBe(REACHABILITY_CELL_MM);
    expect(sampler.statusAt(202.5, 2.5)).toBe("ok");
    expect(sampler.statusAt(452.5, 2.5)).toBe("unreachable");
  });

  it("marks limit-violating cells distinctly from unreachable ones", () => {
    // At fixed z = 210 the cells at the base axis fold the shoulder-up
    // pose far past the measured q2 maximum.
    const sampler = createReachabilitySampler(model, "XY", 210);
    expect(sampler.statusAt(2.5, 2.5)).toBe("angle-limit");
  });

  it("classifies by the cell containing the queried point, so any point of a cell answers alike", () => {
    const sampler = createReachabilitySampler(model, "XY", 0);
    // Both points fall into the lattice cell spanning u ∈ [100, 105), v ∈ [0, 5).
    expect(sampler.statusAt(100.1, 0.2)).toBe(sampler.statusAt(103.9, 3.9));
    // Negative coordinates floor into their own cells symmetrically.
    expect(sampler.statusAt(-2.5, 2.5)).toBe(sampler.statusAt(-3.9, 3.9));
  });

  it("answers from the fixed coordinate: a plane beyond the workspace is blocked everywhere", () => {
    const reachable = createReachabilitySampler(model, "XY", 160);
    const lifted = createReachabilitySampler(model, "XY", 500);
    expect(reachable.statusAt(202.5, 2.5)).toBe("ok");
    expect(lifted.statusAt(202.5, 2.5)).toBe("unreachable");
  });

  it("answers from the plane: the XZ cross-section through y = 0 is reachable at the Home Point's height", () => {
    // planePoint("XZ", u=240, v=260, w=0) is the world point (240, 0, 260).
    const sampler = createReachabilitySampler(model, "XZ", 0);
    expect(sampler.statusAt(240, 260)).toBe("ok");
    expect(sampler.statusAt(240, 500)).toBe("unreachable");
  });

  it("reports the zone bounds: the cell rectangle covering every non-unreachable cell", () => {
    // Disc workspace of 100 mm on a 5 mm lattice: the classified cells
    // span lattice indices -20…19 on both axes (centre distance ≤ 100),
    // so the zone rectangle is exactly [-100, 100] mm on both axes.
    const sampler = createReachabilitySampler(discModel(100), "XY", 0);
    expect(sampler.zoneBounds()).toEqual({ minU: -100, maxU: 100, minV: -100, maxV: 100 });
  });

  it("bounds the real MiKo-mini zone within its workspace radius, covering the reachable cells", () => {
    const sampler = createReachabilitySampler(model, "XY", 0);
    const bounds = sampler.zoneBounds();
    expect(bounds).not.toBeNull();
    const r = model.workspaceRadiusMm;
    expect(bounds!.minU).toBeGreaterThanOrEqual(-r);
    expect(bounds!.maxU).toBeLessThanOrEqual(r);
    expect(bounds!.minV).toBeGreaterThanOrEqual(-r);
    expect(bounds!.maxV).toBeLessThanOrEqual(r);
    // The known reachable point's cell lies inside the reported zone.
    expect(bounds!.minU).toBeLessThanOrEqual(100);
    expect(bounds!.maxU).toBeGreaterThanOrEqual(105);
    // The known unreachable far cell stays outside it.
    expect(bounds!.maxU).toBeLessThanOrEqual(355);
  });

  it("reports null for a plane where no cell is reachable", () => {
    const lifted = createReachabilitySampler(model, "XY", 500);
    expect(lifted.zoneBounds()).toBeNull();
  });
});
