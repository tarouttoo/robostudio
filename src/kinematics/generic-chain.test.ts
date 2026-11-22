import { describe, expect, it } from "vitest";

import {
  type ChainJointConfig,
  type GenericChainRobotConfig,
} from "./generic-chain";
import { DEFAULT_MIKO_MINI_CONFIG } from "./miko-mini";
import { createRobotRegistry, type RobotModelConfig } from "./registry";
import {
  vec3Distance,
  type IKResult,
  type JointConfig,
  type RobotModel,
  type Vec3,
} from "./robot-model";

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

function expectOk(model: RobotModel, result: IKResult): readonly number[] {
  if (result.status !== "ok") throw new Error(`expected ok from ${model.id}, got status ${result.status}`);
  return result.joints;
}

function expectWithinLimits(model: RobotModel, joints: readonly number[]): void {
  joints.forEach((value, i) => {
    const limit = model.joints[i] as JointConfig;
    expect(value).toBeGreaterThanOrEqual(limit.minRad - 1e-9);
    expect(value).toBeLessThanOrEqual(limit.maxRad + 1e-9);
  });
}

function expectConverges(model: RobotModel, target: Vec3): readonly number[] {
  const solved = expectOk(model, model.inverseKinematics(target));
  expectWithinLimits(model, solved);
  const achieved = model.forwardKinematics(solved);
  const distance = vec3Distance(achieved, target);
  expect(distance).toBeLessThanOrEqual(1e-6);
  return solved;
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

  it("rejects joint arrays of the wrong length instead of returning NaN", () => {
    const model = resolveModel(ONE_JOINT_CHAIN);
    expect(() => model.forwardKinematics([])).toThrow(/expects 1 joint angles/);
    expect(() => model.forwardKinematics([0, 0])).toThrow(/expects 1 joint angles/);
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

/** A 4-DOF redundant chain: two base rotations and a two-link planar pair. */
const FOUR_DOF_CHAIN: GenericChainRobotConfig = {
  kind: "generic-chain",
  solver: "numeric-dls",
  id: "quad-arm",
  name: "Quad arm",
  joints: [
    {
      name: "q1", minRad: -Math.PI, maxRad: Math.PI,
      maxVelocityRadS: 1, maxAccelerationRadS2: 5, maxJerkRadS3: 25,
      origin: [0, 0, 40], axis: [0, 0, 1], offset: [30, 0, 0],
    },
    {
      name: "q2", minRad: -Math.PI, maxRad: Math.PI,
      maxVelocityRadS: 1, maxAccelerationRadS2: 5, maxJerkRadS3: 25,
      origin: [0, 0, 0], axis: [0, -1, 0], offset: [50, 0, 0],
    },
    {
      name: "q3", minRad: -Math.PI, maxRad: Math.PI,
      maxVelocityRadS: 1, maxAccelerationRadS2: 5, maxJerkRadS3: 25,
      origin: [0, 0, 0], axis: [0, -1, 0], offset: [40, 0, 0],
    },
    {
      name: "q4", minRad: -Math.PI, maxRad: Math.PI,
      maxVelocityRadS: 1, maxAccelerationRadS2: 5, maxJerkRadS3: 25,
      origin: [0, 0, 0], axis: [1, 0, 0], offset: [20, 0, 30],
    },
  ],
  ik: TEST_IK,
};

describe("generic-chain numeric inverse kinematics", () => {
  it("solves a hand-computed target on a single-joint chain", () => {
    const model = resolveModel(ONE_JOINT_CHAIN);
    // 100 mm link at 120°: (−50, 50·√3, 0).
    const solved = expectConverges(model, [-50, 50 * Math.sqrt(3), 0]);
    expect(solved[0]).toBeCloseTo((2 * Math.PI) / 3, 6);
  });

  it("holds the IK∘FK round trip across the MiKo-shaped chain's workspace", () => {
    const model = resolveModel(mikoShapedChainConfig());
    const q1s = [-2.0, -0.9, 0, 1.1, 2.3];
    const q2s = [-0.2, 0.35, 0.9, 1.4, 1.8];
    const q3s = [-2.5, -1.9, -1.2, -0.6, -0.1];
    for (const q1 of q1s) {
      for (const q2 of q2s) {
        for (const q3 of q3s) {
          const target = model.forwardKinematics([q1, q2, q3]);
          expectConverges(model, target);
        }
      }
    }
  });

  it("converges on a 4-DOF redundant chain", () => {
    const model = resolveModel(FOUR_DOF_CHAIN);
    const poses: readonly (readonly number[])[] = [
      [0.4, 0.5, -0.3, 0.2],
      [-1.2, 0.9, 0.4, -0.8],
      [2.1, -0.4, -0.7, 1.1],
    ];
    for (const q of poses) {
      expectConverges(model, model.forwardKinematics(q));
    }
  });
});

describe("generic-chain IK named failure statuses", () => {
  const model = resolveModel(mikoShapedChainConfig());

  it("reports unreachable for a point beyond the outer reach", () => {
    expect(model.inverseKinematics([500, 0, 60])).toEqual({ status: "unreachable" });
  });

  it("reports unreachable for a point below the folded reach", () => {
    expect(model.inverseKinematics([0, 0, -200])).toEqual({ status: "unreachable" });
  });

  it("reports angle-limit naming a genuinely violated joint for a target needing q2 past its max", () => {
    // Straight above the base: several out-of-limits solutions exist
    // (e.g. the analytic shoulder-up q2 ≈ 129° > +105°, or a mirrored
    // pose violating q3); which branch the numeric descent finds depends
    // on its deterministic seeds, so assert status plus a genuine named
    // violation rather than a specific joint.
    const result = model.inverseKinematics([0, 0, 200]);
    if (result.status !== "angle-limit") throw new Error(`expected angle-limit, got ${result.status}`);
    const limit = model.joints.find((joint) => joint.name === result.joint);
    if (!limit) throw new Error(`angle-limit names unknown joint ${result.joint}`);
    expect(result.bound === "max" ? result.valueRad > limit.maxRad : result.valueRad < limit.minRad).toBe(true);
  });

  it("reports angle-limit naming the joint for a target needing q2 below its min", () => {
    // The shoulder-up pose needs q2 ≈ −21.6° < −15°.
    const result = model.inverseKinematics([60, 0, -60]);
    if (result.status !== "angle-limit") throw new Error(`expected angle-limit, got ${result.status}`);
    expect(result.joint).toBe("q2");
    expect(result.bound).toBe("min");
    expect(result.valueRad).toBeLessThan(model.joints[1]?.minRad ?? Number.NaN);
  });

  it("never throws and never returns ok for garbage coordinates", () => {
    expect(model.inverseKinematics([Number.NaN, 0, 60]).status).toBe("unreachable");
    const probes: readonly (readonly number[])[] = [
      [0, 0, 0],
      [-500, -500, -500],
      [60, 0, -60],
      [Number.POSITIVE_INFINITY, 0, 60],
    ];
    for (const target of probes) {
      const status = model.inverseKinematics(target as [number, number, number]).status;
      expect(["ok", "unreachable", "angle-limit"]).toContain(status);
    }
  });
});

describe("generic-chain convergence configuration", () => {
  it("reports invalid convergence parameters with named problems", () => {
    const result = createRobotRegistry([
      {
        ...ONE_JOINT_CHAIN,
        ik: { toleranceMm: 0, maxIterations: 0, damping: -1 },
      },
    ]);
    if (result.status !== "invalid-config") throw new Error("expected invalid-config");
    expect(result.problems.some((p) => p.includes("toleranceMm"))).toBe(true);
    expect(result.problems.some((p) => p.includes("maxIterations"))).toBe(true);
    expect(result.problems.some((p) => p.includes("damping"))).toBe(true);
  });

  it("rejects a chain without joints with a named problem", () => {
    const result = createRobotRegistry([{ ...ONE_JOINT_CHAIN, joints: [] }]);
    if (result.status !== "invalid-config") throw new Error("expected invalid-config");
    expect(result.problems.some((p) => p.includes("requires at least one joint"))).toBe(true);
  });

  it("rejects non-finite convergence parameters", () => {
    const result = createRobotRegistry([
      {
        ...ONE_JOINT_CHAIN,
        ik: { toleranceMm: Number.NaN, maxIterations: 2.5, damping: Number.POSITIVE_INFINITY },
      },
    ]);
    if (result.status !== "invalid-config") throw new Error("expected invalid-config");
    expect(result.problems.some((p) => p.includes("toleranceMm"))).toBe(true);
    expect(result.problems.some((p) => p.includes("maxIterations"))).toBe(true);
    expect(result.problems.some((p) => p.includes("damping"))).toBe(true);
  });

  it("enforces the iteration cap: a reachable target fails when the cap is spent", () => {
    const model = resolveModel({
      ...mikoShapedChainConfig("tight-cap"),
      ik: { toleranceMm: 1e-6, maxIterations: 1, damping: 0.05 },
    });
    // Reachable with the default 200-iteration budget; one iteration is not enough.
    expect(model.inverseKinematics(model.forwardKinematics([0.3, 0.5, -0.9]))).toEqual({
      status: "unreachable",
    });
  });

  it("honors a looser tolerance as the acceptance bar", () => {
    const model = resolveModel({
      ...mikoShapedChainConfig("loose-tol"),
      ik: { toleranceMm: 0.5, maxIterations: 200, damping: 0.05 },
    });
    const target = model.forwardKinematics([0.3, 0.5, -0.9]);
    const result = model.inverseKinematics(target);
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(vec3Distance(model.forwardKinematics(result.joints), target)).toBeLessThanOrEqual(0.5);
  });
});

describe("generic-chain cross-check against the analytic MiKo-mini solver", () => {
  function resolved(id: string): RobotModel {
    const registryResult = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG, mikoShapedChainConfig()]);
    if (registryResult.status !== "ok") throw new Error(`registry failed: ${registryResult.problems.join("; ")}`);
    const model = registryResult.registry.resolve(id);
    if (!model) throw new Error(`model ${id} was not resolved`);
    return model;
  }

  const analytic = resolved("miko-mini");
  const generic = resolved("miko-generic");

  /** Numeric convergence slack: solver guarantees distance ≤ tolerance. */
  const TOLERANCE_MM = 1e-6;

  function expectAgreement(target: Vec3): void {
    const expectedStatus = analytic.inverseKinematics(target).status;
    const numeric = generic.inverseKinematics(target);
    if (expectedStatus === "ok") {
      if (numeric.status !== "ok") throw new Error(`expected ok, got ${numeric.status}`);
      const distance = vec3Distance(generic.forwardKinematics(numeric.joints), target);
      expect(distance).toBeLessThanOrEqual(TOLERANCE_MM);
    } else {
      expect(numeric.status).toBe(expectedStatus);
    }
  }

  it("agrees with the analytic solver across the shoulder-up workspace grid", () => {
    const q1s = [-2.0, -0.9, 0, 1.1, 2.3];
    const q2s = [-0.2, 0.35, 0.9, 1.4, 1.8];
    const q3s = [-2.5, -1.9, -1.2, -0.6, -0.1];
    for (const q1 of q1s) {
      for (const q2 of q2s) {
        for (const q3 of q3s) {
          expectAgreement(analytic.forwardKinematics([q1, q2, q3]));
        }
      }
    }
  });

  it("agrees with the analytic solver at its FK reference poses", () => {
    const poses: readonly (readonly number[])[] = [
      [0, 0, 0],
      [Math.PI / 2, 0, 0],
      [0, Math.PI / 2, -Math.PI / 2],
      [0, Math.PI / 4, -Math.PI / 2],
      [Math.PI, -Math.PI / 6, -((5 * Math.PI) / 6)],
    ];
    for (const q of poses) {
      expectAgreement(analytic.forwardKinematics(q));
    }
  });

  it("agrees with the analytic solver on failure statuses off the workspace", () => {
    expectAgreement([500, 0, 60]); // beyond the outer reach
    expectAgreement([0, 0, -200]); // below the folded reach
    expectAgreement([60, 0, -60]); // reachable, but the pose violates q2 min
    expectAgreement([0, 0, 200]); // reachable, but the pose violates q2 max
  });
});

describe("generic-chain solver selection", () => {
  it("rejects a solver the registry does not implement, naming it", () => {
    const result = createRobotRegistry([
      { ...ONE_JOINT_CHAIN, solver: "psychic-guess" as unknown as "numeric-dls" },
    ]);
    if (result.status !== "invalid-config") throw new Error("expected invalid-config");
    expect(result.problems.some((p) => p.includes('unsupported solver "psychic-guess"'))).toBe(true);
  });

  it("builds two independent models from the same chain under different ids", () => {
    const registryResult = createRobotRegistry([
      mikoShapedChainConfig("left-arm"),
      mikoShapedChainConfig("right-arm"),
    ]);
    if (registryResult.status !== "ok") throw new Error(`registry failed: ${registryResult.problems.join("; ")}`);
    const target: Vec3 = [90, 0, 150];
    for (const id of ["left-arm", "right-arm"]) {
      const model = registryResult.registry.resolve(id);
      if (!model) throw new Error(`model ${id} was not resolved`);
      const result = model.inverseKinematics(target);
      if (result.status !== "ok") throw new Error(`expected ok from ${id}, got ${result.status}`);
      expect(vec3Distance(model.forwardKinematics(result.joints), target)).toBeLessThanOrEqual(1e-6);
    }
  });
});
