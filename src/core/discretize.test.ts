import { describe, expect, it } from "vitest";

import { arcFromCenter } from "./arc";
import { discretizeTrajectory } from "./discretize";
import { CoreError } from "./errors";
import { line, point, trajectory, type Segment } from "./trajectory";
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

  it("rejects a negative merge distance", () => {
    const traj = trajectory(vec3(0, 0, 0), []);
    expect(() => discretizeTrajectory(traj, { mergeDistanceMm: -1 })).toThrow(RangeError);
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

  it("emits the arrival sample across a gap between Segments, counted at full distance", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 20 }),
      line({ start: vec3(15, 0, 0), end: vec3(25, 0, 0), feed: 20 }),
    ]);
    const path = discretizeTrajectory(traj);
    // 21 samples per line: the 5 mm gap hops straight from (10, 0, 0)
    // to the second line's arrival at (15, 0, 0), counted in full.
    expect(path.samples).toHaveLength(42);
    const arrival = path.samples[21];
    expect(arrival?.position).toEqual(vec3(15, 0, 0));
    expect(arrival?.pathLengthMm).toBeCloseTo(15, 10);
    expect(arrival?.segmentIndex).toBe(1);
    expect(path.totalLengthMm).toBeCloseTo(25, 10);
    expectMonotonicLengths(path.samples);
  });

  it("moves to a Point target as a single transit sample", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 10 }),
      point({ target: vec3(20, 0, 0), feed: 15, motionType: "PTP" }),
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

  it("samples a chain of Point Moves at the endpoint poses only", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      point({ target: vec3(10, 0, 0), feed: 15, motionType: "PTP" }),
      point({ target: vec3(10, 10, 0), feed: 15, motionType: "PTP" }),
    ]);
    const path = discretizeTrajectory(traj);
    // Exactly three poses: the Home start and both Move targets — no
    // per-sample path points, so IK and Reachability see endpoints only.
    expect(path.samples.map((s) => s.position)).toEqual([
      vec3(0, 0, 0),
      vec3(10, 0, 0),
      vec3(10, 10, 0),
    ]);
    expect(path.samples.map((s) => s.segmentIndex)).toEqual([0, 0, 1]);
    expect(path.totalLengthMm).toBeCloseTo(20, 10);
  });

  it("emits no sample for a Point whose target merges with the join", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 10 }),
      point({ target: vec3(10.5, 0, 0), feed: 15, motionType: "PTP" }),
    ]);
    const path = discretizeTrajectory(traj);
    expect(path.samples).toHaveLength(21);
    expect(path.totalLengthMm).toBeCloseTo(10, 10);
  });
});

