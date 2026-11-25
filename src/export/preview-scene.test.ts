import { describe, expect, it } from "vitest";

import { line, point, trajectory, type Trajectory } from "../core/trajectory";
import { vec3 } from "../core/vec";
import { DEFAULT_MIKO_MINI_CONFIG, createMiKoMiniModel } from "../kinematics/miko-mini";
import type { RobotModel } from "../kinematics/robot-model";
import { CONTROL_STEP_MS, type MotionPlan, type MotionRow, type PlanSegmentRange } from "../motion/planner";
import {
  buildPreviewScene,
  MOTION_PREVIEW_MAX_FRAMES,
  type PreviewSceneMoment,
  type PreviewSceneSegment,
} from "./preview-scene";
import { renderMotionPreviewFrames } from "./motion-preview";

/** The default MiKo-mini model from validated configuration. */
const model: RobotModel = (() => {
  const built = createMiKoMiniModel(DEFAULT_MIKO_MINI_CONFIG);
  if (built.status !== "ok") throw new Error(`invalid config: ${built.problems.join("; ")}`);
  return built.model;
})();

/** A plan row frozen at joint pose `q`, traversing segment 0. */
function row(tMs: number, q: readonly number[], segmentIndex = 0): MotionRow {
  return { tMs, segmentIndex, q, qd: [0, 0, 0], qdd: [0, 0, 0], qddd: [0, 0, 0] };
}

/** A crafted one-segment plan: `rows` steps over one range. */
function craftedPlan(rows: readonly MotionRow[], range: PlanSegmentRange, durationMs: number): MotionPlan {
  return { rows, ranges: [range], durationMs };
}

/** A straight Line into the workspace, reachable at the frozen pose. */
const LINE_SCENE: Trajectory = trajectory(vec3(200, 0, 100), [
  line({ start: vec3(200, 0, 100), end: vec3(300, 0, 100), feed: 100 }),
]);

/** A frozen-pose plan over LINE_SCENE: 6 rows, one range. */
const LINE_PLAN = craftedPlan(
  [0, 1, 2, 3, 4, 5].map((i) => row(i * CONTROL_STEP_MS, [0, 0, 0])),
  { segmentIndex: 0, feed: 100, achievableFeed: 100, startMs: 0, endMs: 120 },
  100,
);

/** A drawn Line (segment 0), then a PTP Move away from it (segment 1). */
const PTP_SCENE: Trajectory = trajectory(vec3(200, 0, 100), [
  line({ start: vec3(200, 0, 100), end: vec3(300, 0, 100), feed: 100 }),
  point({ target: vec3(350, 0, 100), feed: 100, motionType: "PTP" }),
]);

/** Two ranges over PTP_SCENE: the drawn Line, then the PTP hop. */
const PTP_PLAN: MotionPlan = (() => {
  const base = craftedPlan(
    [
      row(0, [0, 0, 0], 0),
      row(20, [0, 0, 0], 0),
      row(40, [0, 0.1, 0], 1),
      row(60, [0, 0.2, 0], 1),
      row(80, [0, 0.3, 0], 1),
      row(100, [0, 0.4, 0], 1),
    ],
    { segmentIndex: 0, feed: 100, achievableFeed: 100, startMs: 0, endMs: 40 },
    100,
  );
  const ptpRange: PlanSegmentRange = { segmentIndex: 1, feed: 100, achievableFeed: 100, startMs: 40, endMs: 120 };
  return { ...base, ranges: [base.ranges[0] as PlanSegmentRange, ptpRange] };
})();

/** The scene's one Segment document (the tests below use single-run scenes). */
function onlySegment(scene: { readonly segments: readonly PreviewSceneSegment[] }): PreviewSceneSegment {
  expect(scene.segments.length).toBe(1);
  return scene.segments[0] as PreviewSceneSegment;
}

