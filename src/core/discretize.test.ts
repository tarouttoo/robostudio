import { describe, expect, it } from "vitest";

import { arcFromCenter } from "./arc";
import { discretizeTrajectory } from "./discretize";
import { line, point, trajectory } from "./trajectory";
import { distance, vec3 } from "./vec";

/** Cumulative lengths never decrease along the path. */
function expectMonotonicLengths(
  samples: readonly { pathLengthMm: number }[],
): void {
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1] as { pathLengthMm: number };
    const cur = samples[i] as { pathLengthMm: number };
    expect(cur.pathLengthMm).toBeGreaterThanOrEqual(prev.pathLengthMm);
  }
}

describe("discretization of a line", () => {
  it("samples at ≤ 0.5 mm with exact endpoints and exact cumulative length", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(100, 0, 0), feed: 20 }),
    ]);
    const path = discretizeTrajectory(traj);
    // 100 mm at ≤ 0.5 mm → 200 intervals, 201 samples including both ends.
    expect(path.samples).toHaveLength(201);
    expect(path.home).toEqual(vec3(0, 0, 0));
    const first = path.samples[0];
    expect(first?.position).toEqual(vec3(0, 0, 0));
    expect(first?.pathLengthMm).toBe(0);
    const last = path.samples.at(-1);
    expect(last?.position).toEqual(vec3(100, 0, 0));
    expect(last?.pathLengthMm).toBeCloseTo(100, 10);
    for (let i = 1; i < path.samples.length; i++) {
      const prev = path.samples[i - 1];
      const cur = path.samples[i];
      expect(distance(prev?.position ?? vec3(0, 0, 0), cur?.position ?? vec3(0, 0, 0))).toBeLessThanOrEqual(
        0.5 + 1e-9,
      );
    }
    expectMonotonicLengths(path.samples);
  });

  it("keeps spacing within the step for a non-integer step count", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(0, 0.3, 0), feed: 5 }),
    ]);
    const path = discretizeTrajectory(traj);
    expect(path.samples).toHaveLength(2);
    expect(distance(path.samples[0]?.position ?? vec3(0, 0, 0), path.samples[1]?.position ?? vec3(0, 0, 0))).toBeCloseTo(0.3, 12);
  });

  it("respects a custom max step", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(1, 0, 0), feed: 5 }),
    ]);
    const path = discretizeTrajectory(traj, { maxStepMm: 0.1 });
    expect(path.samples).toHaveLength(11);
  });

  it("rejects a non-positive max step", () => {
    const traj = trajectory(vec3(0, 0, 0), []);
    expect(() => discretizeTrajectory(traj, { maxStepMm: 0 })).toThrow(RangeError);
  });
});

describe("discretization of arcs", () => {
  it("matches the analytic length of a full circle within tight tolerance", () => {
    const circle = arcFromCenter({
      plane: "XY",
      start: vec3(50, 0, 0),
      end: vec3(50, 0, 0),
      center: vec3(0, 0, 0),
      direction: "CCW",
      feed: 20,
    });
    const traj = trajectory(vec3(50, 0, 0), [circle]);
    const path = discretizeTrajectory(traj);
    expect(path.totalLengthMm).toBeCloseTo(2 * Math.PI * 50, 6);
    // 2π·50 ≈ 314.159 mm at ≤ 0.5 mm → 629 intervals, 630 samples.
    expect(path.samples).toHaveLength(630);
    for (const sample of path.samples) {
      expect(distance(sample.position, vec3(0, 0, 0))).toBeCloseTo(50, 6);
    }
    expectMonotonicLengths(path.samples);
  });

  it("keeps spacing within the step on a quarter-circle arc", () => {
    const quarter = arcFromCenter({
      plane: "XY",
      start: vec3(10, 0, 0),
      end: vec3(0, 10, 0),
      center: vec3(0, 0, 0),
      direction: "CCW",
      feed: 20,
    });
    const traj = trajectory(vec3(10, 0, 0), [quarter]);
    const path = discretizeTrajectory(traj);
    for (let i = 1; i < path.samples.length; i++) {
      const prev = path.samples[i - 1];
      const cur = path.samples[i];
      expect(distance(prev?.position ?? vec3(0, 0, 0), cur?.position ?? vec3(0, 0, 0))).toBeLessThanOrEqual(
        0.5 + 1e-9,
      );
    }
    expect(path.totalLengthMm).toBeCloseTo(10 * Math.PI * 0.5, 9);
  });
});

