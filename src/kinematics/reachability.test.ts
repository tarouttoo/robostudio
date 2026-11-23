import { describe, expect, it } from "vitest";

import { arcFromCenter } from "../core/arc";
import { line, point } from "../core/trajectory";
import { vec3 } from "../core/vec";
import { DEFAULT_MIKO_MINI_CONFIG } from "./miko-mini";
import {
  checkPointReachability,
  checkSegmentReachability,
} from "./reachability";
import { createRobotRegistry } from "./registry";
import type { RobotModel } from "./robot-model";

function defaultModel(): RobotModel {
  const result = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG]);
  if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);
  const model = result.registry.resolve("miko-mini");
  if (!model) throw new Error("model miko-mini was not resolved");
  return model;
}

describe("checkPointReachability", () => {
  const model = defaultModel();

  it("reports ok for a point the MiKo-mini reaches within joint limits", () => {
    expect(checkPointReachability(model, [100, 0, 60])).toBe("ok");
  });

  it("reports unreachable for a point outside the workspace", () => {
    expect(checkPointReachability(model, [500, 0, 60])).toBe("unreachable");
  });

  it("reports angle-limit for a reachable point whose shoulder-up solution violates a joint limit", () => {
    // r = 10 mm at shoulder height folds the elbow past its q3 minimum.
    expect(checkPointReachability(model, [10, 0, 60])).toBe("angle-limit");
  });
});

describe("checkSegmentReachability", () => {
  const model = defaultModel();
  const feed = 20; // mm/s; irrelevant to reachability

  it("returns null for a Line fully inside the workspace and within limits", () => {
    const segment = line({ start: vec3(100, 0, 0), end: vec3(150, 0, 0), feed });
    expect(checkSegmentReachability(model, segment)).toBeNull();
  });

  it("returns null for an Arc sampled mid-geometry that never leaves the workspace", () => {
    const segment = arcFromCenter({
      plane: "XY",
      start: vec3(100, 0, 0),
      end: vec3(0, 100, 0),
      center: vec3(0, 0, 0),
      direction: "CCW",
      feed,
    });
    expect(checkSegmentReachability(model, segment)).toBeNull();
  });

  it("flags a Line crossing out of the workspace, naming the first offending point", () => {
    const segment = line({ start: vec3(150, 0, 0), end: vec3(250, 0, 0), feed });
    const violation = checkSegmentReachability(model, segment);
    expect(violation).not.toBeNull();
    if (violation === null) throw new Error("expected a violation");
    if (violation?.status !== "unreachable") throw new Error("expected an unreachable violation");
    expect(violation.atMm.x).toBeGreaterThan(169); // workspace edge at z = 0 sits near r = 169.1
    expect(violation.atMm.x).toBeLessThanOrEqual(250);
    expect(violation.atMm.y).toBe(0);
    expect(violation.atMm.z).toBe(0);
  });

  it("flags an Arc violation that only appears mid-sweep, not at the endpoints", () => {
    // A quarter circle of radius 100 around (100, 100, 0) bulges out to
    // r ≈ 173 mm — past the z = 0 workspace edge near r = 169.1, where
    // the pose first violates q2's minimum and then leaves the
    // workspace entirely — while both endpoints stay reachable.
    const segment = arcFromCenter({
      plane: "XY",
      start: vec3(100, 0, 0),
      end: vec3(0, 100, 0),
      center: vec3(100, 100, 0),
      direction: "CCW",
      feed,
    });
    const violation = checkSegmentReachability(model, segment);
    expect(violation).not.toBeNull();
    if (violation === null) throw new Error("expected a violation");
    if (violation?.status !== "angle-limit") throw new Error("expected an angle-limit violation");
    expect(violation.joint).toBe("q2");
    expect(violation.bound).toBe("min");
    const r = Math.hypot(violation.atMm.x, violation.atMm.y);
    expect(r).toBeGreaterThan(169);
    expect(r).toBeLessThan(170);
  });

  it("flags a Line that starts outside the workspace as unreachable from its first sample", () => {
    const segment = line({ start: vec3(200, 0, 60), end: vec3(250, 0, 60), feed });
    const violation = checkSegmentReachability(model, segment);
    expect(violation).not.toBeNull();
    if (violation === null) throw new Error("expected a violation");
    if (violation?.status !== "unreachable") throw new Error("expected an unreachable violation");
    expect(violation.atMm).toEqual({ x: 200, y: 0, z: 60 });
  });

  it("flags a Line whose interior point only violates a joint limit", () => {
    // The z = 0 region near the origin is geometrically reachable but
    // needs q2 below its -15° minimum.
    const segment = line({ start: vec3(100, 0, 0), end: vec3(2.5, 0, 0), feed });
    const violation = checkSegmentReachability(model, segment);
    expect(violation).not.toBeNull();
    if (violation === null) throw new Error("expected a violation");
    if (violation?.status !== "angle-limit") throw new Error("expected an angle-limit violation");
    expect(violation.joint).toBe("q2");
    expect(violation.bound).toBe("min");
  });

  it("flags a Point Segment by its target alone", () => {
    const inside = point({ target: vec3(100, 0, 60), feed });
    expect(checkSegmentReachability(model, inside)).toBeNull();
    const outside = point({ target: vec3(500, 0, 60), feed });
    const violation = checkSegmentReachability(model, outside);
    expect(violation).not.toBeNull();
    if (violation === null) throw new Error("expected a violation");
    expect(violation.status).toBe("unreachable");
    expect(violation.atMm).toEqual({ x: 500, y: 0, z: 60 });
  });
});
