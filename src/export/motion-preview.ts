/**
 * Motion Preview (the GIF exporter): isometric frames of the Motion
 * Plan as an animated GIF, rendered headless — no canvas, no DOM, no
 * three.js — by deterministic pure functions, exactly like the charts
 * (ADR 0013) and the headless pipeline (ADR 0012).
 *
 * One frame shows the scene bounds' back panes and grid (in the
 * matplotlib mplot3d spirit — panes and grid replace axis labels, and
 * no text is ever drawn), the full Trajectory colored through a fixed
 * time ramp by each sample's plan time (drawn geometry solid, PTP
 * Moves dashed), the travelled part highlighted over the gradient, the
 * Home Point, the robot's skeleton (from `RobotModel.chainPoints`) —
 * thicker than the trajectory — with its TCP marker, and — under PTP —
 * the actual TCP trace, computed by per-frame forward kinematics (a
 * PTP Move guarantees only arrival, so the real path is the FK path,
 * ADR 0016).
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
 * Rasterization anti-aliases by fixed-factor supersampling (integer
 * pens on an S× grid, then a box filter down to the frame, each
 * blended pixel mapped to its nearest palette entry with first-index
 * tie-breaking): deterministic float math, no randomness, byte-
 * identical output for identical input (ADR 0018's pure-integer-pixel
 * statement deliberately relaxed to deterministic float math with
 * pinned bytes).
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
import { buildPreviewScene, type PreviewScene, type PreviewSceneBounds } from "./preview-scene";

export { MOTION_PREVIEW_MAX_FRAMES } from "./preview-scene";

/** Frame size, in pixels. */
export const MOTION_PREVIEW_WIDTH = 800;
export const MOTION_PREVIEW_HEIGHT = 600;

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
  /**
   * Kept for contract stability (index 2 stays pinned); the Trajectory
   * itself strokes through the {@link MOTION_PREVIEW_TIME_RAMP}.
   */
  trajectory: 2,
  /** The travelled part, highlighted over the time-ramped trajectory. */
  travelled: 3,
  /** The TCP (pen) marker at the sampled plan moment. */
  tcp: 4,
  /** The actual TCP trace under PTP (per-frame forward kinematics). */
  ptpTrace: 5,
  /** The Home Point marker. */
  home: 6,
  /** The back pane at the bounds' maximum X (the right wall). */
  paneX: 7,
  /** The back pane at the bounds' maximum Y (the left wall). */
  paneY: 8,
  /** The back pane at the bounds' minimum Z (the floor). */
  paneZ: 9,
  /** The grid lines on the back panes. */
  grid: 10,
} as const;

/** One projected primitive of a frame, in frame pixel coordinates. */
export interface PreviewPrimitive {
  /**
   * `solid`/`dashed` polylines stroke through `points`; a `dot` fills a
   * disc of radius `width` at `points[0]`; a `fill` floods the polygon
   * through `points` (closed implicitly) — the scene's back panes.
   */
  readonly kind: "solid" | "dashed" | "dot" | "fill";
  /** Pixel coordinates (rounded integers, screen y growing down). */
  readonly points: readonly (readonly [number, number])[];
  /**
   * A palette index. A {@link MOTION_PREVIEW_COLORS} entry for every
   * kind except the time-ramped Trajectory strokes, whose head color
   * this carries (the per-sample colors live in `pointColors`).
   */
  readonly colorIndex: number;
  /** Stroke width in pixels; for a `dot`, the disc radius; unused by a `fill`. */
  readonly width: number;
  /**
   * Per-point palette colors aligned with `points` — the time ramp of
   * a Trajectory stroke: each segment strokes in its start point's
   * color. Absent for single-color strokes.
   */
  readonly pointColors?: readonly number[];
}

