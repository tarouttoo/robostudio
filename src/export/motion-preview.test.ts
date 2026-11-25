import { describe, expect, it } from "vitest";

import { line, point, trajectory, type Trajectory } from "../core/trajectory";
import { vec3 } from "../core/vec";
import { DEFAULT_MIKO_MINI_CONFIG, createMiKoMiniModel } from "../kinematics/miko-mini";
import type { RobotModel } from "../kinematics/robot-model";
import { CONTROL_STEP_MS, type MotionPlan, type MotionRow, type PlanSegmentRange } from "../motion/planner";
import {
  MOTION_PREVIEW_COLORS,
  MOTION_PREVIEW_HEIGHT,
  MOTION_PREVIEW_PALETTE,
  MOTION_PREVIEW_TIME_RAMP,
  MOTION_PREVIEW_WIDTH,
  renderMotionPreviewFrames,
  renderMotionPreviewGif,
  rasterizePreviewFrame,
  timeToRampIndex,
  type MotionPreviewFrame,
  type PreviewPrimitive,
} from "./motion-preview";
import { decodeGifFrames } from "./gif-test-support";

/** The default MiKo-mini model from validated configuration. */
const model: RobotModel = (() => {
  const built = createMiKoMiniModel(DEFAULT_MIKO_MINI_CONFIG);
  if (built.status !== "ok") throw new Error(`invalid config: ${built.problems.join("; ")}`);
  return built.model;
})();

/**
 * The isometric projection contract (ADR 0013, the path-3d chart's
 * convention): X and Y recede along the ±30° ground axes, Z stays
 * vertical; a model-frame millimetre point maps to projected
 * millimetres. The frame renderer must project with exactly this
 * formula, so the tests pin it here, by hand.
 */
function iso(p: readonly [number, number, number]): readonly [number, number] {
  const cos30 = Math.cos(Math.PI / 6);
  const sin30 = 0.5;
  return [(p[0] - p[1]) * cos30, p[2] + (p[0] + p[1]) * sin30];
}

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

/** Collects every polyline primitive carrying the given color. */
function polylines(
  frame: ReturnType<typeof renderMotionPreviewFrames>[number],
  colorIndex: number,
  kind: "solid" | "dashed",
): readonly (readonly (readonly [number, number])[])[] {
  return frame.primitives
    .filter((p) => p.kind === kind && p.colorIndex === colorIndex && p.points.length > 1)
    .map((p) => p.points);
}