describe("discretization of LIN Point Moves", () => {
  it("samples a LIN Move along the drawn straight line at ≤ 0.5 mm with exact endpoints", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      point({ target: vec3(10, 0, 0), feed: 15, motionType: "LIN" }),
    ]);
    const path = discretizeTrajectory(traj);
    // 10 mm at ≤ 0.5 mm → 20 intervals, 21 samples: the Home start and
    // the per-sample straight line to the target.
    expect(path.samples).toHaveLength(21);
    const first = path.samples[0];
    expect(first?.position).toEqual(vec3(0, 0, 0));
    expect(first?.pathLengthMm).toBe(0);
    expect(first?.feed).toBe(15);
    expect(first?.segmentIndex).toBe(0);
    const last = path.samples.at(-1);
    expect(last?.position).toEqual(vec3(10, 0, 0));
    expect(last?.pathLengthMm).toBeCloseTo(10, 10);
    for (const sample of path.samples) {
      expect(distance(sample.position, vec3(0, 0, 0))).toBeLessThanOrEqual(10 + 1e-9);
      // Every sample sits exactly on the drawn chord.
      expect(sample.position.y).toBe(0);
      expect(sample.position.z).toBe(0);
    }
    expectMonotonicLengths(path.samples);
  });

  it("continues a LIN Move from the previous Segment's end without duplicating the join", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 10 }),
      point({ target: vec3(20, 0, 0), feed: 15, motionType: "LIN" }),
    ]);
    const path = discretizeTrajectory(traj);
    // 21 line samples + 20 LIN samples: the join at (10, 0, 0) counts once.
    expect(path.samples).toHaveLength(41);
    expect(path.samples[20]?.position).toEqual(vec3(10, 0, 0));
    expect(path.samples[20]?.segmentIndex).toBe(0);
    expect(path.samples[21]?.position).toEqual(vec3(10.5, 0, 0));
    expect(path.samples[21]?.segmentIndex).toBe(1);
    expect(path.samples[21]?.feed).toBe(15);
    expect(path.totalLengthMm).toBeCloseTo(20, 10);
    expectMonotonicLengths(path.samples);
  });

  it("samples a mixed LIN/PTP chain: dense along LIN, endpoints only for PTP", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      point({ target: vec3(10, 0, 0), feed: 15, motionType: "LIN" }),
      point({ target: vec3(30, 0, 0), feed: 15, motionType: "PTP" }),
    ]);
    const path = discretizeTrajectory(traj);
    // 21 dense samples along the LIN chord, then one PTP hop sample.
    expect(path.samples).toHaveLength(22);
    expect(path.samples[20]?.position).toEqual(vec3(10, 0, 0));
    const hop = path.samples.at(-1);
    expect(hop?.position).toEqual(vec3(30, 0, 0));
    expect(hop?.segmentIndex).toBe(1);
    expect(path.totalLengthMm).toBeCloseTo(30, 10);
    expectMonotonicLengths(path.samples);
  });

  it("emits no sample for a LIN Move whose target merges with the join", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 10 }),
      point({ target: vec3(10.5, 0, 0), feed: 15, motionType: "LIN" }),
    ]);
    const path = discretizeTrajectory(traj);
    expect(path.samples).toHaveLength(21);
    expect(path.totalLengthMm).toBeCloseTo(10, 10);
  });

  it("keeps the start pose when a merging LIN Move is the first Segment", () => {
    const traj = trajectory(vec3(0, 0, 0), [
      point({ target: vec3(0.5, 0, 0), feed: 15, motionType: "LIN" }),
    ]);
    const path = discretizeTrajectory(traj);
    expect(path.samples).toHaveLength(1);
    expect(path.samples[0]?.position).toEqual(vec3(0.5, 0, 0));
    expect(path.totalLengthMm).toBe(0);
  });

  it("counts a LIN Move away from Home in full, starting at the Home pose", () => {
    // A LIN Move always starts where the chain is: the first sample is
    // the Home pose itself, then the drawn line to the target.
    const traj = trajectory(vec3(5, 0, 0), [
      point({ target: vec3(15, 0, 0), feed: 15, motionType: "LIN" }),
    ]);
    const path = discretizeTrajectory(traj);
    expect(path.samples).toHaveLength(21);
    expect(path.samples[0]?.position).toEqual(vec3(5, 0, 0));
    expect(path.samples[0]?.pathLengthMm).toBe(0);
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

describe("non-finite geometry defense", () => {
  /** Samples are built from validated Segments; these literals bypass the
   * builders to pin the stage's own defense against NaN/Infinity inputs. */
  function literalSegment(seg: Segment, home = vec3(0, 0, 0)): () => unknown {
    return () => discretizeTrajectory(trajectory(home, [seg]));
  }

  it("rejects a non-finite home with a named error", () => {
    const seg = line({ start: vec3(1, 0, 0), end: vec3(2, 0, 0), feed: 20 });
    expect(literalSegment(seg, vec3(Number.NaN, 0, 0))).toThrow(CoreError);
    expect(literalSegment(seg, vec3(Number.NaN, 0, 0))).toThrow(/finite/);
  });

  it("rejects a line ending at Infinity instead of sampling forever", () => {
    // n = ceil(∞ / step) = ∞: without the guard the sampler would push
    // samples until the heap dies.
    const seg: Segment = {
      kind: "line",
      start: vec3(0, 0, 0),
      end: vec3(Number.POSITIVE_INFINITY, 0, 0),
      feed: 20,
    };
    expect(literalSegment(seg)).toThrow(CoreError);
    expect(literalSegment(seg)).toThrow(/non-finite geometry/);
  });

  it("rejects a point with a NaN target instead of dropping it silently", () => {
    // A NaN hop would otherwise poison the cumulative length of every
    // later sample with no error at all.
    const seg: Segment = {
      kind: "point",
      target: vec3(Number.NaN, 0, 0),
      feed: 20,
      motionType: "PTP",
    };
    expect(literalSegment(seg)).toThrow(CoreError);
  });
});