/** One preview frame: the projected geometry at one sampled plan moment. */
export interface MotionPreviewFrame {
  /** The sampled plan time, in milliseconds. */
  readonly tMs: number;
  /** Projected primitives in draw order (the background is implicit):
   *  panes → grid → trajectory gradient → travelled → trace → robot → dots. */
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
 * applied to the preview's look). Indices 0–6 keep their historical
 * RGB; the pane/grid grays follow; the time ramp continues from there.
 */
const PREVIEW_COLORS: readonly GifColor[] = [
  [255, 255, 255], // background
  [51, 51, 51], // robot
  [153, 153, 153], // trajectory (kept pinned; the ramp colors the Trajectory)
  [31, 119, 180], // travelled
  [214, 39, 40], // tcp
  [255, 127, 14], // ptpTrace
  [44, 160, 44], // home
  [242, 242, 242], // paneX — the mplot3d wall grays, one shade per face
  [229, 229, 229], // paneY
  [235, 235, 235], // paneZ
  [204, 204, 204], // grid
];

/**
 * The time ramp's anchor colors: samples of the viridis colormap —
 * deep purple through blue and teal into bright yellow — the fixed
 * gradient the Trajectory's schedule reads through. Fixed constants,
 * like every palette entry.
 */
const TIME_RAMP_STOPS: readonly GifColor[] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [223, 227, 24],
  [253, 231, 37],
];

/** Time ramp resolution: entries between the first and last stop. */
const TIME_RAMP_ENTRIES = 40;

