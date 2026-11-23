/**
 * Headless charts (spec user stories 18–20): every plot the spec asks
 * for renders from the Motion Plan alone — no UI, no DOM — as
 * standalone SVG documents, so CI can verify the plotted output before
 * any chart view exists and the UI (a later ticket) shows the very
 * documents CI verified.
 *
 * The seam is one pure function, `renderCharts(plan, model)` → one
 * SVG per chart kind ({@link CHART_IDS}). Chart ids are stable
 * identifiers (like `PipelineStage`); axis units are pinned here, in
 * the plan's internal units (ms, rad, mm, mm/s) — the UI translates
 * titles, not data, per GLOSSARY.md.
 *
 * Output contract (pinned by `charts.test.ts`, the same discipline as
 * the CSV exporters of ADR 0006):
 *
 * - Each document opens `<svg xmlns="http://www.w3.org/2000/svg" …>`
 *   with `width`/`height`/`viewBox` and ends with `</svg>`.
 * - Series are `<polyline class="series" data-series="…" points="…">`;
 *   the attribute order and the `data-series` names (the model's joint
 *   names, or a chart-specific name) are part of the contract.
 * - Tick and extent labels are `<text class="tick-x|tick-y">`; the
 *   time axis always labels 0 and the plan duration, a value axis
 *   always labels its data extent endpoints, and labels are unique
 *   within an axis.
 * - Numbers print in plain decimal (six significant digits, no
 *   exponent noise, no `-0`); a chart never emits NaN/Infinity, even
 *   for a zero-row plan.
 */

import type { RobotModel, Vec3 } from "../kinematics/robot-model";
import { vec3Distance } from "../kinematics/robot-model";
import { CONTROL_STEP_MS, type MotionPlan } from "../motion/planner";

/** The chart kinds the spec asks for, as stable identifiers. */
export type ChartId =
  | "joint-positions"
  | "joint-velocities"
  | "joint-accelerations"
  | "joint-jerks"
  | "cartesian-path"
  | "end-effector-velocity"
  | "end-effector-acceleration"
  | "path-3d";

/** Every chart kind the renderer produces, in run order. */
export const CHART_IDS: readonly ChartId[] = [
  "joint-positions",
  "joint-velocities",
  "joint-accelerations",
  "joint-jerks",
  "cartesian-path",
  "end-effector-velocity",
  "end-effector-acceleration",
  "path-3d",
] as const;

/** One rendered chart: its stable id, its title, and its SVG document. */
export interface RenderedChart {
  /** The stable chart kind identifier. */
  readonly id: ChartId;
  /** Operator-readable title (English; the UI layer translates per GLOSSARY.md). */
  readonly title: string;
  /** A standalone SVG document (utf-8 bytes when written to a file). */
  readonly svg: string;
}

/** Canvas size of every chart, in SVG user units. */
const WIDTH = 640;
const HEIGHT = 400;

/** Plot-area margins: room for the title, legend, ticks, and axis titles. */
const MARGIN = { top: 48, right: 24, bottom: 46, left: 64 } as const;

/** Plot-area size derived from the canvas and margins. */
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

/** Rough tick count per axis before snapping to a nice step. */
const TARGET_TICKS = 5;

/** Series colors by joint/series index (colorblind-safe defaults). */
const PALETTE = ["#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#ff7f0e", "#8c564b"] as const;

/**
 * Renders every chart kind from the Motion Plan and Robot Model: joint
 * angles, velocities, accelerations, and jerks over time; the FK-
 * reconstructed cartesian path; end-effector speed and acceleration;
 * and the 3D path view. Pure function over its inputs — same plan and
 * model in, byte-identical SVG out. File writing happens outside the
 * renderer, exactly as with the CSV exporters.
 *
 * The plan is assumed validated (the pipeline's motion-plan stage
 * guarantees the grid, continuity, and limit invariants); a plan with
 * zero rows is undefined input and renders degenerate-but-harmless
 * charts rather than throwing.
 */
