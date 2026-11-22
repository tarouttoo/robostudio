import { describe, expect, it } from "vitest";

import { CONTROL_STEP_MS, type MotionPlan, type MotionRow } from "../motion/planner";
import { rvizAngles, toRvizCsv } from "./rviz-csv";

/** Builds one MotionRow sitting on the control grid. */
function rowOf(tMs: number, q: readonly number[]): MotionRow {
  return { tMs, segmentIndex: 0, q, qd: [0, 0, 0], qdd: [0, 0, 0], qddd: [0, 0, 0] };
}

/** Builds a MotionPlan around plain rows, as the planner would emit it. */
function planOf(rows: readonly MotionRow[]): MotionPlan {
  const durationMs = rows.at(-1)?.tMs ?? 0;
  return {
    rows,
    ranges: [{ segmentIndex: 0, feed: 20, startMs: 0, endMs: durationMs }],
    durationMs,
  };
}

describe("RViz CSV exporter", () => {
  it("emits the sign-transformed variant of the Robot CSV bytes", () => {
    const plan = planOf([
      rowOf(0, [0, 0.5, -2.5]),
      rowOf(CONTROL_STEP_MS, [-0.25, 1e-7, Math.PI]),
      rowOf(2 * CONTROL_STEP_MS, [-1e-9, -0.123456789, 0]),
    ]);

    // Same time column; the shoulder and elbow pitch flip sign, the
    // base rotation is shared (the mounting convention, ADR 0006).
    expect(toRvizCsv(plan)).toBe(
      "t,q1,q2,q3\n" +
        "0,0.000000,-0.500000,2.500000\n" +
        "20,-0.250000,0.000000,-3.141593\n" +
        "40,0.000000,0.123457,0.000000\n",
    );
  });

  it("emits the bare header for an empty plan", () => {
    expect(toRvizCsv(planOf([]))).toBe("t,q1,q2,q3\n");
  });

  it("rejects joint vectors and rows whose length is not 3, instead of dropping axes or producing NaN", () => {
    expect(() => rvizAngles([1, 2])).toThrow(RangeError);
    expect(() => rvizAngles([1, 2, 3, 4])).toThrow(RangeError);
    const plan = planOf([rowOf(0, [0, 0, 0, 0])]);
    expect(() => toRvizCsv(plan)).toThrow(RangeError);
  });
});