/** Piecewise-linear RGB blend of the ramp stops at parameter `t` ∈ [0, 1]. */
function blendRampStops(t: number): GifColor {
  const pos = t * (TIME_RAMP_STOPS.length - 1);
  const seg = Math.min(TIME_RAMP_STOPS.length - 2, Math.floor(pos));
  const f = pos - seg;
  const a = TIME_RAMP_STOPS[seg] as GifColor;
  const b = TIME_RAMP_STOPS[seg + 1] as GifColor;
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** The ramp's RGB entries: {@link TIME_RAMP_ENTRIES} blends of the stops. */
const TIME_RAMP_RGB: readonly GifColor[] = Array.from(
  { length: TIME_RAMP_ENTRIES },
  (_, k) => blendRampStops(k / (TIME_RAMP_ENTRIES - 1)),
);

/**
 * The time ramp as palette indices: a contiguous slice starting right
 * behind the {@link MOTION_PREVIEW_COLORS} contract entries. Fixed and
 * deterministic; the Trajectory's per-sample colors and the dialog's
 * own gradient both read it.
 */
export const MOTION_PREVIEW_TIME_RAMP: readonly number[] = TIME_RAMP_RGB.map(
  (_, k) => PREVIEW_COLORS.length + k,
);

/**
 * Maps a normalized plan time (t/ms over the plan duration) to the ramp's
 * palette index: clamped to [0, 1], spread evenly over the entries.
 */
export function timeToRampIndex(t01: number): number {
  const clamped = Math.min(1, Math.max(0, t01));
  return MOTION_PREVIEW_TIME_RAMP[Math.round(clamped * (TIME_RAMP_ENTRIES - 1))] as number;
}

/**
 * The full 256-entry global GIF color table: the preview colors, then
 * the time ramp, then — so the anti-aliasing's nearest-matching maps
 * blended edge pixels onto faithful entries — a fine grayscale ramp
 * (step 3) for the gray-on-gray blends and a web-safe 6×6×6 cube for
 * the chromatic ones. Deterministic; fixed for the format's 256-color
 * maximum (the cube truncates where the table fills).
 */
export const MOTION_PREVIEW_PALETTE: readonly GifColor[] = (() => {
  const palette: GifColor[] = [...PREVIEW_COLORS, ...TIME_RAMP_RGB];
  for (let v = 252; v >= 0 && palette.length < 256; v -= 3) {
    palette.push([v, v, v]);
  }
  for (const r of [0, 51, 102, 153, 204, 255]) {
    for (const g of [0, 51, 102, 153, 204, 255]) {
      for (const b of [0, 51, 102, 153, 204, 255]) {
        if (palette.length < 256) palette.push([r, g, b]);
      }
    }
  }
  return palette;
})();

/** The palette's RGB, flattened for the downsampler's blending loops. */
const PALETTE_RGB = (() => {
  const flat = new Uint8Array(MOTION_PREVIEW_PALETTE.length * 3);
  MOTION_PREVIEW_PALETTE.forEach(([r, g, b], i) => {
    flat[i * 3] = r as number;
    flat[i * 3 + 1] = g as number;
    flat[i * 3 + 2] = b as number;
  });
  return flat;
})();

/**
 * Nearest-palette-entry cache keyed by packed RGB (0 = uncomputed,
 * otherwise the palette index + 1). The mapping is a pure function of
 * the fixed palette, so the cache never goes stale; nearest is the
 * minimal squared RGB distance with first-index tie-breaking.
 */
const PALETTE_MATCH_CACHE = new Uint8Array(1 << 24);

function nearestPaletteIndex(r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b;
  const cached = PALETTE_MATCH_CACHE[key];
  if (cached !== undefined && cached !== 0) return cached - 1;
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < MOTION_PREVIEW_PALETTE.length; i++) {
    const dr = PALETTE_RGB[i * 3] as number - r;
    const dg = PALETTE_RGB[i * 3 + 1] as number - g;
    const db = PALETTE_RGB[i * 3 + 2] as number - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  PALETTE_MATCH_CACHE[key] = best + 1;
  return best;
}

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

/** Supersampling factor of the anti-aliased raster: each frame draws on an S× grid. */
const SUPERSAMPLE = 2;

/** Dash pattern in output pixels: 4 on, 3 off — counted along the arc length. */
const DASH_PERIOD_PX = 7;
const DASH_ON_PX = 4;

/**
 * Rasterizes one frame's primitives onto the palette: background
 * first, then primitives in draw order (later draws over earlier).
 *
 * Anti-aliased and deterministic: the geometry draws with integer
 * pens on a fixed S× supersampled grid (pure integer math there), a
 * box filter averages each output pixel's S² sub-pixels, and every
 * blended pixel maps to its nearest palette entry (minimal squared
 * RGB distance, first-index ties). The float math is stable — no
 * randomness, no wall-clock input — so identical input yields byte-
 * identical output (ADR 0018's raster statement, relaxed from pure
 * integer pixels to deterministic float math with pinned bytes).
 * The raster step is what the GIF encoder encodes; the playback
 * dialog paints these same palette indices until its own camera
 * ticket, so the dialog keeps showing exactly what the GIF shows.
 */
export function rasterizePreviewFrame(frame: MotionPreviewFrame): Uint8Array {
  const s = SUPERSAMPLE;
  const subWidth = MOTION_PREVIEW_WIDTH * s;
  const subHeight = MOTION_PREVIEW_HEIGHT * s;
  const sub = new Uint8Array(subWidth * subHeight);
  sub.fill(MOTION_PREVIEW_COLORS.background);
  const scaled = (points: readonly (readonly [number, number])[]): readonly (readonly [number, number])[] =>
    points.map(([x, y]) => [x * s, y * s]);
  for (const primitive of frame.primitives) {
    if (primitive.kind === "fill") {
      fillQuad(sub, subWidth, subHeight, scaled(primitive.points), primitive.colorIndex);
      continue;
    }
    if (primitive.kind === "dot") {
      fillDisc(sub, subWidth, scaled(primitive.points)[0] as readonly [number, number], primitive.width * s, primitive.colorIndex);
      continue;
    }
    strokePolyline(
      sub,
      subWidth,
      scaled(primitive.points),
      primitive.width * s,
      primitive.colorIndex,
      primitive.pointColors,
      primitive.kind === "dashed",
    );
  }
  return downsample(sub, subWidth);
}

/** Paints a sub-pixel, clipped to the supersampled canvas. */
function plot(pixels: Uint8Array, width: number, x: number, y: number, colorIndex: number): void {
  if (x < 0 || y < 0 || x >= width || y >= pixels.length / width) return;
  pixels[y * width + x] = colorIndex;
}

/**
 * Paints a `width` × `width` block pen (sub-pixel units). The pen
 * anchors its top-left so even pens cover the point's own cell: a
 * 2×2 pen at an even coordinate covers exactly that output pixel's
 * S² sub-pixels, which keeps width-1 strokes crisply on the path.
 */
function plotBlock(pixels: Uint8Array, width: number, x: number, y: number, pen: number, colorIndex: number): void {
  const half = Math.floor((pen - 1) / 2);
  for (let dy = 0; dy < pen; dy++) {
    for (let dx = 0; dx < pen; dx++) {
      plot(pixels, width, x + dx - half, y + dy - half, colorIndex);
    }
  }
}

/**
 * Strokes a polyline in Bresenham steps over the supersampled grid.
 * With `pointColors`, each segment strokes in its start point's color
 * (the time-ramped Trajectory); dashes break the stroke by arc length
 * in output pixels — 4 on, 3 off, counted along the whole polyline —
 * so the pattern is resolution-independent and straddles joints
 * naturally.
 */
function strokePolyline(
  pixels: Uint8Array,
  width: number,
  points: readonly (readonly [number, number])[],
  pen: number,
  colorIndex: number,
  pointColors: readonly number[] | undefined,
  dashed: boolean,
): void {
  let arcPx = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1] as readonly [number, number];
    const [x1, y1] = points[i] as readonly [number, number];
    const color = pointColors !== undefined ? (pointColors[i - 1] as number) : colorIndex;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    if (dx === 0 && dy === 0) continue; // a zero-length segment spans no arc
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    // Arc length of this segment in output pixels, advanced as the
    // Bresenham steps consume it (a diagonal sub-step covers √2/S px).
    let travelledPx = 0;
    for (;;) {
      if (!dashed || (arcPx + travelledPx) % DASH_PERIOD_PX < DASH_ON_PX) {
        plotBlock(pixels, width, x, y, pen, color);
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      let steppedX = false;
      let steppedY = false;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
        steppedX = true;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
        steppedY = true;
      }
      travelledPx += (steppedX && steppedY ? Math.SQRT2 : 1) / SUPERSAMPLE;
    }
    arcPx += Math.sqrt(dx * dx + dy * dy) / SUPERSAMPLE;
  }
}