export function renderCharts(plan: MotionPlan, model: RobotModel): readonly RenderedChart[] {
  const tMs = plan.rows.map((row) => row.tMs);
  /** One joint-scalar line chart over time. */
  const scalar = (
    id: ChartId,
    title: string,
    field: "q" | "qd" | "qdd" | "qddd",
    yTitle: string,
  ): RenderedChart => ({
    id,
    title,
    svg: scalarChartSvg(
      title,
      "t, ms",
      yTitle,
      tMs,
      model.joints.map((joint, j) => ({
        name: joint.name,
        values: plan.rows.map((row) => row[field][j] as number),
      })),
    ),
  });

  /** The FK-reconstructed pen positions, one per plan row. */
  const pen = plan.rows.map((row) => model.forwardKinematics(row.q));

  return [
    scalar("joint-positions", "Joint angles over time", "q", "q, rad"),
    scalar("joint-velocities", "Joint velocities over time", "qd", "qd, rad/s"),
    scalar("joint-accelerations", "Joint accelerations over time", "qdd", "qdd, rad/s²"),
    scalar("joint-jerks", "Joint jerks over time", "qddd", "qddd, rad/s³"),
    {
      id: "cartesian-path",
      title: "Reconstructed cartesian path (top view)",
      svg: pathChartSvg(
        "Reconstructed cartesian path (top view)",
        "x, mm",
        "y, mm",
        pen.map((p) => [p[0] as number, p[1] as number] as const),
        "path",
      ),
    },
    {
      id: "end-effector-velocity",
      title: "End-effector speed over time",
      svg: scalarChartSvg(
        "End-effector speed over time",
        "t, ms",
        "v, mm/s",
        tMs,
        [{ name: "speed", values: eeSpeeds(pen) }],
      ),
    },
    {
      id: "end-effector-acceleration",
      title: "End-effector acceleration over time",
      svg: scalarChartSvg(
        "End-effector acceleration over time",
        "t, ms",
        "a, mm/s²",
        tMs,
        [{ name: "acceleration", values: eeAccelerations(pen) }],
      ),
    },
    {
      id: "path-3d",
      title: "Planned path in 3D (isometric)",
      svg: path3dChartSvg("Planned path in 3D (isometric)", pen),
    },
  ];
}

// ---------------------------------------------------------------------------
// End-effector kinematics from the reconstruction
// ---------------------------------------------------------------------------

/** The plan's row step in seconds — the reconstruction's sample rate. */
const DT_S = CONTROL_STEP_MS / 1000;

/**
 * Speed magnitudes below this (mm/s) are finite-difference noise, not
 * motion: differencing float positions of order 10³ mm at the 20 ms
 * row step leaves ~10⁻¹¹ mm/s of rounding residue, so the floor sits
 * far above the noise and far below any real traverse rate.
 */
const SPEED_NOISE_MM_S = 1e-6;

/**
 * Acceleration magnitudes below this (mm/s²) are finite-difference
 * noise: a second difference amplifies the same position rounding to
 * ~10⁻⁸ mm/s², and real accelerations of interest are O(1) and up
 * (a 20 mm/s velocity step over one row gap is 500 mm/s²).
 */
const ACCEL_NOISE_MM_S2 = 1e-3;

/** Replaces magnitudes below a noise floor with exactly zero. */
function snapNoise(values: readonly number[], floor: number): readonly number[] {
  return values.map((v) => (Math.abs(v) < floor ? 0 : v));
}

/**
 * The end-effector speed at every plan row, in mm/s: the magnitude of
 * the reconstructed path's velocity, central-differenced between rows
 * (one-sided at the ends). Speed, not signed velocity: the plotted
 * quantity is how fast the tool moves, and it is what the Feed sets.
 * Differencing noise is snapped to zero, so exactly-constant motion
 * plots exactly constant instead of a nonsense 10⁻¹²-scale axis.
 */
function eeSpeeds(points: readonly Vec3[]): readonly number[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const speeds = points.map((_, i) => {
    if (i === 0) return vec3Distance(points[1] as Vec3, points[0] as Vec3) / DT_S;
    if (i === n - 1) return vec3Distance(points[i] as Vec3, points[i - 1] as Vec3) / DT_S;
    return vec3Distance(points[i + 1] as Vec3, points[i - 1] as Vec3) / (2 * DT_S);
  });
  return snapNoise(speeds, SPEED_NOISE_MM_S);
}

/** The componentwise sum `a + b`. */
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** The componentwise difference `a − b`. */
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** The magnitude of a vector. */
function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** The vector second difference `(p_next − 2·p + p_prev)` as a Vec3. */
function secondDifference(prev: Vec3, p: Vec3, next: Vec3): Vec3 {
  return sub(add(next, prev), [2 * p[0], 2 * p[1], 2 * p[2]]);
}

