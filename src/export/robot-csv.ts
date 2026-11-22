/**
 * The Robot CSV Exporter (GLOSSARY.md): the byte-level file the real
 * MiKo-mini controller consumes. The format is a contract pinned by
 * golden fixtures (ADR 0006):
 *
 * - Header `t,q1,q2,q3`, comma-separated, `\n` line endings, trailing
 *   newline after the last row.
 * - `t` is the row time in integer milliseconds on the 20 ms control
 *   step (`CONTROL_STEP_MS`).
 * - `q1, q2, q3` are joint angles in radians, fixed six-decimal
 *   notation; negative results that round to zero print as `0.000000`
 *   (never `-0.000000`).
 *
 * Any change to these bytes is a deliberate format change: update the
 * committed golden fixture in the same PR and state the robot-side
 * verification in the PR body.
 */

import type { MotionPlan } from "../motion/planner";

/** The joint-column count the contracted layout pins: `t,q1,q2,q3`. */
export const CSV_JOINT_COUNT = 3;

/**
 * Renders the Motion Plan as Robot CSV bytes (header `t,q1,q2,q3`,
 * integer milliseconds, radians at fixed precision, one row per plan
 * row on the 20 ms control step). Pure function over the plan; file
 * writing happens outside the exporters.
 *
 * The header is a fixed contract, so a plan whose rows carry a
 * different joint count must fail loudly — emitting extra cells under
 * a 3-joint header (or silently truncating, as the RViz transform
 * would) is exactly the accidental format drift ADR 0006 forbids.
 */
export function toRobotCsv(plan: MotionPlan): string {
  return formatPlanCsv(plan, (q) => [...q]);
}

/** Shared CSV assembly for the exporters (ADR 0006): header plus one row per
 * plan row, with the row's joint vector produced by `jointsOf` — the Robot
 * CSV passes the joints through; the RViz CSV applies the sign transform.
 * Radians print at fixed six-decimal precision; negative results that round
 * to zero print as `0.000000`. Throws a `RangeError` on a row whose joint
 * count does not match the contracted {@link CSV_JOINT_COUNT} columns. */
export function formatPlanCsv(
  plan: MotionPlan,
  jointsOf: (q: readonly number[]) => readonly number[],
): string {
  const lines = ["t,q1,q2,q3"];
  for (const row of plan.rows) {
    if (row.q.length !== CSV_JOINT_COUNT) {
      throw new RangeError(
        `plan row at ${row.tMs} ms carries ${row.q.length} joint angle(s), but the contracted CSV layout is fixed at ${CSV_JOINT_COUNT} joints (t,q1,q2,q3; ADR 0006)`,
      );
    }
    const cells = [String(row.tMs), ...jointsOf(row.q).map(formatRad)];
    lines.push(cells.join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Formats one joint angle cell: radians at fixed precision, no `-0.000000`. */
function formatRad(value: number): string {
  const text = value.toFixed(6);
  return text === "-0.000000" ? "0.000000" : text;
}
