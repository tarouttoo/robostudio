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

/**
 * Renders the Motion Plan as Robot CSV bytes (header `t,q1,q2,q3`,
 * integer milliseconds, radians at fixed precision, one row per plan
 * row on the 20 ms control step). Pure function over the plan; file
 * writing happens outside the exporters.
 */
export function toRobotCsv(plan: MotionPlan): string {
  return formatPlanCsv(plan, (q) => [...q]);
}

/** Shared CSV assembly for the exporters (ADR 0006): header plus one row per
 * plan row, with the row's joint vector produced by `jointsOf` — the Robot
 * CSV passes the joints through; the RViz CSV applies the sign transform.
 * Radians print at fixed six-decimal precision; negative results that round
 * to zero print as `0.000000`. */
export function formatPlanCsv(
  plan: MotionPlan,
  jointsOf: (q: readonly number[]) => readonly number[],
): string {
  const lines = ["t,q1,q2,q3"];
  for (const row of plan.rows) {
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
