/**
 * Motion Preview (the GIF exporter): isometric frames of the Motion
 * Plan as an animated GIF, rendered headless — no canvas, no DOM, no
 * three.js — by deterministic pure functions, exactly like the charts
 * (ADR 0013) and the headless pipeline (ADR 0012).
 *
 * One frame shows the robot's skeleton (base column, two links, tool,
 * from {@link RobotModel.chainPoints}) at the sampled plan moment, the
 * full Trajectory behind it (drawn geometry solid, PTP Moves dashed),
 * the travelled part highlighted over it, the Home Point, and — under
 * PTP — the actual TCP trace, computed by per-frame forward kinematics
 * (a PTP Move guarantees only arrival, so the real path is the FK
 * path, ADR 0016).
 *
 * The seam splits in two pure steps, so golden tests can pin the
 * projected frame geometry headlessly (the same discipline as the CSV
 * exporters' byte fixtures, ADR 0006):
 *
 * 1. `renderMotionPreviewFrames` — Motion Plan + Trajectory + Robot
 *    Model in, projected pixel-space frame geometry out.
 * 2. `renderMotionPreviewGif` — the same frames rasterized onto a
 *    fixed palette and encoded as a GIF 89a by the pure-JS encoder in
 *    `gif.ts`.
 *
 * Frames sample at most `MOTION_PREVIEW_MAX_FRAMES` plan rows, evenly
 * paced over the plan's real duration.
 */

import { discretizeTrajectory, type DiscretizedPath } from "../core/discretize";
import type { Segment, Trajectory } from "../core/trajectory";
import type { Vec3 as CoreVec3 } from "../core/vec";
import type { RobotModel, Vec3 } from "../kinematics/robot-model";
import type { MotionPlan, MotionRow } from "../motion/planner";
import { projectIsometric } from "./charts";
import { encodeGif, type GifColor, type GifFrame } from "./gif";

/** Converts a core point (object shape) to the kinematics tuple shape. */
function asTuple(p: CoreVec3): Vec3 {
  return [p.x, p.y, p.z];
}

/** Frame budget: at most this many frames, evenly paced (the ~300 cap). */
export const MOTION_PREVIEW_MAX_FRAMES = 300;

/** Frame size, in pixels. */
export const MOTION_PREVIEW_WIDTH = 480;
export const MOTION_PREVIEW_HEIGHT = 360;

/** Blank margin kept between the scene's bounding box and the frame edge. */
const MARGIN_PX = 12;

/**
 * The preview's palette indices: the fixed colors the frames draw
 * with (the encoder's global GIF color table starts with these
 * entries, so pixel indices are stable contract values).
 */
export const MOTION_PREVIEW_COLORS = {
  /** Background white. */
  background: 0,
  /** The robot skeleton. */
  robot: 1,
  /** The full Trajectory: drawn geometry solid, PTP Moves dashed. */
  trajectory: 2,
  /** The travelled part, highlighted over the trajectory. */
  travelled: 3,
  /** The TCP (pen) marker at the sampled plan moment. */
  tcp: 4,
  /** The actual TCP trace under PTP (per-frame forward kinematics). */
  ptpTrace: 5,
  /** The Home Point marker. */
  home: 6,
} as const;

/** One projected primitive of a frame, in frame pixel coordinates. */
export interface PreviewPrimitive {
  /** `solid`/`dashed` polylines stroke through `points`; a `dot` fills a disc of radius `width` at `points[0]`. */
  readonly kind: "solid" | "dashed" | "dot";
  /** Pixel coordinates (rounded integers, screen y growing down). */
  readonly points: readonly (readonly [number, number])[];
  /** A {@link MOTION_PREVIEW_COLORS} palette index. */
  readonly colorIndex: number;
  /** Stroke width in pixels; for a `dot`, the disc radius. */
  readonly width: number;
}

/** One preview frame: the projected geometry at one sampled plan moment. */
export interface MotionPreviewFrame {
  /** The sampled plan time, in milliseconds. */
  readonly tMs: number;
  /** Projected primitives in draw order (the background is implicit). */
  readonly primitives: readonly PreviewPrimitive[];
}

