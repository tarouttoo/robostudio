import { describe, expect, it } from "vitest";

import { CONTROL_STEP_MS, type MotionPlan, type MotionRow } from "../motion/planner";
import { toRobotCsv } from "./robot-csv";

/** Builds one MotionRow sitting on the control grid. */
function rowOf(tMs: number, q: readonly number[]): MotionRow {
  return { tMs, segmentIndex: 0, q, qd: [0, 0, 0], qdd: [0, 0, 0], qddd: [0, 0, 0] };
}

/** Builds a MotionPlan around plain rows, as the planner would emit it. */
function planOf(rows: readonly MotionRow[]): MotionPlan {
  const durationMs = rows.at(-1)?.tMs ?? 0;
  return {
    rows,
    ranges: [{ segmentIndex: 0, feed: 20, achievableFeed: 20, startMs: 0, endMs: durationMs }],
    durationMs,
  };
}

describe("Robot CSV exporter", () => {
  it("emits the exact contracted bytes: header, integer milliseconds, radians at fixed precision", () => {
    const plan = planOf([
      rowOf(0, [0, 0.5, -2.5]),
      rowOf(CONTROL_STEP_MS, [-0.25, 1e-7, Math.PI]),
      rowOf(2 * CONTROL_STEP_MS, [-1e-9, -0.123456789, 0]),
    ]);

    expect(toRobotCsv(plan)).toBe(
      "t,q1,q2,q3\n" +
        "0,0.000000,0.500000,-2.500000\n" +
        "20,-0.250000,0.000000,3.141593\n" +
        "40,0.000000,-0.123457,0.000000\n",
    );
  });

  it("emits the bare header for an empty plan (no rows, no trailing data)", () => {
    expect(toRobotCsv(planOf([]))).toBe("t,q1,q2,q3\n");
  });

  it("rejects a row whose joint count does not match the contracted 3-column layout", () => {
    // A 4-joint row under the fixed `t,q1,q2,q3` header would be silent
    // format drift (ADR 0006): it must fail loudly, never emit.
    const plan = planOf([rowOf(0, [0, 0, 0, 0])]);
    expect(() => toRobotCsv(plan)).toThrow(RangeError);
    expect(() => toRobotCsv(plan)).toThrow(/3 joints/);
  });

  it("writes one row per plan row on the 20 ms step, ignoring nothing", () => {
    const plan = planOf(
      Array.from({ length: 7 }, (_, i) => rowOf(i * CONTROL_STEP_MS, [i * 0.01, 0, 0])),
    );
    const lines = toRobotCsv(plan).split("\n");
    expect(lines.at(0)).toBe("t,q1,q2,q3");
    expect(lines).toHaveLength(9); // header + 7 rows + trailing newline's empty tail
    expect(lines.at(1)).toBe("0,0.000000,0.000000,0.000000");
    expect(lines.at(7)).toBe("120,0.060000,0.000000,0.000000");
    expect(lines.at(8)).toBe("");
  });
});