/** The scene's moment at `index` (moments are the sampled plan rows). */
function momentAt(scene: { readonly moments: readonly PreviewSceneMoment[] }, index: number): PreviewSceneMoment {
  return scene.moments[index] as PreviewSceneMoment;
}

describe("preview scene segment polylines", () => {
  it("groups the drawn trajectory into per-segment mm polylines in traversal order", () => {
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const segment = onlySegment(scene);
    expect(segment.segmentIndex).toBe(0);
    expect(segment.isPtp).toBe(false);
    // The drawn line discretizes to 201 samples at 0.5 mm, from the
    // Home Point to the Line's end.
    expect(segment.mm.length).toBe(201);
    expect(segment.mm[0]).toEqual([200, 0, 100]);
    expect(segment.mm[100]).toEqual([250, 0, 100]);
    expect(segment.mm[200]).toEqual([300, 0, 100]);
  });

  it("flags PTP Moves dashed and drawn geometry solid", () => {
    const scene = buildPreviewScene({ trajectory: PTP_SCENE, plan: PTP_PLAN, model });
    expect(scene.segments.map((s) => s.segmentIndex)).toEqual([0, 1]);
    expect(scene.segments.map((s) => s.isPtp)).toEqual([false, true]);
    // A PTP Move's polyline is its endpoint poses only (the merged join
    // already belongs to the previous segment's run).
    const ptpSegment = scene.segments[1] as PreviewSceneSegment;
    expect(ptpSegment.mm).toEqual([[350, 0, 100]]);
  });

  it("derives per-sample plan times linear in arc length over the segment's range", () => {
    // The Motion Profile is nonlinear in time (the S-curve), so the
    // per-sample time is a schedule cue, not a row time: the range's
    // window spread evenly over the polyline's arc length. Golden:
    // LINE_PLAN's range [0, 120] ms spans the 100 mm line.
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const segment = onlySegment(scene);
    expect(segment.tMs.length).toBe(201);
    expect(segment.tMs[0]).toBe(0);
    // Sample 100 sits at 50 mm of 100 mm: half the range's window.
    expect(segment.tMs[100]).toBe(60);
    expect(segment.tMs[1]).toBeCloseTo(0.6, 9);
    expect(segment.tMs[199]).toBeCloseTo(119.4, 9);
    expect(segment.tMs[200]).toBe(120);
  });

  it("maps each segment's samples over its own range window", () => {
    // PTP_PLAN: segment 0 owns [0, 40] ms, segment 1 owns [40, 120] ms.
    const scene = buildPreviewScene({ trajectory: PTP_SCENE, plan: PTP_PLAN, model });
    const lineSegment = scene.segments[0] as PreviewSceneSegment;
    expect(lineSegment.tMs[0]).toBe(0);
    expect(lineSegment.tMs[100]).toBe(20);
    expect(lineSegment.tMs[200]).toBe(40);
    // The PTP hop's single sample stands at its range's start (a
    // one-sample polyline has no arc length to spread over).
    const ptpSegment = scene.segments[1] as PreviewSceneSegment;
    expect(ptpSegment.tMs).toEqual([40]);
  });

  it("times a PTP hop reached from the Home Point over the hop's chord", () => {
    // A PTP Move as segment 0: its polyline is Home → target (two
    // poses), and its range's window spreads over that chord.
    const ptpScene: Trajectory = trajectory(vec3(200, 0, 100), [
      point({ target: vec3(300, 0, 100), feed: 100, motionType: "PTP" }),
    ]);
    const scene = buildPreviewScene({ trajectory: ptpScene, plan: LINE_PLAN, model });
    const segment = onlySegment(scene);
    expect(segment.isPtp).toBe(true);
    expect(segment.mm).toEqual([
      [200, 0, 100],
      [300, 0, 100],
    ]);
    expect(segment.tMs[0]).toBe(0);
    expect(segment.tMs[1]).toBe(120);
  });
});