/** Motion Preview input: the Trajectory, its Motion Plan, and the Robot Model. */
export interface MotionPreviewInput {
  /** The Trajectory the plan was generated from. */
  readonly trajectory: Trajectory;
  /** The validated Motion Plan (the pipeline's output). */
  readonly plan: MotionPlan;
  /** The Robot Model solving the chain skeleton per frame. */
  readonly model: RobotModel;
}

/** Slack on completion comparisons, absorbing float dust on range ends. */
const TIME_SLACK_MS = 1e-9;

/**
 * The preview's RGB colors, in {@link MOTION_PREVIEW_COLORS} order —
 * the head of the encoder's global GIF color table, so pixel indices
 * and palette entries stay aligned (the golden discipline of ADR 0006
 * applied to the preview's look).
 */
const PREVIEW_COLORS: readonly GifColor[] = [
  [255, 255, 255], // background
  [51, 51, 51], // robot
  [153, 153, 153], // trajectory
  [31, 119, 180], // travelled
  [214, 39, 40], // tcp
  [255, 127, 14], // ptpTrace
  [44, 160, 44], // home
];

/**
 * The full 256-entry global GIF color table: the preview colors first,
 * padded with a web-safe 6×6×6 cube and a grayscale ramp so nearest-
 * matching (unused by the exact-index rasterizer) would still behave
 * sensibly. Deterministic; fixed for the format's 256-color maximum.
 */
export const MOTION_PREVIEW_PALETTE: readonly GifColor[] = (() => {
  const palette: GifColor[] = [...PREVIEW_COLORS];
  for (const r of [0, 51, 102, 153, 204, 255]) {
    for (const g of [0, 51, 102, 153, 204, 255]) {
      for (const b of [0, 51, 102, 153, 204, 255]) {
        if (palette.length < 256) palette.push([r, g, b]);
      }
    }
  }
  for (let v = 5; v < 256 && palette.length < 256; v += 5) {
    palette.push([v, v, v]);
  }
  return palette;
})();

/** One rendered Motion Preview GIF: the bytes and their frame count. */
export interface MotionPreviewGif {
  /** The GIF 89a bytes (write as `robot_motion.gif`). */
  readonly bytes: Uint8Array;
  /** The number of frames the animation holds. */
  readonly frameCount: number;
}

/** Minimum frame delay, in hundredths of a second (GIF's unit). */
const MIN_DELAY_CS = 2;

/**
 * Renders the Motion Preview as an animated GIF: the projected frames
 * rasterized onto the fixed palette and encoded by the pure-JS GIF
 * encoder. Frames are paced over the plan's real duration — one even
 * delay per frame, at the GIF's 1/100 s granularity, floored at 20 ms
 * (below that, players clamp anyway). Pure function; identical input
 * yields byte-identical output.
 */
export function renderMotionPreviewGif(input: MotionPreviewInput): MotionPreviewGif {
  const frames = renderMotionPreviewFrames(input);
  const frameCount = frames.length;
  const delayCs = Math.max(
    MIN_DELAY_CS,
    Math.round(input.plan.durationMs / Math.max(1, frameCount) / 10),
  );
  const gifFrames: GifFrame[] = frames.map((frame) => ({
    delayCs,
    indexed: rasterizeFrame(frame),
  }));
  return {
    bytes: encodeGif({
      width: MOTION_PREVIEW_WIDTH,
      height: MOTION_PREVIEW_HEIGHT,
      palette: MOTION_PREVIEW_PALETTE,
      frames: gifFrames,
    }),
    frameCount,
  };
}

/**
 * Rasterizes one frame's primitives onto the palette: background
 * first, then primitives in draw order (later draws over earlier).
 * Pure integer pixel math — no anti-aliasing, no floats in the pixel
 * buffer — so the bytes are exactly reproducible.
 */
function rasterizeFrame(frame: MotionPreviewFrame): Uint8Array {
  const pixels = new Uint8Array(MOTION_PREVIEW_WIDTH * MOTION_PREVIEW_HEIGHT);
  pixels.fill(MOTION_PREVIEW_COLORS.background);
  for (const primitive of frame.primitives) {
    if (primitive.kind === "dot") {
      fillDisc(pixels, primitive.points[0] as readonly [number, number], primitive.width, primitive.colorIndex);
      continue;
    }
    strokePolyline(pixels, primitive.points, primitive.width, primitive.colorIndex, primitive.kind === "dashed");
  }
  return pixels;
}