/** Fills a disc of radius `radius` (sub-pixel units) centered at `center`, clipped. */
function fillDisc(
  pixels: Uint8Array,
  width: number,
  center: readonly [number, number],
  radius: number,
  colorIndex: number,
): void {
  const [cx, cy] = center;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        plot(pixels, width, cx + dx, cy + dy, colorIndex);
      }
    }
  }
}

/**
 * Floods a convex polygon (a scene pane) with a scanline fill: for
 * each sub-pixel row center, the two edge crossings bound the span;
 * sub-pixels whose centers sit inside are painted. Half-open edge
 * rules (`min ≤ yc < max`) keep vertex rows counted once; horizontal
 * edges span no row. A degenerate polygon (zero area — a face flat
 * along an axis) floods nothing, provably, by the shoelace guard.
 * Clipped to the canvas.
 */
function fillQuad(
  pixels: Uint8Array,
  width: number,
  height: number,
  quad: readonly (readonly [number, number])[],
  colorIndex: number,
): void {
  let area2 = 0;
  for (let e = 0; e < quad.length; e++) {
    const [ax, ay] = quad[e] as readonly [number, number];
    const [bx, by] = quad[(e + 1) % quad.length] as readonly [number, number];
    area2 += ax * by - bx * ay;
  }
  if (Math.abs(area2) < 1e-9) return;
  const ys = quad.map(([y]) => y);
  const yStart = Math.max(0, Math.ceil(Math.min(...ys) - 0.5));
  const yEnd = Math.min(height - 1, Math.ceil(Math.max(...ys) - 0.5) - 1);
  for (let y = yStart; y <= yEnd; y++) {
    const yc = y + 0.5;
    let xL = Infinity;
    let xR = -Infinity;
    for (let e = 0; e < quad.length; e++) {
      const [px, py] = quad[e] as readonly [number, number];
      const [qx, qy] = quad[(e + 1) % quad.length] as readonly [number, number];
      if ((py <= yc && yc < qy) || (qy <= yc && yc < py)) {
        const x = px + ((yc - py) * (qx - px)) / (qy - py);
        if (x < xL) xL = x;
        if (x > xR) xR = x;
      }
    }
    if (!(xR >= xL)) continue;
    const xStart = Math.max(0, Math.ceil(xL - 0.5));
    const xEnd = Math.min(width - 1, Math.ceil(xR - 0.5) - 1);
    for (let x = xStart; x <= xEnd; x++) {
      pixels[y * width + x] = colorIndex;
    }
  }
}

/**
 * Box-downsamples the supersampled raster onto the frame: each output
 * pixel averages its S² sub-pixels (equal indices short-circuit; a
 * blend averages the palette RGBs and rounds), then maps to the
 * nearest palette entry.
 */