describe("motion preview frame geometry", () => {
  it("renders an 800×600 frame", () => {
    expect(MOTION_PREVIEW_WIDTH).toBe(800);
    expect(MOTION_PREVIEW_HEIGHT).toBe(600);
  });

  it("renders one frame per plan row when the plan fits the frame budget", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(frames.length).toBe(LINE_PLAN.rows.length);
    expect(frames.map((f) => f.tMs)).toEqual(LINE_PLAN.rows.map((r) => r.tMs));
  });

  it("samples at most 300 frames, evenly paced over the plan duration", () => {
    // 1000 rows = 20 s of motion: far past the frame budget.
    const rows = Array.from({ length: 1000 }, (_, i) => row(i * CONTROL_STEP_MS, [0, 0, 0]));
    const longPlan = craftedPlan(rows, { segmentIndex: 0, feed: 100, achievableFeed: 100, startMs: 0, endMs: 20_000 }, 19_980);
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: longPlan, model });
    expect(frames.length).toBe(300);
    expect(frames[0]?.tMs).toBe(0);
    expect(frames[299]?.tMs).toBe(19_980);
    // Even time spacing: consecutive sampled times differ by ~1/299 of
    // the duration, on the row grid (67 ± rounding).
    const gaps = frames.slice(1).map((f, i) => f.tMs - (frames[i] as (typeof frames)[number]).tMs);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(CONTROL_STEP_MS);
  });

  /** Collects the time-gradient Trajectory polylines: the strokes carrying per-point ramp colors. */
  function gradientPolylines(
    frame: MotionPreviewFrame,
    kind: "solid" | "dashed",
  ): readonly (readonly (readonly [number, number])[])[] {
    return frame.primitives
      .filter((p) => p.kind === kind && p.pointColors !== undefined && p.points.length > 1)
      .map((p) => p.points);
  }

  it("draws the full drawn trajectory solid, pinned in isometric pixel space", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const traj = gradientPolylines(frames[0] as (typeof frames)[number], "solid");
    expect(traj.length).toBe(1);
    // The drawn line projects (in projected mm) from iso(home) to
    // iso(end); the frame's polyline must span the same projected
    // direction with equal aspect — both pixel deltas proportional to
    // the projected ones.
    const [home2, end2] = [iso([200, 0, 100]), iso([300, 0, 100])] as const;
    const pts = traj[0] as readonly (readonly [number, number])[];
    const dxPx = pts[pts.length - 1]![0] - pts[0]![0];
    const dyPx = pts[pts.length - 1]![1] - pts[0]![1];
    const dxMm = end2[0] - home2[0];
    const dyMm = end2[1] - home2[1];
    // Same direction, y flipped onto the pixel grid (screen y grows down).
    // Pixel endpoints are rounded to whole pixels, so a few hundredths of
    // slope tolerance absorbs the rounding.
    expect(Math.abs(dxPx / dyPx - dxMm / -dyMm)).toBeLessThan(0.05);
    // And the projected length maps at the frame's uniform mm→px scale
    // (equal aspect): one scale for both axes, pinned via the ratio of
    // pixel length to projected length.
    const pxLen = Math.hypot(dxPx, dyPx);
    const mmLen = Math.hypot(dxMm, dyMm);
    expect(pxLen / mmLen).toBeGreaterThan(0.5);
    expect(pxLen / mmLen).toBeLessThan(4);
  });

  it("draws PTP hops dashed and LIN moves solid", () => {
    // Same line, but reached by a PTP Move from the Home Point.
    const ptpScene: Trajectory = trajectory(vec3(200, 0, 100), [
      point({ target: vec3(300, 0, 100), feed: 100, motionType: "PTP" }),
    ]);
    const frames = renderMotionPreviewFrames({ trajectory: ptpScene, plan: LINE_PLAN, model });
    const dashed = gradientPolylines(frames[0] as (typeof frames)[number], "dashed");
    const solid = gradientPolylines(frames[0] as (typeof frames)[number], "solid");
    expect(dashed.length).toBe(1);
    expect(solid.length).toBe(0);
  });

  it("colors the trajectory samples through the time ramp by their plan time", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const frame = frames[0] as (typeof frames)[number];
    const gradient = frame.primitives.find((p) => p.pointColors !== undefined)!;
    const colors = gradient.pointColors as readonly number[];
    // One ramp index per sample, aligned with the polyline.
    expect(colors.length).toBe(gradient.points.length);
    // The first sample stands at the Home Point at t = 0: the ramp's head.
    expect(colors[0]).toBe(timeToRampIndex(0));
    // Per-sample plan times grow linearly in arc length over the plan
    // duration, so the ramp indices march monotonically to the tail.
    for (let i = 1; i < colors.length; i++) {
      expect(colors[i] as number).toBeGreaterThanOrEqual(colors[i - 1] as number);
    }
    expect(colors[colors.length - 1]).toBe(timeToRampIndex(120 / 100)); // clamped to the ramp's tail
    // Same palette indices the exposed ramp holds.
    for (const c of colors) {
      expect(MOTION_PREVIEW_TIME_RAMP).toContain(c);
    }
  });

  it("draws the scene bounds' back panes and grid behind every geometry", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const frame = frames[0] as (typeof frames)[number];
    // Draw order: the three pane fills first, then the grid strokes, then
    // the trajectory gradient and everything above it.
    const fills = frame.primitives.filter((p) => p.kind === "fill");
    expect(fills.length).toBe(3);
    expect(fills.map((p) => p.colorIndex)).toEqual([
      MOTION_PREVIEW_COLORS.paneX,
      MOTION_PREVIEW_COLORS.paneY,
      MOTION_PREVIEW_COLORS.paneZ,
    ]);
    expect(frame.primitives[0]).toBe(fills[0]);
    expect(frame.primitives[1]).toBe(fills[1]);
    expect(frame.primitives[2]).toBe(fills[2]);
    const firstGradient = frame.primitives.findIndex((p) => p.pointColors !== undefined);
    const grids = frame.primitives.slice(3, firstGradient);
    expect(grids.length).toBeGreaterThan(0);
    for (const grid of grids) {
      expect(grid.kind).toBe("solid");
      expect(grid.colorIndex).toBe(MOTION_PREVIEW_COLORS.grid);
      expect(grid.width).toBe(1);
    }
  });

  it("highlights the travelled part progressively, complete by the last frame", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const first = polylines(frames[0] as (typeof frames)[number], MOTION_PREVIEW_COLORS.travelled, "solid");
    const last = polylines(frames[frames.length - 1] as (typeof frames)[number], MOTION_PREVIEW_COLORS.travelled, "solid");
    // Early: almost nothing travelled (a polyline too short to span).
    expect(first.length).toBe(0);
    // Last frame: the whole drawn geometry is highlighted.
    expect(last.length).toBe(1);
    const traj = gradientPolylines(frames[0] as (typeof frames)[number], "solid")[0] as readonly (readonly [number, number])[];
    const highlighted = last[0] as readonly (readonly [number, number])[];
    expect(highlighted.length).toBe(traj.length);
    expect(highlighted[0]).toEqual(traj[0]);
    expect(highlighted[highlighted.length - 1]).toEqual(traj[traj.length - 1]);
  });

  it("highlights up to the pen's actual position mid-range, not the time fraction", () => {
    // Rows whose FK TCP sits exactly on the drawn line at known spots:
    // the honest highlight endpoint is where the TCP marker is, whatever
    // pace the Motion Profile keeps (a time-fraction cut at t = 40 ms of
    // a 120 ms range would sit at ⅓ of the polyline — ahead of the pen).
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
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan, model });
    const mid = frames[2] as MotionPreviewFrame; // t = 40 ms, pen at x = 225
    const highlight = polylines(mid, MOTION_PREVIEW_COLORS.travelled, "solid");
    expect(highlight.length).toBe(1);
    const pts = highlight[0] as readonly (readonly [number, number])[];
    const tcpDot = mid.primitives.find(
      (p) => p.kind === "dot" && p.colorIndex === MOTION_PREVIEW_COLORS.tcp,
    )!.points[0] as readonly [number, number];
    const end = pts[pts.length - 1] as readonly [number, number];
    // The highlight ends at the pen: within ~2 px of the TCP marker
    // (nearest 0.5 mm polyline sample + pixel rounding).
    const distPx = Math.hypot(end[0] - tcpDot[0], end[1] - tcpDot[1]);
    expect(distPx).toBeLessThanOrEqual(2);
  });

  it("marks the Home Point in every frame at the home's projected pixel", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    for (const frame of frames) {
      const dots = frame.primitives.filter(
        (p) => p.kind === "dot" && p.colorIndex === MOTION_PREVIEW_COLORS.home,
      );
      expect(dots.length).toBe(1);
      const dot = dots[0]!.points[0]!;
      const traj = gradientPolylines(frame, "solid")[0] as readonly (readonly [number, number])[];
      const trajStart = traj[0]!;
      // The trajectory's first sample starts at the Home Point, so its
      // polyline's first pixel is the home's projection (within a pixel
      // of rounding).
      expect(Math.abs(dot[0] - trajStart[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(dot[1] - trajStart[1])).toBeLessThanOrEqual(1);
    }
  });

  it("draws the robot skeleton and the TCP marker per frame", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    for (const frame of frames) {
      const skeleton = polylines(frame, MOTION_PREVIEW_COLORS.robot, "solid");
      // MiKo-mini skeleton: base column, upper arm, forearm, tool — four
      // links drawn as one polyline through five pivots, thicker than the
      // trajectory's gradient stroke.
      expect(skeleton.length).toBe(1);
      expect((skeleton[0] as readonly (readonly [number, number])[]).length).toBe(5);
      const robotStroke = frame.primitives.find((p) => p.colorIndex === MOTION_PREVIEW_COLORS.robot)!;
      const gradientStroke = frame.primitives.find((p) => p.pointColors !== undefined)!;
      expect(robotStroke.width).toBeGreaterThan(gradientStroke.width);
      const tcpDots = frame.primitives.filter(
        (p) => p.kind === "dot" && p.colorIndex === MOTION_PREVIEW_COLORS.tcp,
      );
      expect(tcpDots.length).toBe(1);
      // The TCP dot sits on the skeleton's last pivot.
      const skeletonPts = skeleton[0] as readonly (readonly [number, number])[];
      expect(tcpDots[0]!.points[0]).toEqual(skeletonPts[skeletonPts.length - 1]);
    }
  });

  it("draws the actual TCP trace across PTP ranges only, from per-frame FK", () => {
    // A drawn Line (segment 0), then a PTP Move away from it (segment 1):
    // the TCP leaves the drawn line — the trace shows where it actually
    // went, computed by forward kinematics per frame.
    const ptpScene: Trajectory = trajectory(vec3(200, 0, 100), [
      line({ start: vec3(200, 0, 100), end: vec3(300, 0, 100), feed: 100 }),
      point({ target: vec3(350, 0, 100), feed: 100, motionType: "PTP" }),
    ]);
    // Two ranges: the short drawn Line, then the PTP hop.
    const ptpPlan = craftedPlan(
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
    const ptpRange2: PlanSegmentRange = { segmentIndex: 1, feed: 100, achievableFeed: 100, startMs: 40, endMs: 120 };
    const plan: MotionPlan = { ...ptpPlan, ranges: [ptpPlan.ranges[0] as PlanSegmentRange, ptpRange2] };
    const frames = renderMotionPreviewFrames({ trajectory: ptpScene, plan, model });

    // Frames before the PTP range carries no trace.
    expect(polylines(frames[0] as (typeof frames)[number], MOTION_PREVIEW_COLORS.ptpTrace, "solid").length).toBe(0);
    expect(polylines(frames[1] as (typeof frames)[number], MOTION_PREVIEW_COLORS.ptpTrace, "solid").length).toBe(0);

    // The trace grows with the PTP frames and spans the actual TCP
    // positions (FK per frame): its length equals the visited PTP frame
    // count, and the last trace point is the TCP dot's position.
    const trace = polylines(frames[5] as (typeof frames)[number], MOTION_PREVIEW_COLORS.ptpTrace, "solid");
    expect(trace.length).toBe(1);
    expect((trace[0] as readonly (readonly [number, number])[]).length).toBe(4);
    const tcp = frames[5]!.primitives.find((p) => p.kind === "dot" && p.colorIndex === MOTION_PREVIEW_COLORS.tcp);
    const tracePts = trace[0] as readonly (readonly [number, number])[];
    expect(tracePts[tracePts.length - 1]).toEqual(tcp!.points[0]);
    // The trace bends off the drawn line: the TCP travels the real
    // joint-space path, not the dashed hop.
    expect(tracePts[0]).not.toEqual(tracePts[tracePts.length - 1]);
  });

  it("carries no TCP trace when the Trajectory holds no PTP Move", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    for (const frame of frames) {
      expect(polylines(frame, MOTION_PREVIEW_COLORS.ptpTrace, "solid").length).toBe(0);
    }
  });

  it("is deterministic: two runs produce identical geometry", () => {
    const a = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const b = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(a).toEqual(b);
  });

  it("golden: pins frame 0's projected geometry for the frozen scene", () => {
    // The golden fixture of the preview (the ADR 0006 discipline applied
    // to geometry): the exact projected pixels of a known scene, derived
    // once from the isometric projection + equal-aspect fit and verified
    // by hand. Any change to the projection, the fit, the palette
    // indices, the panes/grid/gradient look, or the draw order breaks
    // this test loudly.
    //
    // Derivation for LINE_SCENE + LINE_PLAN at 800×600: the scene is
    // planar (every y is 0), with mm bounds [0,0,0]..[372.609,0,160]
    // (trajectory 200..300 @ z=100, robot chain q=[0,0,0] = (0,0,0),
    // (0,0,160), (159.8045,0,160), (319.609,0,160), (372.609,0,160),
    // home (200,0,100)). The fit projects the scene points plus the
    // bounds box's 8 corners: projected right ∈ [0, 322.6889]
    // ((x−y)·cos30), up ∈ [0, 346.3045] (z+(x+y)/2); the y-extent is
    // the limiting axis, so scale = 576/346.3045 = 1.6632778 px/mm,
    // centered at (161.3444, 173.1523): x = round(400 + (right−161.3444)
    // ·1.6632778), y = round(300 − (up−173.1523)·1.6632778). Grid steps:
    // x-extent 372.609 → raw 74.52 → step 50 mm; y degenerate → none;
    // z-extent 160 → raw 32 → step 20 mm — so the pane grid holds 7
    // vertical lines (x = 50..350 on the +Y wall) and 7 lines at
    // z = 20..140, while every line on the +X wall and the floor
    // degenerates with the zero y-extent and spans nothing.
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(frames.length).toBe(6);
    const [f0] = frames as [MotionPreviewFrame];
    expect(f0.tMs).toBe(0);
    expect(f0.primitives).toHaveLength(21);

    // The scene bounds' back panes, in draw order (+X wall, +Y wall,
    // floor). The zero y-extent degenerates the +X wall and the floor
    // into lines (they flood nothing); the +Y wall — the plane holding
    // the whole scene — fills as the backdrop.
    const paneX = f0.primitives[0] as PreviewPrimitive;
    expect(paneX).toEqual({
      kind: "fill",
      colorIndex: MOTION_PREVIEW_COLORS.paneX,
      width: 0,
      points: [[668, 278], [668, 278], [668, 12], [668, 12]],
    });
    const paneY = f0.primitives[1] as PreviewPrimitive;
    expect(paneY).toEqual({
      kind: "fill",
      colorIndex: MOTION_PREVIEW_COLORS.paneY,
      width: 0,
      points: [[132, 588], [668, 278], [668, 12], [132, 322]],
    });
    const paneZ = f0.primitives[2] as PreviewPrimitive;
    expect(paneZ).toEqual({
      kind: "fill",
      colorIndex: MOTION_PREVIEW_COLORS.paneZ,
      width: 0,
      points: [[132, 588], [668, 278], [668, 278], [132, 588]],
    });

    // The pane grid: seven vertical lines at x = 50..350 mm (the +Y
    // wall's X family), then seven lines at z = 20..140 mm (its Z
    // family), all grid gray, 1 px.
    const grid = f0.primitives.slice(3, 17) as PreviewPrimitive[];
    expect(grid).toHaveLength(14);
    expect(grid.map((p) => p.points)).toEqual([
      [[204, 546], [204, 280]],
      [[276, 505], [276, 239]],
      [[348, 463], [348, 197]],
      [[420, 422], [420, 156]],
      [[492, 380], [492, 114]],
      [[564, 339], [564, 72]],
      [[636, 297], [636, 31]],
      [[132, 555], [668, 245]],
      [[132, 521], [668, 212]],
      [[132, 488], [668, 178]],
      [[132, 455], [668, 145]],
      [[132, 422], [668, 112]],
      [[132, 388], [668, 79]],
      [[132, 355], [668, 45]],
    ]);
    for (const line of grid) {
      expect(line.kind).toBe("solid");
      expect(line.colorIndex).toBe(MOTION_PREVIEW_COLORS.grid);
      expect(line.width).toBe(1);
    }

    // The drawn line (201 samples at 0.5 mm) through the time ramp:
    // sample k stands at t = 0.6·k ms (the range's 120 ms spread over
    // the 100 mm arc), so its ramp index is timeToRampIndex(0.006·k):
    // head 0 → ramp[0], mid k=100 (t01 = 0.6) → ramp[23], tail clamped
    // → ramp[39]. 1 px, under everything that follows.
    const traj = f0.primitives[17] as PreviewPrimitive;
    expect(traj.kind).toBe("solid");
    expect(traj.width).toBe(1);
    expect(traj.colorIndex).toBe(MOTION_PREVIEW_TIME_RAMP[0]);
    expect(traj.points).toHaveLength(201);
    expect(traj.points[0]).toEqual([420, 255]);
    expect(traj.points[10]).toEqual([427, 251]);
    expect(traj.points[100]).toEqual([492, 214]);
    expect(traj.points[200]).toEqual([564, 172]);
    const colors = traj.pointColors as readonly number[];
    expect(colors).toHaveLength(201);
    expect(colors[0]).toBe(MOTION_PREVIEW_TIME_RAMP[0]);
    expect(colors[10]).toBe(MOTION_PREVIEW_TIME_RAMP[2]);
    expect(colors[100]).toBe(MOTION_PREVIEW_TIME_RAMP[23]);
    expect(colors[200]).toBe(MOTION_PREVIEW_TIME_RAMP[39]);

    // The robot skeleton at q = [0,0,0]: foot, shoulder, elbow, wrist,
    // TCP — dark, 3 px (thicker than the gradient's 1 px), over the
    // trajectory.
    const skeleton = f0.primitives[18] as PreviewPrimitive;
    expect(skeleton).toEqual({
      kind: "solid",
      colorIndex: MOTION_PREVIEW_COLORS.robot,
      width: 3,
      points: [[132, 588], [132, 322], [362, 189], [592, 56], [668, 12]],
    });

    // The TCP marker on the skeleton's last pivot, then the Home Point
    // (the trajectory's first sample's pixel).
    const tcp = f0.primitives[19] as PreviewPrimitive;
    expect(tcp).toEqual({ kind: "dot", colorIndex: MOTION_PREVIEW_COLORS.tcp, width: 2, points: [[668, 12]] });
    const home = f0.primitives[20] as PreviewPrimitive;
    expect(home).toEqual({ kind: "dot", colorIndex: MOTION_PREVIEW_COLORS.home, width: 3, points: [[420, 255]] });
  });

  it("golden: the last frame completes the travelled highlight", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const last = frames[frames.length - 1] as MotionPreviewFrame;
    const highlight = last.primitives.find((p) => p.colorIndex === MOTION_PREVIEW_COLORS.travelled);
    const gradient = frames[0]!.primitives.find((p) => p.pointColors !== undefined);
    expect(highlight).toEqual({
      kind: "solid",
      colorIndex: MOTION_PREVIEW_COLORS.travelled,
      width: 2,
      points: gradient?.points,
    });
  });

  it("keeps every pixel inside the frame", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    for (const frame of frames) {
      for (const p of frame.primitives) {
        for (const [x, y] of p.points) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThan(MOTION_PREVIEW_WIDTH);
          expect(y).toBeLessThan(MOTION_PREVIEW_HEIGHT);
        }
      }
    }
  });
});