/** Paints a pixel, clipped to the canvas. */
function plot(pixels: Uint8Array, x: number, y: number, colorIndex: number): void {
  if (x < 0 || y < 0 || x >= MOTION_PREVIEW_WIDTH || y >= MOTION_PREVIEW_HEIGHT) return;
  pixels[y * MOTION_PREVIEW_WIDTH + x] = colorIndex;
}

/** Paints a `width` × `width` block (the thick stroke's pen). */
function plotBlock(pixels: Uint8Array, x: number, y: number, width: number, colorIndex: number): void {
  const half = Math.floor(width / 2);
  for (let dy = 0; dy < width; dy++) {
    for (let dx = 0; dx < width; dx++) {
      plot(pixels, x + dx - half, y + dy - half, colorIndex);
    }
  }
}

/**
 * Strokes a polyline in Bresenham steps; `dashed` breaks the stroke
 * into an on/off pixel-step pattern (4 on, 3 off) counted along the
 * whole polyline, so dashes straddle joints naturally.
 */
function strokePolyline(
  pixels: Uint8Array,
  points: readonly (readonly [number, number])[],
  width: number,
  colorIndex: number,
  dashed: boolean,
): void {
  let step = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1] as readonly [number, number];
    const [x1, y1] = points[i] as readonly [number, number];
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    for (;;) {
      if (!dashed || step % 7 < 4) plotBlock(pixels, x, y, width, colorIndex);
      step++;
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }
}

/** Fills a disc of radius `radius` centered at `center`, clipped. */
function fillDisc(
  pixels: Uint8Array,
  center: readonly [number, number],
  radius: number,
  colorIndex: number,
): void {
  const [cx, cy] = center;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        plot(pixels, cx + dx, cy + dy, colorIndex);
      }
    }
  }
}

/**
 * Renders every preview frame's projected geometry: the full
 * Trajectory, the travelled highlight, the PTP TCP trace, the Home
 * Point, and the robot skeleton with its TCP marker — all projected
 * isometrically (the path-3d chart's convention, ADR 0013) with one
 * uniform mm→px scale fit to the whole scene (equal aspect, ADR
 * 0007's anti-distortion discipline: equal millimetres draw as equal
 * pixels). Pure function; identical inputs yield identical frames.
 */
export function renderMotionPreviewFrames(input: MotionPreviewInput): readonly MotionPreviewFrame[] {
  const sampledRows = samplePlanRows(input.plan);
  if (sampledRows.length === 0) return [];

  const path = discretizeTrajectory(input.trajectory);
  const segmentPixels = segmentPolylines(path);
  const ptpSegments = ptpSegmentIndices(input.trajectory.segments);

  // The robot skeleton per sampled frame, in model-frame millimetres.
  const chains = sampledRows.map((row) => input.model.chainPoints(row.q));

  // The actual TCP trace under PTP: runs of consecutive sampled frames
  // whose plan row traverses a PTP Move; the TCP positions come from
  // per-frame forward kinematics (the last chain point).
  const traceRuns = collectTraceRuns(sampledRows, ptpSegments);

  // The scene every frame must hold: trajectory, home, and the whole
  // robot sweep. One fit for all frames — the view never jitters.
  const scenePoints: Vec3[] = [asTuple(input.trajectory.home)];
  for (const polyline of segmentPixels.values()) scenePoints.push(...polyline.mm);
  for (const chain of chains) scenePoints.push(...chain);
  const toPx = fitProjection(scenePoints);
  const tcpPixels = chains.map((chain) => toPx(chain[chain.length - 1] as Vec3));

  const trajectoryPrimitives = trajectoryPrimitivesOf(segmentPixels, ptpSegments, toPx);

  return sampledRows.map((row, frameIndex) => {
    const primitives = [...trajectoryPrimitives];
    appendTravelled(primitives, input.plan, row.tMs, segmentPixels, ptpSegments);
    appendTrace(primitives, traceRuns, frameIndex, tcpPixels);
    const chainPx = (chains[frameIndex] as Vec3[]).map(toPx);
    primitives.push({ kind: "solid", points: chainPx, colorIndex: MOTION_PREVIEW_COLORS.robot, width: 2 });
    primitives.push({
      kind: "dot",
      points: [chainPx[chainPx.length - 1] as [number, number]],
      colorIndex: MOTION_PREVIEW_COLORS.tcp,
      width: 2,
    });
    primitives.push({
      kind: "dot",
      points: [toPx(asTuple(input.trajectory.home))],
      colorIndex: MOTION_PREVIEW_COLORS.home,
      width: 3,
    });
    return { tMs: row.tMs, primitives };
  });
}

