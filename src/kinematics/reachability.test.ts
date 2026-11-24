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
    // Radial 40 mm at z = 170 mm sits behind the base axis above the
    // shoulder: the shoulder-up fold needs q2 ≈ 4.005 rad > +π.
    expect(checkPointReachability(model, [40, 0, 170])).toBe("angle-limit");
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
    // At z = 0 the wrist must sit within sqrt(319.609² − 160²) ≈ 276.7 mm
    // of the base axis after the 53 mm tool is subtracted, i.e. the TCP
    // edge sits near r = 329.7 mm.
    const segment = line({ start: vec3(150, 0, 0), end: vec3(400, 0, 0), feed });
    const violation = checkSegmentReachability(model, segment);
    expect(violation).not.toBeNull();
    if (violation === null) throw new Error("expected a violation");
    if (violation?.status !== "unreachable") throw new Error("expected an unreachable violation");
    expect(violation.atMm.x).toBeGreaterThan(329);
    expect(violation.atMm.x).toBeLessThanOrEqual(400);
    expect(violation.atMm.y).toBe(0);
    expect(violation.atMm.z).toBe(0);
  });

  it("flags an Arc violation that only appears mid-sweep, not at the endpoints", () => {
    // A 120° sweep of a circle of radius 60 around (280, 0, 0) bulges out
    // to r = 340 mm — past the z = 0 workspace edge near r = 329.7 mm —
    // while both endpoints stay inside at r ≈ 314.3 mm.
    const arcY = 60 * (Math.sqrt(3) / 2);
    const segment = arcFromCenter({
      plane: "XY",
      start: vec3(310, arcY, 0),
      end: vec3(310, -arcY, 0),
      center: vec3(280, 0, 0),
      direction: "CW",
      feed,
    });
    const violation = checkSegmentReachability(model, segment);
    expect(violation).not.toBeNull();
    if (violation === null) throw new Error("expected a violation");
    if (violation?.status !== "unreachable") throw new Error("expected an unreachable violation");
    const r = Math.hypot(violation.atMm.x, violation.atMm.y);
    expect(r).toBeGreaterThan(329);
    expect(Math.abs(violation.atMm.y)).toBeLessThan(arcY); // strictly between the endpoints
  });

  it("flags a Line that starts outside the workspace as unreachable from its first sample", () => {
    const segment = line({ start: vec3(400, 0, 160), end: vec3(450, 0, 160), feed });
    const violation = checkSegmentReachability(model, segment);
    expect(violation).not.toBeNull();
    if (violation === null) throw new Error("expected a violation");
    if (violation?.status !== "unreachable") throw new Error("expected an unreachable violation");
    expect(violation.atMm).toEqual({ x: 400, y: 0, z: 160 });
  });

  it("flags a Line whose interior runs into a joint-limit-only zone", () => {
    // Above the shoulder, behind the base axis (radial below the 53 mm
    // tool), the shoulder-up fold needs q2 past +π — geometrically in the
    // workspace, but outside the joint limits. The Line starts at radial
    // 56 mm (wrist radius 3 mm, still solvable) and ends deep in the zone.
    const segment = line({ start: vec3(56, 0, 200), end: vec3(36, 0, 200), feed });
    const violation = checkSegmentReachability(model, segment);
    expect(violation).not.toBeNull();
    if (violation === null) throw new Error("expected a violation");
    if (violation?.status !== "angle-limit") throw new Error("expected an angle-limit violation");
    expect(violation.joint).toBe("q2");
    expect(violation.bound).toBe("max");
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
