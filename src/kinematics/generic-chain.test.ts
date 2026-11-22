import { describe, expect, it } from "vitest";

import {
  type ChainJointConfig,
  type GenericChainRobotConfig,
} from "./generic-chain";
import { DEFAULT_MIKO_MINI_CONFIG } from "./miko-mini";
import { createRobotRegistry, type RobotModelConfig } from "./registry";
import type { RobotModel } from "./robot-model";

/** Numeric IK convergence parameters shared by the test chains. */
const TEST_IK = { toleranceMm: 1e-6, maxIterations: 200, damping: 0.05 };

/** A single-revolute-joint chain: q about +Z at the origin, 100 mm link. */
const ONE_JOINT_CHAIN: GenericChainRobotConfig = {
  kind: "generic-chain",
  solver: "numeric-dls",
  id: "turntable",
  name: "Turntable",
  joints: [
    {
      name: "q1",
      minRad: -Math.PI,
      maxRad: Math.PI,
      maxVelocityRadS: 1,
      maxAccelerationRadS2: 5,
      maxJerkRadS3: 25,
      origin: [0, 0, 0],
      axis: [0, 0, 1],
      offset: [100, 0, 0],
    },
  ],
  ik: TEST_IK,
};

/** Joint entries for the MiKo-mini chain, re-described generically. */
function mikoChainJoints(): ChainJointConfig[] {
  return DEFAULT_MIKO_MINI_CONFIG.joints.map((joint, i) => ({
    ...joint,
    origin: i === 0 ? [0, 0, 60] : [0, 0, 0],
    axis: i === 0 ? [0, 0, 1] : [0, -1, 0],
    offset: i === 0 ? [0, 0, 0] : [90, 0, 0],
  }));
}

/** A generic-chain config describing the exact MiKo-mini geometry. */
export function mikoShapedChainConfig(id = "miko-generic"): GenericChainRobotConfig {
  return {
    kind: "generic-chain",
    solver: "numeric-dls",
    id,
    name: "MiKo-mini (generic chain)",
    joints: mikoChainJoints(),
    ik: TEST_IK,
  };
}

function resolveModel(config: RobotModelConfig): RobotModel {
  const result = createRobotRegistry([config]);
  if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);
  const model = result.registry.resolve(config.id);
  if (!model) throw new Error(`model ${config.id} was not resolved`);
  return model;
}

describe("generic-chain forward kinematics", () => {
  it("builds a model from a single-joint chain and matches hand-computed points", () => {
    const model = resolveModel(ONE_JOINT_CHAIN);

    expect(model.id).toBe("turntable");
    expect(model.name).toBe("Turntable");
    expect(model.joints.map((joint) => joint.name)).toEqual(["q1"]);

    // Rotating a 100 mm link about +Z.
    const atZero = model.forwardKinematics([0]);
    expect(atZero[0]).toBeCloseTo(100, 9);
    expect(atZero[1]).toBeCloseTo(0, 9);
    expect(atZero[2]).toBeCloseTo(0, 9);

    const atQuarter = model.forwardKinematics([Math.PI / 2]);
    expect(atQuarter[0]).toBeCloseTo(0, 9);
    expect(atQuarter[1]).toBeCloseTo(100, 9);
    expect(atQuarter[2]).toBeCloseTo(0, 9);
  });

  it("matches the analytic MiKo-mini FK when the chain describes the same geometry", () => {
    const analytic = resolveModel(DEFAULT_MIKO_MINI_CONFIG);
    const generic = resolveModel(mikoShapedChainConfig());

    const poses: readonly (readonly number[])[] = [
      [0, 0, 0],
      [Math.PI / 2, 0, 0],
      [0, Math.PI / 2, -Math.PI / 2],
      [0.3, 0.5, -0.9],
      [-2.0, 0.35, -1.9],
      [Math.PI, -Math.PI / 6, -((5 * Math.PI) / 6)],
    ];
    for (const q of poses) {
      const expected = analytic.forwardKinematics(q);
      const actual = generic.forwardKinematics(q);
      expect(actual[0]).toBeCloseTo(expected[0], 9);
      expect(actual[1]).toBeCloseTo(expected[1], 9);
      expect(actual[2]).toBeCloseTo(expected[2], 9);
    }
  });
});
