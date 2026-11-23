import { describe, expect, it } from "vitest";

import { arcFromCenter } from "../core/arc";
import { line, point, trajectory, type Trajectory } from "../core/trajectory";
import { vec3 } from "../core/vec";
import { DEFAULT_MIKO_MINI_CONFIG } from "../kinematics/miko-mini";
import { createRobotRegistry } from "../kinematics/registry";
import type { JointConfig, RobotModel } from "../kinematics/robot-model";
import { CONTROL_STEP_MS, createPchipPlanner, type PlanSegmentRange } from "../motion/planner";
import { runPipeline, type PipelineResult } from "./pipeline";

/*
 * Golden geometry (ADR 0007): the prototype's distortion bug — a drawn
 * square came out a rectangle, its inscribed circle an oval, a few mm
 * of anisotropic error — must be impossible in this repo. The whole
 * pipeline runs on the golden shape and the geometry is reconstructed
 * from the Robot CSV bytes via forward kinematics, so only the
 * exported joint angles decide whether the shape is right.
 *
 * Tolerance constants live in one place here and may only be loosened
 * with an ADR.
 */

/** Drawn-vs-reconstructed agreement for the golden shape, in mm. */
const SHAPE_TOLERANCE_MM = 0.5;

/** Reconstructed points must stay in the drawn Working Plane, in mm. */
const PLANE_TOLERANCE_MM = 0.05;

/** Slack on per-row motion budgets, absorbing grid rounding. */
const MOTION_SLACK = 1.05;

/**
 * Peak reconstructed pen speed as a multiple of the Segment Feed: the
 * quintic S-curve peaks at 1.875× the mean speed, and a joint-space
 * transit's PCHIP path can bulge a further ~6 % in cartesian space
 * (observed on the golden transit), so 2.5× bounds smooth motion while
 * a real discontinuity (a dropped row, a teleporting pen) overshoots
 * it by far.
 */
const PEAK_SPEED_FACTOR = 2.5;

/** The golden shape: a 100×100 mm square with an inscribed r = 50 mm circle. */
const SQUARE_CENTER = vec3(110, 0, 60);
const CIRCLE_RADIUS_MM = 50;

const GOLDEN_SHAPE: Trajectory = trajectory(vec3(60, -50, 60), [
  line({ start: vec3(60, -50, 60), end: vec3(160, -50, 60), feed: 20 }),
  line({ start: vec3(160, -50, 60), end: vec3(160, 50, 60), feed: 20 }),
  line({ start: vec3(160, 50, 60), end: vec3(60, 50, 60), feed: 20 }),
  line({ start: vec3(60, 50, 60), end: vec3(60, -50, 60), feed: 20 }),
  // Pen-up transit to the circle start.
  point({ target: vec3(160, 0, 60), feed: 40 }),
  // The inscribed circle, drawn CCW from (160, 0) back onto itself.
  arcFromCenter({
    plane: "XY",
    start: vec3(160, 0, 60),
    end: vec3(160, 0, 60),
    center: SQUARE_CENTER,
    direction: "CCW",
    feed: 15,
  }),
]);

/** The default MiKo-mini model from validated configuration. */
function defaultModel(): RobotModel {
  const result = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG]);
  if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);
  const model = result.registry.resolve("miko-mini");
  if (!model) throw new Error("model miko-mini was not resolved");
  return model;
}

/** One parsed Robot CSV row: integer milliseconds plus radians. */
interface CsvRow {
  readonly tMs: number;
  readonly q: readonly number[];
}

/** Parses the Robot CSV bytes back into rows (the robot's view of the file). */
function parseRobotCsv(csv: string): readonly CsvRow[] {
  const lines = csv.split("\n");
  expect(lines[0]).toBe("t,q1,q2,q3");
  expect(lines.at(-1)).toBe(""); // trailing newline
  return lines.slice(1, -1).map((line) => {
    const [t, q1, q2, q3] = line.split(",");
    expect(t).toMatch(/^-?\d+$/); // integer milliseconds, no decimals
    return { tMs: Number(t), q: [Number(q1), Number(q2), Number(q3)] };
  });
}

/** The Feed of the Segment a row belongs to, from the plan's ranges. */
function feedAt(ranges: readonly PlanSegmentRange[], tMs: number): number {
  const range = ranges.find((r) => tMs >= r.startMs && tMs < r.endMs) ?? ranges.at(-1);
  if (!range) throw new Error(`no plan range covers t=${tMs} ms`);
  return range.feed;
}