describe("preview scene moments", () => {
  it("samples one moment per plan row with the rows' times", () => {
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(scene.moments.length).toBe(LINE_PLAN.rows.length);
    expect(scene.moments.map((m) => m.tMs)).toEqual(LINE_PLAN.rows.map((r) => r.tMs));
  });

  it("caps the moments at 300, evenly paced over the plan duration", () => {
    // 1000 rows = 20 s of motion: far past the moment budget.
    const rows = Array.from({ length: 1000 }, (_, i) => row(i * CONTROL_STEP_MS, [0, 0, 0]));
    const longPlan = craftedPlan(rows, { segmentIndex: 0, feed: 100, achievableFeed: 100, startMs: 0, endMs: 20_000 }, 19_980);
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan: longPlan, model });
    expect(scene.moments.length).toBe(MOTION_PREVIEW_MAX_FRAMES);
    expect(scene.moments.length).toBe(300);
    expect(scene.moments[0]?.tMs).toBe(0);
    expect(scene.moments[299]?.tMs).toBe(19_980);
    // Even time spacing: consecutive sampled times differ by ~1/299 of
    // the duration, on the row grid (67 ± rounding).
    const gaps = scene.moments.slice(1).map((m, i) => m.tMs - (scene.moments[i] as PreviewSceneMoment).tMs);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(CONTROL_STEP_MS);
  });

  it("carries the chain skeleton in mm per moment, joints.length + 2 points", () => {
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    for (const moment of scene.moments) {
      expect(moment.chainMm.length).toBe(model.joints.length + 2);
      // Frozen pose: the chain equals the model's skeleton exactly.
      expect(moment.chainMm).toEqual(model.chainPoints([0, 0, 0]));
    }
  });

  it("carries the TCP position as the chain's last point (per-frame FK)", () => {
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    for (const moment of scene.moments) {
      const chain = moment.chainMm;
      expect(moment.tcpMm).toEqual(chain[chain.length - 1]);
    }
  });
});

describe("preview scene travelled extents", () => {
  it("carries one travelled count per plan range, empty at the start", () => {
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(momentAt(scene, 0).travelled).toEqual([0]);
  });

  it("completes the travelled extent on the last moment", () => {
    // The plan's grid-rounded durationMs (100) sits short of the range's
    // endMs (120): completion is judged against min(endMs, durationMs),
    // so the final moment still holds the journey complete.
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(momentAt(scene, 5).travelled).toEqual([201]);
  });

  it("cuts the travelled extent mid-range at the pen's actual position", () => {
    // Rows whose FK TCP sits exactly on the drawn line at known spots:
    // the honest extent ends where the TCP actually is, whatever pace
    // the Motion Profile keeps (a time-fraction cut would lead or trail).
    const qAt = (x: number): readonly number[] => {
      const ik = model.inverseKinematics([x, 0, 100]);
      if (ik.status !== "ok") throw new Error(`unreachable target x=${x}`);
      return ik.joints;
    };
    const plan = craftedPlan(
      [
        row(0, qAt(200)),
        row(20, qAt(212.5)),
        row(40, qAt(225)),
        row(60, qAt(237.5)),
        row(80, qAt(250)),
        row(100, qAt(262.5)),
      ],
      { segmentIndex: 0, feed: 100, achievableFeed: 100, startMs: 0, endMs: 120 },
      100,
    );
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan, model });
    // The pen at x mm stands at polyline sample (x − 200) / 0.5, so
    // travelled = nearest sample + 1.
    expect(momentAt(scene, 1).travelled).toEqual([26]); // pen at 212.5
    expect(momentAt(scene, 2).travelled).toEqual([51]); // pen at 225
    expect(momentAt(scene, 3).travelled).toEqual([76]); // pen at 237.5
    expect(momentAt(scene, 4).travelled).toEqual([101]); // pen at 250
  });

  it("contributes no travelled extent under a PTP Move", () => {
    const scene = buildPreviewScene({ trajectory: PTP_SCENE, plan: PTP_PLAN, model });
    for (const moment of scene.moments) {
      expect(moment.travelled.length).toBe(2);
      // The drawn Line's extent grows, the PTP hop never highlights.
      expect(moment.travelled[1]).toBe(0);
    }
    expect(momentAt(scene, 5).travelled[0]).toBe(201);
    // Before the Line's range starts moving (t = 0), nothing travelled.
    expect(momentAt(scene, 0).travelled).toEqual([0, 0]);
    // Mid-Line (t = 20 of [0, 40]): cut at the pen's frozen position —
    // the frozen pose q = [0,0,0] puts the TCP at x = 372.609, past the
    // line's end: the nearest drawn sample is the last one.
    expect(momentAt(scene, 1).travelled[0]).toBe(201);
  });
});