function downsample(sub: Uint8Array, subWidth: number): Uint8Array {
  const s = SUPERSAMPLE;
  const out = new Uint8Array(MOTION_PREVIEW_WIDTH * MOTION_PREVIEW_HEIGHT);
  for (let y = 0; y < MOTION_PREVIEW_HEIGHT; y++) {
    for (let x = 0; x < MOTION_PREVIEW_WIDTH; x++) {
      const base = y * s * subWidth + x * s;
      const a = sub[base] as number;
      const b = sub[base + 1] as number;
      const c = sub[base + subWidth] as number;
      const d = sub[base + subWidth + 1] as number;
      if (a === b && b === c && c === d) {
        out[y * MOTION_PREVIEW_WIDTH + x] = a;
        continue;
      }
      let r = 0;
      let g = 0;
      let bl = 0;
      for (const index of [a, b, c, d]) {
        r += PALETTE_RGB[index * 3] as number;
        g += PALETTE_RGB[index * 3 + 1] as number;
        bl += PALETTE_RGB[index * 3 + 2] as number;
      }
      out[y * MOTION_PREVIEW_WIDTH + x] = nearestPaletteIndex(
        Math.round(r / 4),
        Math.round(g / 4),
        Math.round(bl / 4),
      );
    }
  }
  return out;
}

/**
 * Renders every preview frame's projected geometry: the scene bounds'
 * back panes and grid, the full time-ramped Trajectory, the travelled
 * highlight, the PTP TCP trace, the Home Point, and the robot skeleton
 * with its TCP marker — all projected isometrically (the path-3d
 * chart's convention, ADR 0013) with one uniform mm→px scale fit to
 * the whole scene *and its bounding box* (equal aspect, ADR 0007's
 * anti-distortion discipline: equal millimetres draw as equal pixels).
 * The box joins the fit so the panes and grid — the projections of
 * its faces, whose corners no scene point may occupy — stay inside
 * the frame's margins with the geometry they back. Consumes the
 * Preview Scene: builds it from the input, or projects the prebuilt
 * one passed in — the frames are the same either way. Pure function;
 * identical inputs yield identical frames.
 */
export function renderMotionPreviewFrames(input: MotionPreviewInput): readonly MotionPreviewFrame[] {
  const scene = input.scene ?? buildPreviewScene(input);
  if (scene.moments.length === 0) return [];

  // The scene every frame must hold: trajectory, home, the whole
  // robot sweep, and the bounds box the panes draw from. One fit for
  // all frames — the view never jitters.
  const scenePoints: Vec3[] = [...boxCorners(scene.boundsMm), scene.homeMm];
  for (const segment of scene.segments) scenePoints.push(...segment.mm);
  for (const moment of scene.moments) scenePoints.push(...moment.chainMm);
  const toPx = fitProjection(scenePoints);

  const backgroundPrimitives = [
    ...paneFills(scene.boundsMm, toPx),
    ...gridLines(scene.boundsMm, toPx),
  ];

  const trajectoryPrimitives: PreviewPrimitive[] = [];
  const segmentPixels = new Map<number, readonly (readonly [number, number])[]>();
  for (const segment of scene.segments) {
    const px = segment.mm.map(toPx);
    segmentPixels.set(segment.segmentIndex, px);
    // The time gradient: each sample strokes in the ramp color of its
    // plan time (the scene's per-sample schedule), clamped to [0, 1].
    const durationMs = Math.max(1, input.plan.durationMs);
    const pointColors = segment.tMs.map((tMs) => timeToRampIndex(tMs / durationMs));
    trajectoryPrimitives.push({
      kind: segment.isPtp ? "dashed" : "solid",
      points: px,
      colorIndex: pointColors[0] as number,
      pointColors,
      width: 1,
    });
  }

  // The actual TCP trace under PTP: projected per-frame forward
  // kinematics positions, one polyline per scene trace run.
  const tcpPixels = scene.moments.map((moment) => toPx(moment.tcpMm));

  return scene.moments.map((moment, frameIndex) => {
    const primitives = [...backgroundPrimitives, ...trajectoryPrimitives];
    appendTravelled(primitives, input.plan.ranges, moment.travelled, segmentPixels);
    appendTrace(primitives, scene.traceRuns, frameIndex, tcpPixels);
    const chainPx = moment.chainMm.map(toPx);
    primitives.push({ kind: "solid", points: chainPx, colorIndex: MOTION_PREVIEW_COLORS.robot, width: 3 });
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

/** The bounds box's eight corners, in mm — the panes' and grid's source geometry. */
function boxCorners(bounds: PreviewSceneBounds): readonly Vec3[] {
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  return [
    [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
  ];
}

/**
 * The scene bounds' back panes as fill primitives, in draw order: the
 * three box faces whose outward normals face away from the camera —
 * the +X wall (right), the +Y wall (left), and the −Z floor — derived
 * from the isometric projection's viewing axis (1, 1, −1), the
 * direction that projects to a point. Each pane spans its face's four
 * corners; a face flat along an axis projects degenerate and floods
 * nothing. The panes replace axis labels (no text in any render, the
 * ADR 0013 font argument).
 */
function paneFills(bounds: PreviewSceneBounds, toPx: (p: Vec3) => [number, number]): readonly PreviewPrimitive[] {
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  const pane = (colorIndex: number, quad: readonly Vec3[]): PreviewPrimitive => ({
    kind: "fill",
    points: quad.map(toPx),
    colorIndex,
    width: 0,
  });
  return [
    pane(MOTION_PREVIEW_COLORS.paneX, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]),
    pane(MOTION_PREVIEW_COLORS.paneY, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]),
    pane(MOTION_PREVIEW_COLORS.paneZ, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]]),
  ];
}