describe("golden geometry: 100×100 square with inscribed r = 50 circle (ADR 0007)", () => {
  const model = defaultModel();
  const result: PipelineResult = runPipeline({
    trajectory: GOLDEN_SHAPE,
    model,
    planner: createPchipPlanner(model),
  });
  const rows = parseRobotCsv(result.robotCsv);
  /** The reconstructed pen position of each row, via forward kinematics. */
  const pen = rows.map((row) => {
    const [x, y, z] = model.forwardKinematics(row.q);
    return { x, y, z };
  });

  // The transit (segment 4) carries no drawn geometry; the circle is segment 5.
  const transitStart = result.plan.ranges.find((r) => r.segmentIndex === 4)?.startMs;
  const circleStart = result.plan.ranges.find((r) => r.segmentIndex === 5)?.startMs;
  if (transitStart === undefined || circleStart === undefined) {
    throw new Error("golden shape plan is missing the transit or circle range");
  }

  it("exports rows that are monotonic and sit exactly on the 20 ms control grid", () => {
    expect(rows.length).toBe(result.plan.rows.length);
    rows.forEach((row, i) => {
      expect(row.tMs).toBe(i * CONTROL_STEP_MS);
    });
  });

  it("keeps motion continuous: no reconstructed jump between consecutive rows", () => {
    for (let i = 1; i < rows.length; i++) {
      const a = pen[i - 1] as { x: number; y: number; z: number };
      const b = pen[i] as { x: number; y: number; z: number };
      const stepMm = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const feed = feedAt(result.plan.ranges, rows[i]!.tMs);
      const budget = PEAK_SPEED_FACTOR * feed * (CONTROL_STEP_MS / 1000) * MOTION_SLACK;
      expect(stepMm).toBeLessThanOrEqual(budget);
    }
  });

  it("respects the Robot Model's dynamic limits on every plan row", () => {
    for (const row of result.plan.rows) {
      row.q.forEach((_, j) => {
        const limit = model.joints[j] as JointConfig;
        expect(Math.abs(row.qd[j] as number)).toBeLessThanOrEqual(limit.maxVelocityRadS + 1e-9);
        expect(Math.abs(row.qdd[j] as number)).toBeLessThanOrEqual(limit.maxAccelerationRadS2 + 1e-9);
        expect(Math.abs(row.qddd[j] as number)).toBeLessThanOrEqual(limit.maxJerkRadS3 + 1e-9);
      });
    }
  });

  it("reconstructs the square: drawn edges land on the square's boundary", () => {
    const squarePen = pen.filter((_, i) => (rows[i] as CsvRow).tMs < transitStart);
    expect(squarePen.length).toBeGreaterThan(300);
    for (const p of squarePen) {
      // The whole square phase draws at z = 60 (XY plane, no drift).
      expect(Math.abs(p.z - 60)).toBeLessThanOrEqual(PLANE_TOLERANCE_MM);
      // Distance to the boundary of [60, 160] × [-50, 50].
      const toBoundary = Math.min(Math.abs(p.x - 60), Math.abs(p.x - 160), Math.abs(p.y + 50), Math.abs(p.y - 50));
      expect(toBoundary).toBeLessThanOrEqual(SHAPE_TOLERANCE_MM);
    }
  });

  it("reconstructs the square's corners, so the edges are the drawn edges", () => {
    const corners = [vec3(60, -50, 60), vec3(160, -50, 60), vec3(160, 50, 60), vec3(60, 50, 60)];
    const squarePen = pen.filter((_, i) => (rows[i] as CsvRow).tMs < transitStart);
    for (const corner of corners) {
      const nearest = Math.min(...squarePen.map((p) => Math.hypot(p.x - corner.x, p.y - corner.y, p.z - corner.z)));
      expect(nearest).toBeLessThanOrEqual(SHAPE_TOLERANCE_MM);
    }
  });

  it("reconstructs the circle: drawn points sit on the r = 50 circle, fully around", () => {
    const circlePen = pen.filter((_, i) => (rows[i] as CsvRow).tMs >= circleStart);
    expect(circlePen.length).toBeGreaterThan(300);
    let minAngle = Infinity;
    let maxAngle = -Infinity;
    let prevAngle = 0;
    for (const p of circlePen) {
      expect(Math.abs(p.z - 60)).toBeLessThanOrEqual(PLANE_TOLERANCE_MM);
      const radius = Math.hypot(p.x - 110, p.y - 0);
      expect(Math.abs(radius - CIRCLE_RADIUS_MM)).toBeLessThanOrEqual(SHAPE_TOLERANCE_MM);
      // Unwrapped angle around the center, to verify the full circle.
      const angle = Math.atan2(p.y, p.x - 110);
      const unwrapped = angle - 2 * Math.PI * Math.round((angle - prevAngle) / (2 * Math.PI));
      minAngle = Math.min(minAngle, unwrapped);
      maxAngle = Math.max(maxAngle, unwrapped);
      prevAngle = unwrapped;
    }
    // The drawn circle is swept fully: the reconstructed angles cover 2π.
    expect(maxAngle - minAngle).toBeGreaterThanOrEqual(2 * Math.PI - 0.05);
  });
});
