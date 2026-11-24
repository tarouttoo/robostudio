import { describe, expect, it } from "vitest";

import { DEFAULT_MIKO_MINI_CONFIG, DEFAULT_MIKO_MINI_HOME_MM } from "./miko-mini";
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

  // Reference points computed by hand from the documented chain formulas
  // (ADR 0015):
  //   r = L1·cos(q2) + L2·cos(q2+q3) + tool,
  //   z = h + L1·sin(q2) + L2·sin(q2+q3)
  // with h = 160, L1 = L2 = 159.8045, tool = 53.
  const references: readonly { readonly q: readonly number[]; readonly expected: readonly [number, number, number] }[] = [
    // Fully extended forward: two links plus the 53 mm tool offset.
    { q: [0, 0, 0], expected: [2 * 159.8045 + 53, 0, 160] },
    { q: [Math.PI / 2, 0, 0], expected: [0, 2 * 159.8045 + 53, 160] },
    // Upper arm vertical, forearm horizontal: the tool extends the radial term.
    { q: [0, Math.PI / 2, -Math.PI / 2], expected: [159.8045 + 53, 0, 160 + 159.8045] },
    // The two horizontal contributions add up: 2·L·cos(45°) plus the tool.
    { q: [0, Math.PI / 4, -Math.PI / 2], expected: [2 * 159.8045 * (Math.sqrt(2) / 2) + 53, 0, 160] },
    // Folded back over the base at q1 = π: the radial term is the 53 mm
    // tool minus the folded link reach, and cos(q1) mirrors it to −x.
    {
      q: [Math.PI, -Math.PI / 6, -((5 * Math.PI) / 6)],
      expected: [-(53 - 159.8045 * (1 - Math.sqrt(3) / 2)), 0, 160 - 159.8045 / 2],
    },
  ];

  for (const { q, expected } of references) {
    it(`matches the prototype chain at q = (${q.map((a) => a.toFixed(2)).join(", ")})`, () => {
      const p = model.forwardKinematics(q);
      expect(p[0]).toBeCloseTo(expected[0], 9);
      expect(p[1]).toBeCloseTo(expected[1], 9);
      expect(p[2]).toBeCloseTo(expected[2], 9);
    });
  }

  it("places the 53 mm tool offset along the forearm's radial direction (ADR 0015)", () => {
    // At q2 = π/2, q3 = −π/2 the wrist sits straight above the shoulder;
    // the tool adds 53 mm exactly when the TCP moves horizontally out.
    const p = model.forwardKinematics([0, Math.PI / 2, -Math.PI / 2]);
    expect(p[0]).toBeCloseTo(159.8045 + 53, 9);
    // Removing the offset from the radial term must recover the bare wrist.
    expect(p[0] - 53).toBeCloseTo(159.8045, 9);
  });
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

  it("solves the default Home Point [213, 0, 305] on the shoulder-up branch", () => {
    const solved = expectOk(model.inverseKinematics(DEFAULT_MIKO_MINI_HOME_MM));
    expectWithinLimits(model, solved);
    // q1 = atan2(0, 213) = 0; the wrist sits at radial 160 mm, height 145 mm
    // above the 160 mm shoulder, so the planar pair solves to q2 ≈ 1.5653,
    // q3 ≈ −1.6580 (hand-computed from the law of cosines).
    expect(solved[0]).toBeCloseTo(0, 9);
    expect(solved[1]).toBeCloseTo(1.5653, 4);
    expect(solved[2]).toBeCloseTo(-1.658, 4);
    const achieved = model.forwardKinematics(solved);
    expect(achieved[0]).toBeCloseTo(213, 9);
    expect(achieved[1]).toBeCloseTo(0, 9);
    expect(achieved[2]).toBeCloseTo(305, 9);
  });
});

describe("MiKo-mini IK named failure statuses", () => {
  const model = defaultModel();

  it("reports unreachable for points beyond the outer reach", () => {
    expect(model.inverseKinematics([500, 0, 160])).toEqual({ status: "unreachable" });
  });

  it("reports unreachable for points below the folded reach", () => {
    expect(model.inverseKinematics([0, 0, -200])).toEqual({ status: "unreachable" });
  });

  it("accepts a point exactly on the workspace boundary", () => {
    // Fully extended straight ahead: cos(q3) = 1 exactly.
    const solved = expectOk(model.inverseKinematics([2 * 159.8045 + 53, 0, 160]));
    expect(solved[2]).toBeCloseTo(0, 9);
  });

  it("reports angle-limit naming the joint for a limit-violating solution", () => {
    // Behind the base axis above the shoulder, the shoulder-up fold needs
    // q2 past +π (≈ 4.005 rad); the elbow-down mirror is not taken.
    const result = model.inverseKinematics([40, 0, 170]);
    if (result.status !== "angle-limit") throw new Error(`expected angle-limit, got ${result.status}`);
    expect(result.joint).toBe("q2");
    expect(result.bound).toBe("max");
    expect(result.valueRad).toBeGreaterThan(Math.PI);
  });

  it("never throws and never returns ok for garbage coordinates", () => {
    expect(model.inverseKinematics([Number.NaN, 0, 160]).status).toBe("unreachable");
    const probes: readonly (readonly number[])[] = [
      [0, 0, 0],
      [-500, -500, -500],
      [40, 0, 170],
      [Number.POSITIVE_INFINITY, 0, 160],
    ];
    for (const target of probes) {
      const status = model.inverseKinematics(target as [number, number, number]).status;
      expect(["ok", "unreachable", "angle-limit"]).toContain(status);
    }
  });
});

describe("MiKo-mini measured constants (ADR 0015)", () => {
  it("pins the prototype geometry, joint limits, and dynamic limits as configuration", () => {
    expect(DEFAULT_MIKO_MINI_CONFIG.kind).toBe("miko-mini");
    expect(DEFAULT_MIKO_MINI_CONFIG.id).toBe("miko-mini");
    expect(DEFAULT_MIKO_MINI_CONFIG.name).toBe("MiKo-mini");
    // Measured values are not rounded (ADR 0015): 159.8045 came from measurement.
    expect(DEFAULT_MIKO_MINI_CONFIG.geometry).toEqual({
      baseHeightMm: 160,
      upperArmMm: 159.8045,
      forearmMm: 159.8045,
      toolOffsetMm: 53,
    });
    expect(DEFAULT_MIKO_MINI_CONFIG.joints).toEqual([
      {
        name: "q1",
        minRad: -Math.PI,
        maxRad: Math.PI,
        maxVelocityRadS: 1.2,
        maxAccelerationRadS2: 2.8,
        maxJerkRadS3: 9.0,
      },
      {
        name: "q2",
        minRad: -Math.PI,
        maxRad: Math.PI,
        maxVelocityRadS: 0.8,
        maxAccelerationRadS2: 3.0,
        maxJerkRadS3: 8.0,
      },
      {
        name: "q3",
        minRad: -Math.PI,
        maxRad: Math.PI,
        maxVelocityRadS: 0.9,
        maxAccelerationRadS2: 2.5,
        maxJerkRadS3: 8.0,
      },
    ]);
  });

  it("pins the default Home Point at [213, 0, 305] mm", () => {
    expect(DEFAULT_MIKO_MINI_HOME_MM).toEqual([213, 0, 305]);
  });
});

describe("MiKo-mini interface contract", () => {
  const model = defaultModel();

  it("reports angle-limit with the max bound for targets folded behind the base", () => {
    // Straight above the base with the tool subtracted: the shoulder-up
    // solution needs q2 ≈ 3.86 rad > +π.
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