describe("merging at segment joins", () => {
  it("merges duplicate points at segment joins", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 20 }),
      line({ start: vec3(10, 0, 0), end: vec3(20, 0, 0), feed: 20 }),
    ]);
    const path = discretizeTrajectory(traj);
    // 21 samples for the first line + 20 for the second (its duplicate
    // start is merged): 41, not 42.
    expect(path.samples).toHaveLength(41);
    expect(path.totalLengthMm).toBeCloseTo(20, 10);
    for (let i = 1; i < path.samples.length; i++) {
      const prev = path.samples[i - 1];
      const cur = path.samples[i];
      const hop = distance(prev?.position ?? vec3(0, 0, 0), cur?.position ?? vec3(0, 0, 0));
      expect(hop).toBeGreaterThan(1e-9);
      expect(hop).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("merges near-duplicate join points closer than the merge distance", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 20 }),
      line({ start: vec3(10.9, 0, 0), end: vec3(20, 0, 0), feed: 20 }),
    ]);
    const path = discretizeTrajectory(traj);
    // The second line's start (0.9 mm from the join) is merged away:
    // 21 + 19 samples, and the 0.9 mm is folded into the join.
    expect(path.samples).toHaveLength(40);
    expect(path.totalLengthMm).toBeCloseTo(19.1, 10);
    expectMonotonicLengths(path.samples);
  });

  it("keeps the join point exactly once, at the shared position", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 20 }),
      line({ start: vec3(10, 0, 0), end: vec3(10, 10, 0), feed: 20 }),
    ]);
    const path = discretizeTrajectory(traj);
    const join = path.samples[20];
    expect(join?.position).toEqual(vec3(10, 0, 0));
    expect(join?.pathLengthMm).toBeCloseTo(10, 10);
    expect(distance(join?.position ?? vec3(0, 0, 0), path.samples[21]?.position ?? vec3(0, 0, 0))).toBeLessThanOrEqual(0.5 + 1e-9);
  });
});

describe("transits", () => {
  it("counts the approach from the home point when the first segment starts away", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(5, 0, 0), end: vec3(15, 0, 0), feed: 20 }),
    ]);
    const path = discretizeTrajectory(traj);
    // Home pose, arrival at the line start, then 10 mm of line.
    expect(path.samples).toHaveLength(22);
    const first = path.samples[0];
    expect(first?.position).toEqual(vec3(0, 0, 0));
    expect(first?.pathLengthMm).toBe(0);
    const second = path.samples[1];
    expect(second?.position).toEqual(vec3(5, 0, 0));
    expect(second?.pathLengthMm).toBeCloseTo(5, 10);
    expect(path.totalLengthMm).toBeCloseTo(15, 10);
  });

  it("moves to a Point target as a single transit sample", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 10 }),
      point({ target: vec3(20, 0, 0), feed: 15 }),
    ]);
    const path = discretizeTrajectory(traj);
    expect(path.samples).toHaveLength(22);
    const last = path.samples.at(-1);
    expect(last?.position).toEqual(vec3(20, 0, 0));
    expect(last?.pathLengthMm).toBeCloseTo(20, 10);
    expect(last?.feed).toBe(15);
    expect(last?.segmentIndex).toBe(1);
    expect(path.totalLengthMm).toBeCloseTo(20, 10);
  });

  it("emits no sample for a Point whose target merges with the join", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 10 }),
      point({ target: vec3(10.5, 0, 0), feed: 15 }),
    ]);
    const path = discretizeTrajectory(traj);
    expect(path.samples).toHaveLength(21);
    expect(path.totalLengthMm).toBeCloseTo(10, 10);
  });
});

describe("feed and segment propagation", () => {
  it("carries each segment's feed and index through its samples", () => {
    const quarter = arcFromCenter({
      plane: "XY",
      start: vec3(10, 0, 0),
      end: vec3(0, 10, 0),
      center: vec3(0, 0, 0),
      direction: "CCW",
      feed: 30,
    });
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 10 }),
      quarter,
    ]);
    const path = discretizeTrajectory(traj);
    for (const sample of path.samples) {
      if (sample.segmentIndex === 0) expect(sample.feed).toBe(10);
      if (sample.segmentIndex === 1) expect(sample.feed).toBe(30);
    }
    const firstArcSample = path.samples.find((s) => s.segmentIndex === 1);
    expect(firstArcSample).toBeDefined();
    expect(firstArcSample?.feed).toBe(30);
    // The join is exact: the first arc sample is a step beyond (10, 0, 0).
    expect(firstArcSample?.position).not.toEqual(vec3(10, 0, 0));
    expectMonotonicLengths(path.samples);
  });
});

describe("edge cases", () => {
  it("returns an empty path for a trajectory without segments", () => {
    const path = discretizeTrajectory(trajectory(vec3(1, 2, 3), []));
    expect(path.samples).toHaveLength(0);
    expect(path.totalLengthMm).toBe(0);
    expect(path.home).toEqual(vec3(1, 2, 3));
  });

  it("collapses a zero-length Segment to a single arrival sample", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(5, 0, 0), end: vec3(5, 0, 0), feed: 20 }),
    ]);
    const path = discretizeTrajectory(traj);
    // Home, then the arrival at the degenerate Segment's position.
    expect(path.samples).toHaveLength(2);
    expect(path.samples[0]?.position).toEqual(vec3(0, 0, 0));
    expect(path.samples[1]?.position).toEqual(vec3(5, 0, 0));
    expect(path.samples[1]?.pathLengthMm).toBeCloseTo(5, 10);
    expect(path.totalLengthMm).toBeCloseTo(5, 10);
  });

  it("emits no sample for a zero-length Segment joined at the previous end", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 20 }),
      line({ start: vec3(10, 0, 0), end: vec3(10, 0, 0), feed: 20 }),
    ]);
    const path = discretizeTrajectory(traj);
    expect(path.samples).toHaveLength(21);
    expect(path.totalLengthMm).toBeCloseTo(10, 10);
    expectMonotonicLengths(path.samples);
  });
});
