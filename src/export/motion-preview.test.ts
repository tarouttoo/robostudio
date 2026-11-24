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
  MOTION_PREVIEW_WIDTH,
  renderMotionPreviewFrames,
  renderMotionPreviewGif,
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
  { segmentIndex: 0, feed: 100, startMs: 0, endMs: 120 },
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
  it("renders one frame per plan row when the plan fits the frame budget", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(frames.length).toBe(LINE_PLAN.rows.length);
    expect(frames.map((f) => f.tMs)).toEqual(LINE_PLAN.rows.map((r) => r.tMs));
  });

  it("samples at most 300 frames, evenly paced over the plan duration", () => {
    // 1000 rows = 20 s of motion: far past the frame budget.
    const rows = Array.from({ length: 1000 }, (_, i) => row(i * CONTROL_STEP_MS, [0, 0, 0]));
    const longPlan = craftedPlan(rows, { segmentIndex: 0, feed: 100, startMs: 0, endMs: 20_000 }, 19_980);
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: longPlan, model });
    expect(frames.length).toBe(300);
    expect(frames[0]?.tMs).toBe(0);
    expect(frames[299]?.tMs).toBe(19_980);
    // Even time spacing: consecutive sampled times differ by ~1/299 of
    // the duration, on the row grid (67 ± rounding).
    const gaps = frames.slice(1).map((f, i) => f.tMs - (frames[i] as (typeof frames)[number]).tMs);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(CONTROL_STEP_MS);
  });

  it("draws the full drawn trajectory solid, pinned in isometric pixel space", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const traj = polylines(frames[0] as (typeof frames)[number], MOTION_PREVIEW_COLORS.trajectory, "solid");
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
    const dashed = polylines(frames[0] as (typeof frames)[number], MOTION_PREVIEW_COLORS.trajectory, "dashed");
    const solid = polylines(frames[0] as (typeof frames)[number], MOTION_PREVIEW_COLORS.trajectory, "solid");
    expect(dashed.length).toBe(1);
    expect(solid.length).toBe(0);
  });

  it("highlights the travelled part progressively, complete by the last frame", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const first = polylines(frames[0] as (typeof frames)[number], MOTION_PREVIEW_COLORS.travelled, "solid");
    const last = polylines(frames[frames.length - 1] as (typeof frames)[number], MOTION_PREVIEW_COLORS.travelled, "solid");
    // Early: almost nothing travelled (a polyline too short to span).
    expect(first.length).toBe(0);
    // Last frame: the whole drawn geometry is highlighted.
    expect(last.length).toBe(1);
    const traj = polylines(frames[0] as (typeof frames)[number], MOTION_PREVIEW_COLORS.trajectory, "solid")[0] as readonly (readonly [number, number])[];
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
      { segmentIndex: 0, feed: 100, startMs: 0, endMs: 120 },
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
      const traj = polylines(frame, MOTION_PREVIEW_COLORS.trajectory, "solid")[0] as readonly (readonly [number, number])[];
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
      // links drawn as one polyline through five pivots.
      expect(skeleton.length).toBe(1);
      expect((skeleton[0] as readonly (readonly [number, number])[]).length).toBe(5);
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
      { segmentIndex: 0, feed: 100, startMs: 0, endMs: 40 },
      100,
    );
    const ptpRange2: PlanSegmentRange = { segmentIndex: 1, feed: 100, startMs: 40, endMs: 120 };
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
    // indices, or the draw order breaks this test loudly.
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(frames.length).toBe(6);
    const [f0] = frames as [MotionPreviewFrame];
    expect(f0.tMs).toBe(0);
    expect(f0.primitives).toHaveLength(4);

    // The drawn line (201 samples at 0.5 mm), gray, 1 px.
    const traj = f0.primitives[0] as PreviewPrimitive;
    expect(traj.kind).toBe("solid");
    expect(traj.colorIndex).toBe(MOTION_PREVIEW_COLORS.trajectory);
    expect(traj.width).toBe(1);
    expect(traj.points).toHaveLength(201);
    expect(traj.points[0]).toEqual([252, 154]);
    expect(traj.points[100]).toEqual([294, 130]);
    expect(traj.points[200]).toEqual([336, 105]);

    // The robot skeleton at q = [0,0,0]: foot, shoulder, elbow, wrist,
    // TCP — dark, 2 px, over the trajectory.
    const skeleton = f0.primitives[1] as PreviewPrimitive;
    expect(skeleton.kind).toBe("solid");
    expect(skeleton.colorIndex).toBe(MOTION_PREVIEW_COLORS.robot);
    expect(skeleton.width).toBe(2);
    expect(skeleton.points).toEqual([
      [83, 348],
      [83, 193],
      [218, 115],
      [352, 38],
      [397, 12],
    ]);

    // The TCP marker on the skeleton's last pivot, then the Home Point.
    const tcp = f0.primitives[2] as PreviewPrimitive;
    expect(tcp).toEqual({ kind: "dot", colorIndex: MOTION_PREVIEW_COLORS.tcp, width: 2, points: [[397, 12]] });
    const home = f0.primitives[3] as PreviewPrimitive;
    expect(home).toEqual({ kind: "dot", colorIndex: MOTION_PREVIEW_COLORS.home, width: 3, points: [[252, 154]] });
  });

  it("golden: the last frame completes the travelled highlight", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const last = frames[frames.length - 1] as MotionPreviewFrame;
    const highlight = last.primitives.find((p) => p.colorIndex === MOTION_PREVIEW_COLORS.travelled);
    expect(highlight).toEqual({
      kind: "solid",
      colorIndex: MOTION_PREVIEW_COLORS.travelled,
      width: 2,
      points: (frames[0] as MotionPreviewFrame).primitives[0]?.points,
    });
  });

  it("keeps every pixel inside the frame", () => {
    const frames = renderMotionPreviewFrames({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    for (const frame of frames) {
      for (const p of frame.primitives) {
        for (const [x, y] of p.points) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThan(480);
          expect(y).toBeLessThan(360);
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

  it("paints the background, the drawn line, and the Home Point into the pixels", () => {
    const gif = renderMotionPreviewGif({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const decoded = decodeGifFrames(gif.bytes);
    const pixels = decoded.frames[0] as number[];
    const at = (x: number, y: number): number => pixels[y * MOTION_PREVIEW_WIDTH + x] as number;
    // A corner far from any geometry is the background.
    expect(at(3, 3)).toBe(MOTION_PREVIEW_COLORS.background);
    // The Home Point marker (dot radius 3) colors its center.
    expect(at(252, 154)).toBe(MOTION_PREVIEW_COLORS.home);
    // The trajectory's far end pixel (golden [336, 105]) is gray.
    expect(at(336, 105)).toBe(MOTION_PREVIEW_COLORS.trajectory);
    // The robot's base foot pivot (golden [83, 348]) is robot-colored.
    expect(at(83, 348)).toBe(MOTION_PREVIEW_COLORS.robot);
  });

  it("is deterministic: identical input yields byte-identical GIF bytes", () => {
    const a = renderMotionPreviewGif({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    const b = renderMotionPreviewGif({ trajectory: LINE_SCENE, plan: LINE_PLAN, model });
    expect(a.bytes).toEqual(b.bytes);
    expect(a.frameCount).toBe(b.frameCount);
  });

  it("renders a long plan: the GIF holds exactly the frame budget's 300 frames", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i * CONTROL_STEP_MS, [0, 0, 0]));
    const longPlan = craftedPlan(rows, { segmentIndex: 0, feed: 100, startMs: 0, endMs: 20_000 }, 19_980);
    const gif = renderMotionPreviewGif({ trajectory: LINE_SCENE, plan: longPlan, model });
    expect(gif.frameCount).toBe(300);
    const decoded = decodeGifFrames(gif.bytes);
    expect(decoded.frames.length).toBe(300);
  });
});
