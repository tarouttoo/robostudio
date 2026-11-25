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
 * The seam splits in pure steps around the Preview Scene — the
 * millimetre-space scene document `buildPreviewScene` assembles from
 * the Trajectory + Motion Plan + Robot Model (see `preview-scene.ts`;
 * its millimetre geometry is pinned by its own golden tests) — so
 * golden tests can pin each step headlessly (the same discipline as
 * the CSV exporters' byte fixtures, ADR 0006):
 *
 * 1. `buildPreviewScene` — Trajectory + Motion Plan + Robot Model in,
 *    the headless mm-space scene document out (per-Segment polylines
 *    with per-sample schedule times, the ≤ 300 sampled moments with
 *    their chain skeletons, the travelled extents, the PTP TCP trace
 *    runs, the Home Point, and the scene bounds).
 * 2. `renderMotionPreviewFrames` — the Preview Scene projected into
 *    pixel-space frame geometry (a scene built fresh from the input,
 *    or a prebuilt one passed in, yields the same frames).
 * 3. `renderMotionPreviewGif` — the same frames rasterized onto a
 *    fixed palette and encoded as a GIF 89a by the pure-JS encoder in
 *    `gif.ts`.
 *
 * Frames sample at most `MOTION_PREVIEW_MAX_FRAMES` plan rows, evenly
 * paced over the plan's real duration (the moment pacing lives in the
 * scene assembly).
 */

import type { Trajectory } from "../core/trajectory";
import type { RobotModel, Vec3 } from "../kinematics/robot-model";
import type { MotionPlan, PlanSegmentRange } from "../motion/planner";
import { domain, projectIsometric } from "./charts";
import { encodeGif, type GifColor, type GifFrame } from "./gif";
import { buildPreviewScene, type PreviewScene } from "./preview-scene";

export { MOTION_PREVIEW_MAX_FRAMES } from "./preview-scene";

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
  /**
   * Optional prebuilt Preview Scene: when given, the frames project
   * this document instead of building one from `trajectory`/`plan`/
   * `model` — the build-once-per-Generation path. Both paths project
   * the same scene: a fresh build is exactly what the omitted field
   * would have assembled.
   */
  readonly scene?: PreviewScene;
}

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
    indexed: rasterizePreviewFrame(frame),
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
 * buffer — so the bytes are exactly reproducible. This is the GIF
 * renderer's internal raster step: the encoder encodes these pixels,
 * and the renderer's tests pin them by decoding the GIF back. (The
 * playback dialog once painted these same palette indices — the
 * exact-pixels contract; it now renders the Preview Scene through its
 * own Orbit Camera instead, so the raster stays internal.)
 */
export function rasterizePreviewFrame(frame: MotionPreviewFrame): Uint8Array {
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
 * pixels). Consumes the Preview Scene: builds it from the input, or
 * projects the prebuilt one passed in — the frames are the same either
 * way. Pure function; identical inputs yield identical frames.
 */
export function renderMotionPreviewFrames(input: MotionPreviewInput): readonly MotionPreviewFrame[] {
  const scene = input.scene ?? buildPreviewScene(input);
  if (scene.moments.length === 0) return [];

  // The scene every frame must hold: trajectory, home, and the whole
  // robot sweep. One fit for all frames — the view never jitters.
  const scenePoints: Vec3[] = [scene.homeMm];
  for (const segment of scene.segments) scenePoints.push(...segment.mm);
  for (const moment of scene.moments) scenePoints.push(...moment.chainMm);
  const toPx = fitProjection(scenePoints);

  const trajectoryPrimitives: PreviewPrimitive[] = [];
  const segmentPixels = new Map<number, readonly (readonly [number, number])[]>();
  for (const segment of scene.segments) {
    const px = segment.mm.map(toPx);
    segmentPixels.set(segment.segmentIndex, px);
    trajectoryPrimitives.push({
      kind: segment.isPtp ? "dashed" : "solid",
      points: px,
      colorIndex: MOTION_PREVIEW_COLORS.trajectory,
      width: 1,
    });
  }

  // The actual TCP trace under PTP: projected per-frame forward
  // kinematics positions, one polyline per scene trace run.
  const tcpPixels = scene.moments.map((moment) => toPx(moment.tcpMm));

  return scene.moments.map((moment, frameIndex) => {
    const primitives = [...trajectoryPrimitives];
    appendTravelled(primitives, input.plan.ranges, moment.travelled, segmentPixels);
    appendTrace(primitives, scene.traceRuns, frameIndex, tcpPixels);
    const chainPx = moment.chainMm.map(toPx);
    primitives.push({ kind: "solid", points: chainPx, colorIndex: MOTION_PREVIEW_COLORS.robot, width: 2 });
    primitives.push({
      kind: "dot",
      points: [chainPx[chainPx.length - 1] as [number, number]],
      colorIndex: MOTION_PREVIEW_COLORS.tcp,
      width: 2,
    });
    primitives.push({
      kind: "dot",
      points: [toPx(scene.homeMm)],
      colorIndex: MOTION_PREVIEW_COLORS.home,
      width: 3,
    });
    return { tMs: moment.tMs, primitives };
  });
}

/**
 * Appends the PTP TCP trace: every trace run up to `frameIndex`.
 */
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
 * Appends the travelled-part highlight: for every plan range, the
 * drawn polyline up to the extent the scene measured for the frame's
 * moment — the drawn sample count nearest the frame's forward-
 * kinematics TCP (`PreviewSceneMoment.travelled`), which ends where
 * the TCP marker sits. A count below 2 spans nothing drawable; a PTP
 * Move's count is 0 (only arrival is guaranteed, ADR 0016 — the
 * travelled reality is the TCP trace).
 */
function appendTravelled(
  primitives: PreviewPrimitive[],
  ranges: readonly PlanSegmentRange[],
  counts: readonly number[],
  segmentPixels: ReadonlyMap<number, readonly (readonly [number, number])[]>,
): void {
  ranges.forEach((range, index) => {
    const count = counts[index] as number;
    if (count < 2) return;
    const px = segmentPixels.get(range.segmentIndex);
    if (px === undefined || px.length === 0) return;
    primitives.push({
      kind: "solid",
      points: px.slice(0, count),
      colorIndex: MOTION_PREVIEW_COLORS.travelled,
      width: 2,
    });
  });
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
  // The charts' axis padding: a degenerate extent pads instead of
  // collapsing the fit's scale (one convention for every isometric view).
  const [xLo, xHi] = domain(Math.min(...xs), Math.max(...xs));
  const [yLo, yHi] = domain(Math.min(...ys), Math.max(...ys));
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
