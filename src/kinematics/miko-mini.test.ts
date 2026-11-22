import { describe, expect, it } from "vitest";

import { DEFAULT_MIKO_MINI_CONFIG } from "./miko-mini";
import { createRobotRegistry } from "./registry";
import type { IKResult, JointConfig, RobotModel } from "./robot-model";

function defaultModel(): RobotModel {
  const result = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG]);
  if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);
  const model = result.registry.resolve("miko-mini");
  if (!model) throw new Error("model miko-mini was not resolved");
  return model;
}

function expectOk(result: IKResult): readonly number[] {
  if (result.status !== "ok") throw new Error(`expected ok, got status ${result.status}`);
  return result.joints;
}

function expectWithinLimits(model: RobotModel, joints: readonly number[]): void {
  joints.forEach((value, i) => {
    const limit = model.joints[i] as JointConfig;
    expect(value).toBeGreaterThanOrEqual(limit.minRad - 1e-9);
    expect(value).toBeLessThanOrEqual(limit.maxRad + 1e-9);
  });
}

function expectRoundTrip(model: RobotModel, q: readonly number[]): void {
  const target = model.forwardKinematics(q);
  const solved = expectOk(model.inverseKinematics(target));
  expectWithinLimits(model, solved);
  const achieved = model.forwardKinematics(solved);
  expect(achieved[0]).toBeCloseTo(target[0], 8);
  expect(achieved[1]).toBeCloseTo(target[1], 8);
  expect(achieved[2]).toBeCloseTo(target[2], 8);
}

describe("MiKo-mini forward kinematics", () => {
  const model = defaultModel();

  // Reference points computed by hand from the documented chain formulas:
  //   r = L1·cos(q2) + L2·cos(q2+q3), z = h + L1·sin(q2) + L2·sin(q2+q3)
  // with h = 60, L1 = L2 = 90.
  const references: readonly { readonly q: readonly number[]; readonly expected: readonly [number, number, number] }[] = [
    { q: [0, 0, 0], expected: [180, 0, 60] },
    { q: [Math.PI / 2, 0, 0], expected: [0, 180, 60] },
    { q: [0, Math.PI / 2, -Math.PI / 2], expected: [90, 0, 150] },
    { q: [0, Math.PI / 4, -Math.PI / 2], expected: [90 * Math.SQRT2, 0, 60] },
    {
      q: [Math.PI, -Math.PI / 6, -((5 * Math.PI) / 6)],
      expected: [90 - 90 * (Math.sqrt(3) / 2), 0, 15], // cos(π)·r folds the negative reach to +x
    },
  ];

  for (const { q, expected } of references) {
    it(`matches the prototype formula at q = (${q.map((a) => a.toFixed(2)).join(", ")})`, () => {
      const p = model.forwardKinematics(q);
      expect(p[0]).toBeCloseTo(expected[0], 9);
      expect(p[1]).toBeCloseTo(expected[1], 9);
      expect(p[2]).toBeCloseTo(expected[2], 9);
    });
  }
});

describe("MiKo-mini inverse kinematics", () => {
  const model = defaultModel();

  it("recovers the exact shoulder-up solution", () => {
    const q = [0.3, 0.5, -0.9];
    const solved = expectOk(model.inverseKinematics(model.forwardKinematics(q)));
    expect(solved[0]).toBeCloseTo(0.3, 9);
    expect(solved[1]).toBeCloseTo(0.5, 9);
    expect(solved[2]).toBeCloseTo(-0.9, 9);
  });

  it("holds the IK∘FK round trip across the shoulder-up workspace", () => {
    const q1s = [-2.0, -0.9, 0, 1.1, 2.3];
    const q2s = [-0.2, 0.35, 0.9, 1.4, 1.8];
    const q3s = [-2.5, -1.9, -1.2, -0.6, -0.1];
    for (const q1 of q1s) {
      for (const q2 of q2s) {
        for (const q3 of q3s) {
          expectRoundTrip(model, [q1, q2, q3]);
        }
      }
    }
  });

  it("holds the round trip for elbow-down targets via the mirror solution", () => {
    const q1s = [0, 1.1];
    const q2s = [0.3, 0.9];
    const q3s = [0.4, 0.9];
    for (const q1 of q1s) {
      for (const q2 of q2s) {
        for (const q3 of q3s) {
          expectRoundTrip(model, [q1, q2, q3]);
        }
      }
    }
  });
});

describe("MiKo-mini IK named failure statuses", () => {
  const model = defaultModel();

  it("reports unreachable for points beyond the outer reach", () => {
    expect(model.inverseKinematics([500, 0, 60])).toEqual({ status: "unreachable" });
  });

  it("reports unreachable for points below the folded reach", () => {
    expect(model.inverseKinematics([0, 0, -200])).toEqual({ status: "unreachable" });
  });

  it("accepts a point exactly on the workspace boundary", () => {
    // 180 mm straight ahead: the fully-extended arm, cos(q3) = 1 exactly.
    const solved = expectOk(model.inverseKinematics([180, 0, 60]));
    expect(solved[2]).toBeCloseTo(0, 9);
  });

  it("reports angle-limit naming the joint for a limit-violating solution", () => {
    // Shoulder-up solution needs q2 ≈ −0.377 rad, below the q2 min of −15°.
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

describe("MiKo-mini carried constants", () => {
  it("pins the prototype geometry and joint/dynamic limits as configuration", () => {
    expect(DEFAULT_MIKO_MINI_CONFIG.kind).toBe("miko-mini");
    expect(DEFAULT_MIKO_MINI_CONFIG.id).toBe("miko-mini");
    expect(DEFAULT_MIKO_MINI_CONFIG.name).toBe("MiKo-mini");
    expect(DEFAULT_MIKO_MINI_CONFIG.geometry).toEqual({
      baseHeightMm: 60,
      upperArmMm: 90,
      forearmMm: 90,
    });
    expect(DEFAULT_MIKO_MINI_CONFIG.joints).toEqual([
      {
        name: "q1",
        minRad: -Math.PI,
        maxRad: Math.PI,
        maxVelocityRadS: 1.0,
        maxAccelerationRadS2: 5.0,
        maxJerkRadS3: 25.0,
      },
      {
        name: "q2",
        minRad: -0.2617993877991494, // −15°
        maxRad: 1.832595714594046, // +105°
        maxVelocityRadS: 1.0,
        maxAccelerationRadS2: 5.0,
        maxJerkRadS3: 25.0,
      },
      {
        name: "q3",
        minRad: -2.6179938779914944, // −150°
        maxRad: 0,
        maxVelocityRadS: 1.0,
        maxAccelerationRadS2: 5.0,
        maxJerkRadS3: 25.0,
      },
    ]);
  });
});

describe("MiKo-mini interface contract", () => {
  const model = defaultModel();

  it("reports angle-limit with the max bound for targets above the shoulder range", () => {
    // Straight above the base: shoulder-up solution needs q2 ≈ 2.25 rad > +105°.
    const result = model.inverseKinematics([0, 0, 200]);
    if (result.status !== "angle-limit") throw new Error(`expected angle-limit, got ${result.status}`);
    expect(result.joint).toBe("q2");
    expect(result.bound).toBe("max");
    expect(result.valueRad).toBeGreaterThan(model.joints[1]?.maxRad ?? Number.NaN);
  });

  it("rejects joint arrays of the wrong length instead of returning NaN", () => {
    expect(() => model.forwardKinematics([0, 0])).toThrow(/3 joint angles/);
    expect(() =>
      model.forwardKinematics([0, 0, 0, 0] as unknown as [number, number, number]),
    ).toThrow(/3 joint angles/);
  });
});