/** Samples the plan rows: one frame per row, capped at the frame budget. */
function samplePlanRows(plan: MotionPlan): readonly MotionRow[] {
  const n = plan.rows.length;
  if (n <= MOTION_PREVIEW_MAX_FRAMES) return plan.rows;
  const last = n - 1;
  return Array.from(
    { length: MOTION_PREVIEW_MAX_FRAMES },
    (_, i) => plan.rows[Math.round((i * last) / (MOTION_PREVIEW_MAX_FRAMES - 1))] as MotionRow,
  );
}

/** The segment indices carrying a PTP Move (dashed; arrival only). */
function ptpSegmentIndices(segments: readonly Segment[]): ReadonlySet<number> {
  const set = new Set<number>();
  segments.forEach((segment, index) => {
    if (segment.kind === "point" && segment.motionType === "PTP") set.add(index);
  });
  return set;
}

/** Per-segment 3D polylines (filled with pixels once the fit exists). */
interface SegmentPolyline {
  /** The segment's sampled 3D positions, in traversal order, as tuples. */
  readonly mm: readonly Vec3[];
  /** The projected pixel points, filled by the caller's fit. */
  px: readonly (readonly [number, number])[];
}

/**
 * Groups the discretized path's samples into per-Segment polylines.
 * Samples of one Segment form one consecutive run; a merged-away
 * Segment contributes no samples and no polyline.
 */
function segmentPolylines(path: DiscretizedPath): ReadonlyMap<number, SegmentPolyline> {
  const polylines = new Map<number, SegmentPolyline>();
  let currentIndex = -1;
  let current: Vec3[] | undefined;
  for (const sample of path.samples) {
    if (sample.segmentIndex !== currentIndex || current === undefined) {
      currentIndex = sample.segmentIndex;
      current = [];
      polylines.set(currentIndex, { mm: current, px: [] });
    }
    current.push(asTuple(sample.position));
  }
  return polylines;
}

/**
 * Runs of consecutive sampled frames traversing one PTP Move, as frame
 * index arrays. The TCP hop between two poses is real motion the plan
 * does not draw — the trace shows where the tool actually went.
 */
function collectTraceRuns(rows: readonly MotionRow[], ptp: ReadonlySet<number>): readonly (readonly number[])[] {
  const runs: number[][] = [];
  let current: number[] | undefined;
  let currentSegment = -1;
  rows.forEach((row, index) => {
    if (ptp.has(row.segmentIndex)) {
      if (current !== undefined && currentSegment === row.segmentIndex) {
        current.push(index);
        return;
      }
      current = [index];
      currentSegment = row.segmentIndex;
      runs.push(current);
      return;
    }
    current = undefined;
    currentSegment = -1;
  });
  return runs;
}

/**
 * The full Trajectory: drawn geometry and LIN Moves solid, PTP Moves
 * dashed (only arrival is guaranteed, ADR 0017) — the same Motion
 * Type convention the canvas draws by.
 */
function trajectoryPrimitivesOf(
  segmentPixels: ReadonlyMap<number, SegmentPolyline>,
  ptp: ReadonlySet<number>,
  toPx: (p: Vec3) => [number, number],
): readonly PreviewPrimitive[] {
  const primitives: PreviewPrimitive[] = [];
  for (const [segmentIndex, polyline] of segmentPixels) {
    polyline.px = polyline.mm.map(toPx);
    primitives.push({
      kind: ptp.has(segmentIndex) ? "dashed" : "solid",
      points: polyline.px,
      colorIndex: MOTION_PREVIEW_COLORS.trajectory,
      width: 1,
    });
  }
  return primitives;
}