/**
 * The end-effector acceleration magnitude at every plan row, in mm/s²:
 * the second difference of the reconstructed positions over the row
 * step (one-sided three-point windows at the ends). Differencing
 * noise is snapped to zero, as with the speeds.
 */
function eeAccelerations(points: readonly Vec3[]): readonly number[] {
  const n = points.length;
  if (n < 3) return points.map(() => 0);
  const accelerations = points.map((_, i) => {
    const window =
      i === 0
        ? [points[0] as Vec3, points[1] as Vec3, points[2] as Vec3]
        : i === n - 1
          ? [points[n - 3] as Vec3, points[n - 2] as Vec3, points[n - 1] as Vec3]
          : [points[i - 1] as Vec3, points[i] as Vec3, points[i + 1] as Vec3];
    return length(secondDifference(window[0] as Vec3, window[1] as Vec3, window[2] as Vec3)) / (DT_S * DT_S);
  });
  return snapNoise(accelerations, ACCEL_NOISE_MM_S2);
}

// ---------------------------------------------------------------------------
// Number formatting (the label contract)
// ---------------------------------------------------------------------------

/**
 * Formats a data value for a tick or extent label: six significant
 * digits in plain decimal — exponent notation is expanded, the label
 * contract forbids it — and `-0` normalized to `0`.
 */
function fmtNum(v: number): string {
  if (v === 0) return "0";
  const rounded = Number(v.toPrecision(6));
  if (rounded === 0) return "0";
  const s = String(rounded);
  if (!s.includes("e")) return s;
  // Expand the exponent form: place the six significant digits after
  // the decimal point (a value ≥ 10²¹ stays an integer string).
  const exp = Number(s.slice(s.indexOf("e") + 1));
  const fixed = Math.abs(rounded).toFixed(Math.max(0, 5 - exp));
  const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  return `${v < 0 ? "-" : ""}${trimmed}`;
}

/** Formats a pixel coordinate (two decimals, no trailing zeros). */
function fmtPx(v: number): string {
  return String(Math.round(v * 100) / 100);
}

// ---------------------------------------------------------------------------
// Scales and ticks
// ---------------------------------------------------------------------------

/**
 * The data domain of an axis; a degenerate domain is padded. Degenerate
 * means zero-width or noise-scale: a span within 10⁻⁹ of the value
 * magnitude is float residue (e.g. a constant 20 mm/s traverse
 * computing to 20 ± 2·10⁻¹⁴), not signal, and pads like an exactly
 * constant series instead of spawning a 10⁻¹⁴-scale tick axis.
 */
function domain(min: number, max: number): readonly [number, number] {
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  if (!(max - min > 1e-9 * magnitude)) {
    const pad = Math.max(magnitude * 0.05, 1);
    return [min - pad, min + pad];
  }
  return [min, max];
}

/** Snaps a raw tick interval to a nice 1/2/5×10ᵏ step. */
function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const multiplier of [1, 2, 5, 10]) {
    const step = multiplier * magnitude;
    if (step >= raw - magnitude * 1e-12) return step;
  }
  return 10 * magnitude;
}

/**
 * The labeled tick values of one axis: nice 1/2/5×10ᵏ steps inside the
 * domain plus the domain endpoints themselves — so the reader always
 * sees the exact plotted extent, and tests can pin it. A step that
 * rounds onto an endpoint (or onto another tick's printed label) is
 * dropped: every label on an axis is distinct.
 */
function ticksFor(min: number, max: number): readonly number[] {
  const step = niceStep((max - min) / TARGET_TICKS);
  const ticks = new Set<number>([min, max]);
  const labels = new Set<string>([fmtNum(min), fmtNum(max)]);
  const count = Math.floor((max - min) / step + 1e-9);
  for (let k = 1; k <= count; k++) {
    const v = Number((min + k * step).toPrecision(12));
    if (v <= min || v >= max) continue;
    const label = fmtNum(v);
    if (labels.has(label)) continue;
    labels.add(label);
    ticks.add(v);
  }
  return [...ticks].sort((a, b) => a - b);
}

/** A linear data→pixel mapping for one axis. */
interface Scale {
  /** Maps a data value to its pixel coordinate. */
  toPx(v: number): number;
  /** The labeled tick values of this axis. */
  ticks(): readonly number[];
}