describe("preview scene PTP trace runs", () => {
  it("carries no trace runs when the Trajectory holds no PTP Move", () => {
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(scene.traceRuns).toEqual([]);
  });

  it("collects runs of consecutive moments traversing one PTP Move", () => {
    const scene = buildPreviewScene({ trajectory: PTP_SCENE, plan: PTP_PLAN, model });
    // Moments 2–5 traverse segment 1 (the PTP Move) consecutively.
    expect(scene.traceRuns).toEqual([[2, 3, 4, 5]]);
  });
});

describe("preview scene home and bounds", () => {
  it("carries the Home Point in millimetres", () => {
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(scene.homeMm).toEqual([200, 0, 100]);
  });

  it("bounds the scene over trajectory polylines, chain points, and home", () => {
    // Frozen pose q = [0,0,0]: the skeleton reaches x = 372.609 mm (the
    // stretched arm, past the line's 300 mm end) and down to the base
    // foot at [0, 0, 0]; every y is 0 and z spans [0, 160] mm.
    const scene = buildPreviewScene({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(scene.boundsMm.min).toEqual([0, 0, 0]);
    expect(scene.boundsMm.max).toEqual([372.609, 0, 160]);
  });

  it("bounds contain every scene point of a PTP scene", () => {
    const scene = buildPreviewScene({ trajectory: PTP_SCENE, plan: PTP_PLAN, model });
    const points = [scene.homeMm];
    for (const segment of scene.segments) points.push(...segment.mm);
    for (const moment of scene.moments) points.push(...moment.chainMm);
    for (const p of points) {
      for (const axis of [0, 1, 2] as const) {
        expect(scene.boundsMm.min[axis]).toBeLessThanOrEqual(p[axis]);
        expect(scene.boundsMm.max[axis]).toBeGreaterThanOrEqual(p[axis]);
      }
    }
    // And the bounds are tight: exactly the componentwise min/max of
    // those points (the tilted arm chains set the max x and z).
    expect(scene.boundsMm.min).toEqual([
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.min(...points.map((p) => p[2])),
    ]);
    expect(scene.boundsMm.max).toEqual([
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[2])),
    ]);
  });
});

describe("preview scene determinism", () => {
  it("two runs produce identical documents", () => {
    const a = buildPreviewScene({ trajectory: PTP_SCENE, plan: PTP_PLAN, model });
    const b = buildPreviewScene({ trajectory: PTP_SCENE, plan: PTP_PLAN, model });
    expect(a).toEqual(b);
  });

  it("projects a prebuilt scene into the same frames as a fresh build", () => {
    // The renderer's two input modes: without `scene` it builds the
    // document from the trajectory/plan/model; with `scene` it projects
    // the prebuilt one. Both paths must yield identical frames.
    const scene = buildPreviewScene({ trajectory: PTP_SCENE, plan: PTP_PLAN, model });
    const built = renderMotionPreviewFrames({ trajectory: PTP_SCENE, plan: PTP_PLAN, model });
    const accepted = renderMotionPreviewFrames({ trajectory: PTP_SCENE, plan: PTP_PLAN, model, scene });
    expect(accepted).toEqual(built);
  });
});