describe("motion preview GIF", () => {
  it("starts the palette with the preview colors in contract order", () => {
    expect(MOTION_PREVIEW_PALETTE.length).toBe(256);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_COLORS.background]).toEqual([255, 255, 255]);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_COLORS.robot]).toEqual([51, 51, 51]);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_COLORS.trajectory]).toEqual([153, 153, 153]);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_COLORS.travelled]).toEqual([31, 119, 180]);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_COLORS.tcp]).toEqual([214, 39, 40]);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_COLORS.ptpTrace]).toEqual([255, 127, 14]);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_COLORS.home]).toEqual([44, 160, 44]);
    // The scene's back panes (one light gray per face) and the grid lines.
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_COLORS.paneX]).toEqual([242, 242, 242]);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_COLORS.paneY]).toEqual([229, 229, 229]);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_COLORS.paneZ]).toEqual([235, 235, 235]);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_COLORS.grid]).toEqual([204, 204, 204]);
  });

  it("carries a fixed viridis-like time ramp as palette indices", () => {
    // 40 entries, sitting right behind the contract colors: enough for a
    // smooth gradient after the anti-aliasing's nearest-match, well inside
    // the palette's 256-entry budget.
    expect(MOTION_PREVIEW_TIME_RAMP.length).toBe(40);
    for (const index of MOTION_PREVIEW_TIME_RAMP) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(MOTION_PREVIEW_PALETTE.length);
    }
    // Contiguous palette slice, deep purple → bright yellow.
    expect(MOTION_PREVIEW_TIME_RAMP[0]).toBe(MOTION_PREVIEW_COLORS.grid + 1);
    expect(MOTION_PREVIEW_TIME_RAMP[39]).toBe(MOTION_PREVIEW_TIME_RAMP[0]! + 39);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_TIME_RAMP[0] as number]).toEqual([68, 1, 84]);
    expect(MOTION_PREVIEW_PALETTE[MOTION_PREVIEW_TIME_RAMP[39] as number]).toEqual([253, 231, 37]);
  });

  it("maps normalized plan time onto the ramp head, tail, and midpoints", () => {
    const ramp = MOTION_PREVIEW_TIME_RAMP;
    expect(timeToRampIndex(0)).toBe(ramp[0]);
    expect(timeToRampIndex(1)).toBe(ramp[39]);
    // Clamped: past either end stays pinned.
    expect(timeToRampIndex(-0.5)).toBe(ramp[0]);
    expect(timeToRampIndex(1.5)).toBe(ramp[39]);
    // Halfway lands on the ramp's middle entry.
    expect(timeToRampIndex(0.5)).toBe(ramp[Math.round(0.5 * 39)]);
    // Monotone non-decreasing over the ramp.
    for (let i = 1; i <= 20; i++) {
      expect(timeToRampIndex(i / 20)).toBeGreaterThanOrEqual(timeToRampIndex((i - 1) / 20));
    }
  });

  it("encodes the frames as a decodable animated GIF paced over the duration", () => {
    const gif = renderMotionPreviewGif({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const decoded = decodeGifFrames(gif.bytes);
    expect(decoded.width).toBe(MOTION_PREVIEW_WIDTH);
    expect(decoded.height).toBe(MOTION_PREVIEW_HEIGHT);
    expect(decoded.frames.length).toBe(LINE_PLAN.rows.length);
    // Paced over the plan's real duration (100 ms): six frames at the
    // GIF's 1/100 s granularity (round(100 ms / 6) = 20 ms each), so
    // the playback spans 120 ms — within a frame of the real duration.
    expect(decoded.delays.length).toBe(LINE_PLAN.rows.length);
    expect(decoded.delays).toEqual(LINE_PLAN.rows.map(() => 0.02));
    const totalMs = decoded.delays.reduce((sum, d) => sum + d, 0) * 1000;
    expect(totalMs).toBeGreaterThanOrEqual(80);
    expect(totalMs).toBeLessThanOrEqual(130);
  });

  it("paints the panes, grid, gradient, and inks into the pixels at known coordinates", () => {
    // Pixel-sample pins on the decoded frame (the ADR 0018 golden
    // discipline, re-pinned for the richer look): exact colors where
    // coverage is provably full, hand-derived from the projection and
    // the rasterizer's pen alignment (polyline vertices and stroke/dot
    // centers cover their output pixel's S² sub-pixels completely).
    const gif = renderMotionPreviewGif({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const decoded = decodeGifFrames(gif.bytes);
    const pixels = decoded.frames[0] as number[];
    const at = (x: number, y: number): number => pixels[y * MOTION_PREVIEW_WIDTH + x] as number;
    // A corner far outside the box hexagon is the background.
    expect(at(3, 3)).toBe(MOTION_PREVIEW_COLORS.background);
    // Pane interior, clear of grid lines and geometry: the +Y wall gray.
    expect(at(400, 320)).toBe(MOTION_PREVIEW_COLORS.paneY);
    // On a grid line's column (x = 420 mm, below the trajectory): exact grid gray.
    expect(at(420, 400)).toBe(MOTION_PREVIEW_COLORS.grid);
    // Gradient samples (golden trajectory points, schedule t = 0.6·k ms):
    // the rasterizer's pen alignment covers each sample pixel fully, so
    // the decoded index is the sample's exact ramp entry.
    expect(at(427, 251)).toBe(timeToRampIndex(6 / 100)); // k = 10
    expect(at(492, 214)).toBe(timeToRampIndex(60 / 100)); // k = 100
    expect(at(564, 172)).toBe(timeToRampIndex(120 / 100)); // k = 200, clamped tail
    // The Home Point marker (dot radius 3) colors its center.
    expect(at(420, 255)).toBe(MOTION_PREVIEW_COLORS.home);
    // The 3 px robot skeleton covers its pivot pixels fully.
    expect(at(132, 588)).toBe(MOTION_PREVIEW_COLORS.robot);
    expect(at(592, 56)).toBe(MOTION_PREVIEW_COLORS.robot);
    // The TCP marker on the skeleton's last pivot draws over it.
    expect(at(668, 12)).toBe(MOTION_PREVIEW_COLORS.tcp);
  });

  it("highlights the travelled part over the gradient in the pixels", () => {
    // On the last frame the whole line is travelled: the 2 px highlight
    // draws over the gradient, so its sample pixels decode to the
    // travelled ink, while the grid beneath stays untouched.
    const gif = renderMotionPreviewGif({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const decoded = decodeGifFrames(gif.bytes);
    const pixels = decoded.frames[decoded.frames.length - 1] as number[];
    const at = (x: number, y: number): number => pixels[y * MOTION_PREVIEW_WIDTH + x] as number;
    expect(at(427, 251)).toBe(MOTION_PREVIEW_COLORS.travelled);
    expect(at(492, 214)).toBe(MOTION_PREVIEW_COLORS.travelled);
    expect(at(564, 172)).toBe(MOTION_PREVIEW_COLORS.travelled);
    expect(at(420, 400)).toBe(MOTION_PREVIEW_COLORS.grid);
  });

  it("keeps PTP hops dashed in the pixels: gaps between the dashes", () => {
    // The dashed semantics survive the anti-aliasing: along the PTP
    // hop's projected chord some pixels carry the ramp color and some
    // show the pane between dashes (4 on, 3 off by arc length).
    const ptpScene: Trajectory = trajectory(vec3(200, 0, 100), [
      point({ target: vec3(300, 0, 100), feed: 100, motionType: "PTP" }),
    ]);
    const gif = renderMotionPreviewGif({ trajectory: ptpScene, plan: LINE_PLAN, model });
    const decoded = decodeGifFrames(gif.bytes);
    const pixels = decoded.frames[0] as number[];
    const frames = renderMotionPreviewFrames({ trajectory: ptpScene, plan: LINE_PLAN, model });
    const dashed = frames[0]!.primitives.find((p) => p.pointColors !== undefined)!
      .points as readonly (readonly [number, number])[];
    const rampIndices = new Set(MOTION_PREVIEW_TIME_RAMP);
    let on = 0;
    let off = 0;
    for (const [x, y] of dashed) {
      const index = pixels[y * MOTION_PREVIEW_WIDTH + x] as number;
      if (rampIndices.has(index)) on++;
      else off++;
    }
    expect(on).toBeGreaterThan(0);
    expect(off).toBeGreaterThan(0);
  });

  it("is deterministic: identical input yields byte-identical GIF bytes", () => {
    const a = renderMotionPreviewGif({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const b = renderMotionPreviewGif({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(a.bytes).toEqual(b.bytes);
    expect(a.frameCount).toBe(b.frameCount);
  });

  it("renders a long plan: the GIF holds exactly the frame budget's 300 frames", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i * CONTROL_STEP_MS, [0, 0, 0]));
    const longPlan = craftedPlan(rows, { segmentIndex: 0, feed: 100, achievableFeed: 100, startMs: 0, endMs: 20_000 }, 19_980);
    const gif = renderMotionPreviewGif({ trajectory: LINE_SCENE, plan: longPlan, model });
    expect(gif.frameCount).toBe(300);
    const decoded = decodeGifFrames(gif.bytes);
    expect(decoded.frames.length).toBe(300);
  });

  it("rasterizes the frames the dialog consumes exactly as the GIF encodes them", () => {
    // The playback dialog draws `rasterizePreviewFrame`'s pixels (the
    // shared renderer's raster step); the GIF encodes the same frames
    // through the same step — decoding the GIF back must yield the
    // identical palette-index pixels, frame for frame.
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const gif = renderMotionPreviewGif({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const decoded = decodeGifFrames(gif.bytes);
    expect(decoded.frames.length).toBe(frames.length);
    frames.forEach((frame, i) => {
      expect(Array.from(rasterizePreviewFrame(frame))).toEqual(decoded.frames[i]);
    });
  });
});