/** Builds a linear scale over `[min, max]` mapping onto `[pxStart, pxEnd]`. */
function linearScale(min: number, max: number, pxStart: number, pxEnd: number): Scale {
  const [lo, hi] = domain(min, max);
  const span = hi - lo;
  return {
    toPx: (v) => pxStart + ((v - lo) / span) * (pxEnd - pxStart),
    ticks: () => ticksFor(lo, hi),
  };
}

// ---------------------------------------------------------------------------
// SVG assembly
// ---------------------------------------------------------------------------

/** One plotted series: its contract name and its scalar values. */
interface SeriesInput {
  /** The `data-series` contract name (a joint name for joint charts). */
  readonly name: string;
  /** The scalar values, aligned with the chart's x values. */
  readonly values: readonly number[];
}

/**
 * Assembles a line chart of scalar series over a shared x axis (the
 * joint charts and the end-effector charts): frame, grid, labeled
 * ticks and axis titles, one legend entry per series (multi-series
 * only), and one polyline per series. The value axis spans the data
 * exactly; the time axis spans `[0, max]`.
 */
function scalarChartSvg(
  title: string,
  xTitle: string,
  yTitle: string,
  xValues: readonly number[],
  series: readonly SeriesInput[],
): string {
  const xScale = linearScale(Math.min(...xValues, 0), Math.max(...xValues, 0), MARGIN.left, MARGIN.left + PLOT_W);
  const all = series.flatMap((s) => [...s.values]);
  const yScale = linearScale(
    all.length > 0 ? Math.min(...all) : 0,
    all.length > 0 ? Math.max(...all) : 0,
    MARGIN.top + PLOT_H,
    MARGIN.top,
  );
  const pixelSeries = series.map((s) => ({
    name: s.name,
    points: s.values.map(
      (v, k) => [xScale.toPx(xValues[k] as number), yScale.toPx(v)] as const,
    ),
  }));
  return assembleChart(title, xScale, yScale, xTitle, yTitle, pixelSeries);
}

/**
 * Assembles a path chart (the cartesian top view, and the projected
 * 3D view): millimetre geometry drawn with a uniform scale on both
 * axes — equal aspect, so equal millimetres always draw as equal
 * pixels (ADR 0007's anti-distortion discipline, applied to charts).
 * The limiting axis spans the plot area; the other is centered.
 */
function pathChartSvg(
  title: string,
  xTitle: string,
  yTitle: string,
  points: readonly (readonly [number, number])[],
  seriesName: string,
): string {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [xLo, xHi] = domain(Math.min(...xs, 0), Math.max(...xs, 0));
  const [yLo, yHi] = domain(Math.min(...ys, 0), Math.max(...ys, 0));
  // Uniform scale: both axes get the same mm→px factor, chosen so the
  // limiting dimension fills the plot area.
  const scale = Math.min(PLOT_W / (xHi - xLo), PLOT_H / (yHi - yLo));
  const xCenter = (xLo + xHi) / 2;
  const yCenter = (yLo + yHi) / 2;
  const xScale = linearScale(xCenter - PLOT_W / scale / 2, xCenter + PLOT_W / scale / 2, MARGIN.left, MARGIN.left + PLOT_W);
  const yScale = linearScale(yCenter - PLOT_H / scale / 2, yCenter + PLOT_H / scale / 2, MARGIN.top + PLOT_H, MARGIN.top);
  const pixelSeries = [{
    name: seriesName,
    points: points.map(([x, y]) => [xScale.toPx(x), yScale.toPx(y)] as const),
  }];
  return assembleChart(title, xScale, yScale, xTitle, yTitle, pixelSeries);
}

/** cos 30° — the isometric ground-axis tilt. */
const COS_30 = Math.cos(Math.PI / 6);
/** sin 30° — the isometric ground-axis rise. */
const SIN_30 = 0.5;

/**
 * The isometric projection of a model-frame point (mm) onto the chart
 * plane: X and Y recede along the ground axes (±30° from horizontal),
 * Z stays vertical. All three unit axes project to length exactly 1,
 * so with the uniform plot scale the view is equal-aspect by
 * construction — a cube draws as a proper isometric cube.
 */
function projectIsometric(p: Vec3): readonly [number, number] {
  const right = (p[0] - p[1]) * COS_30;
  const up = p[2] + (p[0] + p[1]) * SIN_30;
  return [right, up];
}

