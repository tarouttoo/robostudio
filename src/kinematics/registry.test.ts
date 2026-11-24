import { describe, expect, it } from "vitest";

import { DEFAULT_MIKO_MINI_CONFIG } from "./miko-mini";
import { createRobotRegistry } from "./registry";

describe("robot registry", () => {
  it("resolves the default MiKo-mini model by id", () => {
    const result = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG]);
    if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);

    const model = result.registry.resolve("miko-mini");
    if (!model) throw new Error("model miko-mini was not resolved");

    expect(model.id).toBe("miko-mini");
    expect(model.name).toBe("MiKo-mini");
    expect(model.joints.map((joint) => joint.name)).toEqual(["q1", "q2", "q3"]);
  });

  it("returns undefined for an unknown id", () => {
    const result = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG]);
    if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);

    expect(result.registry.resolve("other-robot")).toBeUndefined();
  });
});

describe("robot registry configuration", () => {
  it("constructs a model from the given geometry, not from constants", () => {
    const config = {
      ...DEFAULT_MIKO_MINI_CONFIG,
      id: "bench-mock",
      name: "Bench mock",
      geometry: { baseHeightMm: 10, upperArmMm: 50, forearmMm: 40, toolOffsetMm: 5 },
    };
    const result = createRobotRegistry([config]);
    if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);

    const model = result.registry.resolve("bench-mock");
    if (!model) throw new Error("model bench-mock was not resolved");
    expect(model.name).toBe("Bench mock");

    // Fully extended forward: r = 50 + 40 + 5, z = 10.
    const p = model.forwardKinematics([0, 0, 0]);
    expect(p[0]).toBeCloseTo(95, 9);
    expect(p[2]).toBeCloseTo(10, 9);
  });

  it("reports invalid geometry with named problems", () => {
    const result = createRobotRegistry([
      {
        ...DEFAULT_MIKO_MINI_CONFIG,
        geometry: { baseHeightMm: -1, upperArmMm: -5, forearmMm: 40, toolOffsetMm: -3 },
      },
    ]);
    if (result.status !== "invalid-config") throw new Error("expected invalid-config");
    expect(result.problems.some((p) => p.includes("upperArmMm"))).toBe(true);
    expect(result.problems.some((p) => p.includes("baseHeightMm"))).toBe(true);
    expect(result.problems.some((p) => p.includes("toolOffsetMm"))).toBe(true);
  });

  it("reports invalid joint limits and dynamics with named problems", () => {
    const joints = DEFAULT_MIKO_MINI_CONFIG.joints.map((joint, i) =>
      i === 1
        ? { ...joint, minRad: 2, maxRad: 1, maxVelocityRadS: -1 }
        : joint,
    );
    const result = createRobotRegistry([{ ...DEFAULT_MIKO_MINI_CONFIG, joints }]);
    if (result.status !== "invalid-config") throw new Error("expected invalid-config");
    expect(result.problems.some((p) => p.includes("minRad 2 must be below maxRad 1"))).toBe(true);
    expect(result.problems.some((p) => p.includes("maxVelocityRadS"))).toBe(true);
  });

  it("reports duplicate ids even when the earlier config with that id failed validation", () => {
    const invalid = {
      ...DEFAULT_MIKO_MINI_CONFIG,
      geometry: { baseHeightMm: -1, upperArmMm: 159.8045, forearmMm: 159.8045, toolOffsetMm: 53 },
    };
    const result = createRobotRegistry([
      invalid,
      { ...invalid, geometry: DEFAULT_MIKO_MINI_CONFIG.geometry },
    ]);
    if (result.status !== "invalid-config") throw new Error("expected invalid-config");
    expect(result.problems.some((p) => p.includes('duplicate model id "miko-mini"'))).toBe(true);
    expect(result.problems.some((p) => p.includes("baseHeightMm"))).toBe(true);
  });

  it("rejects unsupported model kinds and duplicate ids", () => {
    const renamed = { ...DEFAULT_MIKO_MINI_CONFIG, id: "twin" };
    const result = createRobotRegistry([
      { ...renamed, kind: "fantasy-arm" as unknown as "miko-mini" },
      renamed,
      renamed,
    ]);
    if (result.status !== "invalid-config") throw new Error("expected invalid-config");
    expect(result.problems.some((p) => p.includes('unsupported model kind "fantasy-arm"'))).toBe(true);
    expect(result.problems.some((p) => p.includes('duplicate model id "twin"'))).toBe(true);
  });
});