/**
 * The panes' grid lines, in draw order (pane X, pane Y, pane Z; within
 * a pane its two in-plane families). Lines run at each axis's multiples
 * of that axis's grid step — the extent's extent/5 target snapped to
 * the nearest 1/2/5×10ᵏ mm (`gridStepMm`) — strictly inside the pane
 * (the multiples coinciding with the pane's edges are skipped; the
 * pane fill already draws those edges). A degenerate axis (zero
 * extent) carries no grid.
 */
function gridLines(bounds: PreviewSceneBounds, toPx: (p: Vec3) => [number, number]): readonly PreviewPrimitive[] {
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  const stepX = gridStepMm(x1 - x0);
  const stepY = gridStepMm(y1 - y0);
  const stepZ = gridStepMm(z1 - z0);
  const lines: PreviewPrimitive[] = [];
  const line = (a: Vec3, b: Vec3): void => {
    const px = [toPx(a), toPx(b)];
    if (px[0]![0] === px[1]![0] && px[0]![1] === px[1]![1]) return; // degenerate: spans nothing
    lines.push({ kind: "solid", points: px, colorIndex: MOTION_PREVIEW_COLORS.grid, width: 1 });
  };
  // Pane X (the +X wall): lines of constant Y (vertical) and constant Z.
  for (const y of interiorMultiples(y0, y1, stepY)) line([x1, y, z0], [x1, y, z1]);
  for (const z of interiorMultiples(z0, z1, stepZ)) line([x1, y0, z], [x1, y1, z]);
  // Pane Y (the +Y wall): lines of constant X (vertical) and constant Z.
  for (const x of interiorMultiples(x0, x1, stepX)) line([x, y1, z0], [x, y1, z1]);
  for (const z of interiorMultiples(z0, z1, stepZ)) line([x0, y1, z], [x1, y1, z]);
  // Pane Z (the floor): lines of constant X and constant Y.
  for (const x of interiorMultiples(x0, x1, stepX)) line([x, y0, z0], [x, y1, z0]);
  for (const y of interiorMultiples(y0, y1, stepY)) line([x0, y, z0], [x1, y, z0]);
  return lines;
}

/** The multiples of `step` strictly inside [min, max]; `step` 0 (a degenerate axis) yields none. */
function interiorMultiples(min: number, max: number, step: number): readonly number[] {
  if (!(step > 0)) return [];
  const first = Math.ceil(min / step);
  const last = Math.floor(max / step);
  const values: number[] = [];
  for (let k = first; k <= last; k++) {
    const v = k * step;
    if (v > min + step * 1e-9 && v < max - step * 1e-9) values.push(v);
  }
  return values;
}

/**
 * A pane axis's grid step: the axis extent divided by a target of five
 * lines, snapped to the nearest 1/2/5×10ᵏ mm — the charts' nice-tick
 * rhythm applied to millimetre space, deterministic in pure floats.
 */
function gridStepMm(extent: number): number {
  if (!(extent > 1e-9)) return 0;
  const raw = extent / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  let best = magnitude;
  for (const multiplier of [2, 5, 10]) {
    const candidate = multiplier * magnitude;
    if (Math.abs(candidate - raw) < Math.abs(best - raw)) best = candidate;
  }
  return best;
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