/**
 * Appends the travelled-part highlight: for every plan range, the
 * drawn polyline up to the pen's progress at `tMs` (the range's time
 * fraction; the S-curve profile paces it). A PTP Move contributes no
 * highlight — only arrival is guaranteed, and the travelled reality is
 * the TCP trace. Completion is judged against `min(endMs,
 * durationMs)`: the grid-rounded `durationMs` can sit one control step
 * short of the last range's unrounded end, and the final frame must
 * still show the journey complete.
 */
function appendTravelled(
  primitives: PreviewPrimitive[],
  plan: MotionPlan,
  tMs: number,
  segmentPixels: ReadonlyMap<number, SegmentPolyline>,
  ptp: ReadonlySet<number>,
): void {
  for (const range of plan.ranges) {
    if (ptp.has(range.segmentIndex)) continue;
    const polyline = segmentPixels.get(range.segmentIndex);
    if (polyline === undefined || polyline.px.length === 0) continue;
    const completeAt = Math.min(range.endMs, plan.durationMs);
    let count: number;
    if (tMs >= completeAt - TIME_SLACK_MS) {
      count = polyline.px.length;
    } else if (tMs > range.startMs) {
      const fraction = (tMs - range.startMs) / (range.endMs - range.startMs);
      count = 1 + Math.floor(fraction * (polyline.px.length - 1));
    } else {
      continue;
    }
    if (count < 2) continue;
    primitives.push({
      kind: "solid",
      points: polyline.px.slice(0, count),
      colorIndex: MOTION_PREVIEW_COLORS.travelled,
      width: 2,
    });
  }
}

/** Appends the PTP TCP trace: every trace run up to `frameIndex`. */
function appendTrace(
  primitives: PreviewPrimitive[],
  runs: readonly (readonly number[])[],
  frameIndex: number,
  tcpPixels: readonly (readonly [number, number])[],
): void {
  // The trace is the actual TCP path: the projected per-frame forward
  // kinematics positions of the visited frames, one polyline per run.
  for (const run of runs) {
    const upto = run.filter((index) => index <= frameIndex);
    if (upto.length < 2) continue;
    primitives.push({
      kind: "solid",
      points: upto.map((index) => tcpPixels[index] as [number, number]),
      colorIndex: MOTION_PREVIEW_COLORS.ptpTrace,
      width: 1,
    });
  }
}

/**
 * Fits the scene's projected extents into the frame: one uniform
 * mm→px scale (equal aspect — the limiting axis fills the inner
 * rectangle, the other is centered), screen y flipped to grow down,
 * degenerate extents padded so every pixel stays finite. The same
 * discipline as the charts' equal-aspect path views (ADR 0013) and the
 * canvas transform (ADR 0007).
 */
function fitProjection(points: readonly Vec3[]): (p: Vec3) => [number, number] {
  const projected = points.map(projectIsometric);
  const xs = projected.map(([x]) => x);
  const ys = projected.map(([, y]) => y);
  const [xLo, xHi] = paddedExtent([Math.min(...xs), Math.max(...xs)]);
  const [yLo, yHi] = paddedExtent([Math.min(...ys), Math.max(...ys)]);
  const scale = Math.min(
    (MOTION_PREVIEW_WIDTH - 2 * MARGIN_PX) / (xHi - xLo),
    (MOTION_PREVIEW_HEIGHT - 2 * MARGIN_PX) / (yHi - yLo),
  );
  const centerX = (xLo + xHi) / 2;
  const centerY = (yLo + yHi) / 2;
  return (p: Vec3): [number, number] => {
    const [right, up] = projectIsometric(p);
    return [
      Math.round((right - centerX) * scale + MOTION_PREVIEW_WIDTH / 2),
      Math.round(MOTION_PREVIEW_HEIGHT / 2 - (up - centerY) * scale),
    ];
  };
}

/** Pads a degenerate or noise-scale extent the way the charts' `domain()` does. */
function paddedExtent([lo, hi]: readonly [number, number]): readonly [number, number] {
  const magnitude = Math.max(Math.abs(lo), Math.abs(hi));
  if (hi - lo > 1e-9 * magnitude) return [lo, hi];
  const pad = Math.max(magnitude * 0.05, 1);
  return [lo - pad, lo + pad];
}