/** The bounding box `[min, max]` of one coordinate across the points. */
function extentOf(values: readonly number[]): readonly [number, number] {
  return [Math.min(...values), Math.max(...values)];
}

/**
 * Assembles the 3D path view: the planned path projected isometrically
 * with equal-aspect axes, inside the projected bounding-box wireframe
 * of the motion, with each world axis labeled at its box edge. The
 * projection mixes world axes, so there are no per-screen-axis tick
 * labels; the units live in the caption (mm).
 *
 * The view frames the projected bounding box — not the path alone —
 * so the wireframe, and the path inside it, always stay inside the
 * plot area. Degenerate extents (a single row, a flat motion, or a
 * zero-row plan) are padded, so every drawn coordinate stays finite:
 * a chart never emits NaN/Infinity.
 */
function path3dChartSvg(title: string, points: readonly Vec3[]): string {
  // The motion's bounding box, per world axis, padded when degenerate.
  const padAxis = (axis: 0 | 1 | 2): readonly [number, number] => {
    if (points.length === 0) return [-1, 1];
    return domain(Math.min(...points.map((p) => p[axis])), Math.max(...points.map((p) => p[axis])));
  };
  const [x0, x1] = padAxis(0);
  const [y0, y1] = padAxis(1);
  const [z0, z1] = padAxis(2);
  const corner = (bits: number): Vec3 => [bits & 1 ? x1 : x0, bits & 2 ? y1 : y0, bits & 4 ? z1 : z0];
  // Fit to the box's projected extents: the projection is linear, so
  // the box's projection contains the path's, and the box defines the
  // largest geometry the view must hold.
  const projectedCorners = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => projectIsometric(corner(bits)));
  const [xLo, xHi] = extentOf(projectedCorners.map(([x]) => x));
  const [yLo, yHi] = extentOf(projectedCorners.map(([, y]) => y));
  // Uniform scale: the limiting dimension fills the plot area; the
  // other is centered. Equal aspect by construction — all three unit
  // axes project to the same length.
  const scale = Math.min(PLOT_W / (xHi - xLo), PLOT_H / (yHi - yLo));
  const xCenter = (xLo + xHi) / 2;
  const yCenter = (yLo + yHi) / 2;
  const xScale = linearScale(xCenter - PLOT_W / scale / 2, xCenter + PLOT_W / scale / 2, MARGIN.left, MARGIN.left + PLOT_W);
  const yScale = linearScale(yCenter - PLOT_H / scale / 2, yCenter + PLOT_H / scale / 2, MARGIN.top + PLOT_H, MARGIN.top);

  const parts: string[] = [svgOpen(title)];
  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`);
  parts.push(text("chart-title", WIDTH / 2, 18, title, 'text-anchor="middle"'));
  parts.push(`<rect class="plot-frame" x="${MARGIN.left}" y="${MARGIN.top}" width="${PLOT_W}" height="${PLOT_H}" fill="none" stroke="#333333"/>`);

  // The bounding-box wireframe: eight corners, twelve edges, projected.
  const toPx = (p: Vec3): readonly [number, number] => {
    const [mx, my] = projectIsometric(p);
    return [xScale.toPx(mx), yScale.toPx(my)];
  };
  const boxCenter = toPx([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]);
  const edges: readonly (readonly [number, number])[] = [
    [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [4, 5], [4, 6], [3, 7], [5, 7], [6, 7],
  ];
  const boxD = edges
    .map(([a, b]) => {
      const [ax, ay] = toPx(corner(a));
      const [bx, by] = toPx(corner(b));
      return `M ${fmtPx(ax)} ${fmtPx(ay)} L ${fmtPx(bx)} ${fmtPx(by)}`;
    })
    .join(" ");
  parts.push(`<path class="axes-box" d="${boxD}" fill="none" stroke="#bbbbbb"/>`);

  // Labels for the world axes at the midpoints of the three edges that
  // emanate from the (min, min, min) corner, nudged away from the box.
  const axisEdges: readonly (readonly [string, Vec3, Vec3])[] = [
    ["X", corner(0), corner(1)],
    ["Y", corner(0), corner(2)],
    ["Z", corner(0), corner(4)],
  ];
  for (const [axis, from, to] of axisEdges) {
    const mid: Vec3 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
    const [mx, my] = toPx(mid);
    const dx = mx - boxCenter[0];
    const dy = my - boxCenter[1];
    const d = Math.hypot(dx, dy);
    const [ox, oy] = d > 1e-9 ? [(dx / d) * 12, (dy / d) * 12] : [0, 0];
    parts.push(text("axis-label-3d", mx + ox, my + oy + 4, axis, 'text-anchor="middle"'));
  }

  const pathPoints = points.map((p) => {
    const [px, py] = toPx(p);
    return `${fmtPx(px)},${fmtPx(py)}`;
  }).join(" ");
  parts.push(`<polyline class="series" data-series="path-3d" points="${pathPoints}" fill="none" stroke="${PALETTE[0]}" stroke-width="1.5"/>`);
  parts.push(
    text(
      "axis-caption",
      MARGIN.left + PLOT_W / 2,
      HEIGHT - 8,
      "X, Y, Z in mm; equal-aspect isometric projection",
      'text-anchor="middle"',
    ),
  );
  parts.push("</svg>");
  return parts.join("");
}

/**
 * Assembles the chart document: frame, grid, labeled ticks and axis
 * titles, legend entries (multi-series only), and one polyline per
 * series, over already-built pixel series.
 */
function assembleChart(
  title: string,
  xScale: Scale,
  yScale: Scale,
  xTitle: string,
  yTitle: string,
  series: readonly { name: string; points: readonly (readonly [number, number])[] }[],
): string {
  const parts: string[] = [svgOpen(title)];
  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`);
  parts.push(text("chart-title", WIDTH / 2, 18, title, 'text-anchor="middle"'));
  parts.push(`<rect class="plot-frame" x="${MARGIN.left}" y="${MARGIN.top}" width="${PLOT_W}" height="${PLOT_H}" fill="none" stroke="#333333"/>`);
  for (const v of xScale.ticks()) {
    const px = fmtPx(xScale.toPx(v));
    parts.push(`<line class="grid" x1="${px}" y1="${MARGIN.top}" x2="${px}" y2="${MARGIN.top + PLOT_H}" stroke="#e3e3e3"/>`);
    parts.push(text("tick-x", xScale.toPx(v), MARGIN.top + PLOT_H + 16, fmtNum(v), 'text-anchor="middle"'));
  }
  for (const v of yScale.ticks()) {
    const py = fmtPx(yScale.toPx(v));
    parts.push(`<line class="grid" x1="${MARGIN.left}" y1="${py}" x2="${MARGIN.left + PLOT_W}" y2="${py}" stroke="#e3e3e3"/>`);
    parts.push(text("tick-y", MARGIN.left - 6, yScale.toPx(v) + 4, fmtNum(v), 'text-anchor="end"'));
  }
  parts.push(text("axis-title-x", MARGIN.left + PLOT_W / 2, HEIGHT - 8, xTitle, 'text-anchor="middle"'));
  const yCenter = MARGIN.top + PLOT_H / 2;
  parts.push(text("axis-title-y", 14, yCenter, yTitle, `text-anchor="middle" transform="rotate(-90 14 ${yCenter})"`));

  if (series.length > 1) {
    let x = MARGIN.left;
    for (const [i, s] of series.entries()) {
      const color = PALETTE[i % PALETTE.length] as string;
      parts.push(`<rect class="legend-swatch" data-series="${s.name}" x="${x}" y="26" width="12" height="12" fill="${color}"/>`);
      parts.push(text("legend-label", x + 16, 36, s.name, `fill="${color}"`));
      x += 20 + s.name.length * 7 + 18;
    }
  }

  for (const [i, s] of series.entries()) {
    const color = PALETTE[i % PALETTE.length] as string;
    const points = s.points.map(([px, py]) => `${fmtPx(px)},${fmtPx(py)}`).join(" ");
    parts.push(`<polyline class="series" data-series="${s.name}" points="${points}" fill="none" stroke="${color}" stroke-width="1.5"/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

/** Opens a standalone SVG document with its accessible title. */
function svgOpen(title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${title}"><title>${title}</title>`;
}

/** Emits one text element; attributes order after `class` is not contract. */
function text(className: string, x: number, y: number, content: string, attrs: string): string {
  return `<text class="${className}" x="${fmtPx(x)}" y="${fmtPx(y)}" ${attrs}>${content}</text>`;
}
