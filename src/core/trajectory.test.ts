import { describe, expect, it } from "vitest";

import { CoreError } from "./errors";
import { line, point, segmentEnds, trajectory, type Trajectory } from "./trajectory";
import { vec3 } from "./vec";

/** Runs `fn` and returns the tag of the CoreError it throws. */
function errorTagOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CoreError) return e.tag;
    throw new Error(`expected a CoreError, got: ${String(e)}`);
  }
  throw new Error("expected the function to throw a CoreError");
}

describe("line segment", () => {
  it("stores start, end, and feed", () => {
    const seg = line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 20 });
    expect(seg.kind).toBe("line");
    expect(seg.start).toEqual(vec3(0, 0, 0));
    expect(seg.end).toEqual(vec3(10, 0, 0));
    expect(seg.feed).toBe(20);
  });

  it("rejects a non-positive feed with a named error", () => {
    expect(errorTagOf(() => line({ start: vec3(0, 0, 0), end: vec3(1, 0, 0), feed: 0 }))).toBe(
      "InvalidFeed",
    );
    expect(errorTagOf(() => line({ start: vec3(0, 0, 0), end: vec3(1, 0, 0), feed: -5 }))).toBe(
      "InvalidFeed",
    );
  });

  it("rejects non-finite coordinates with a named error", () => {
    expect(errorTagOf(() => line({ start: vec3(Number.NaN, 0, 0), end: vec3(1, 0, 0), feed: 20 }))).toBe(
      "InvalidCoordinate",
    );
    expect(errorTagOf(() => line({ start: vec3(0, 0, 0), end: vec3(1, Infinity, 0), feed: 20 }))).toBe(
      "InvalidCoordinate",
    );
  });
});

describe("point segment", () => {
  it("stores its target and feed", () => {
    const seg = point({ target: vec3(10, 5, 0), feed: 15 });
    expect(seg.kind).toBe("point");
    expect(seg.target).toEqual(vec3(10, 5, 0));
    expect(seg.feed).toBe(15);
  });

  it("rejects a non-positive feed with a named error", () => {
    expect(errorTagOf(() => point({ target: vec3(1, 2, 3), feed: 0 }))).toBe("InvalidFeed");
  });

  it("rejects a non-finite target with a named error", () => {
    expect(errorTagOf(() => point({ target: vec3(1, Number.NaN, 3), feed: 15 }))).toBe(
      "InvalidCoordinate",
    );
  });
});

describe("trajectory", () => {
  it("holds the home point and the ordered segments", () => {
    const a = line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 20 });
    const b = point({ target: vec3(10, 10, 0), feed: 15 });
    const traj = trajectory(vec3(0, 0, 0), [a, b]);
    expect(traj.home).toEqual(vec3(0, 0, 0));
    expect(traj.segments).toEqual([a, b]);
  });

  it("exposes each segment's start and end uniformly", () => {
    const l = line({ start: vec3(0, 0, 0), end: vec3(10, 0, 0), feed: 20 });
    const p = point({ target: vec3(10, 10, 0), feed: 15 });
    expect(segmentEnds(l)).toEqual({
      start: vec3(0, 0, 0),
      end: vec3(10, 0, 0),
    });
    expect(segmentEnds(p)).toEqual({
      start: vec3(10, 10, 0),
      end: vec3(10, 10, 0),
    });
  });

  it("is a plain data structure usable without a constructor", () => {
    const traj: Trajectory = { home: vec3(1, 2, 3), segments: [] };
    expect(traj.segments).toHaveLength(0);
  });
});
