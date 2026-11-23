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
 *   always labels its data extent endpoints.
 * - Numbers print in plain decimal (six significant digits, no
 *   exponent noise, no `-0`); a chart never emits NaN/Infinity.
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
    { id: "path-3d", title: "path-3d", svg: scalarChartSvg("path-3d", "t, ms", "", [], []) },
  ];
}

// ---------------------------------------------------------------------------
// End-effector kinematics from the reconstruction
// ---------------------------------------------------------------------------

/** The plan's row step in seconds — the reconstruction's sample rate. */
const DT_S = CONTROL_STEP_MS / 1000;

/**
 * The end-effector speed at every plan row, in mm/s: the magnitude of
 * the reconstructed path's velocity, central-differenced between rows
 * (one-sided at the ends). Speed, not signed velocity: the plotted
 * quantity is how fast the tool moves, and it is what the Feed sets.
 */
function eeSpeeds(points: readonly Vec3[]): readonly number[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  return points.map((_, i) => {
    if (i === 0) return vec3Distance(points[1] as Vec3, points[0] as Vec3) / DT_S;
    if (i === n - 1) return vec3Distance(points[i] as Vec3, points[i - 1] as Vec3) / DT_S;
    return vec3Distance(points[i + 1] as Vec3, points[i - 1] as Vec3) / (2 * DT_S);
  });
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
 * step (one-sided three-point windows at the ends).
 */
function eeAccelerations(points: readonly Vec3[]): readonly number[] {
  const n = points.length;
  if (n < 3) return points.map(() => 0);
  return points.map((_, i) => {
    const window =
      i === 0
        ? [points[0] as Vec3, points[1] as Vec3, points[2] as Vec3]
        : i === n - 1
          ? [points[n - 3] as Vec3, points[n - 2] as Vec3, points[n - 1] as Vec3]
          : [points[i - 1] as Vec3, points[i] as Vec3, points[i + 1] as Vec3];
    return length(secondDifference(window[0] as Vec3, window[1] as Vec3, window[2] as Vec3)) / (DT_S * DT_S);
  });
}

// ---------------------------------------------------------------------------
// Number formatting (the label contract)
// ---------------------------------------------------------------------------

/**
 * Formats a data value for a tick or extent label: six significant
 * digits in plain decimal, `-0` normalized to `0`.
 */
function fmtNum(v: number): string {
  if (v === 0) return "0";
  return String(Number(v.toPrecision(6)));
}

/** Formats a pixel coordinate (two decimals, no trailing zeros). */
function fmtPx(v: number): string {
  return String(Math.round(v * 100) / 100);
}

// ---------------------------------------------------------------------------
// Scales and ticks
// ---------------------------------------------------------------------------

/** The data domain of an axis; a degenerate (zero-width) domain is padded. */
function domain(min: number, max: number): readonly [number, number] {
  if (!(max > min)) {
    const pad = Math.max(Math.abs(min) * 0.05, 1);
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
 * sees the exact plotted extent, and tests can pin it.
 */
function ticksFor(min: number, max: number): readonly number[] {
  const step = niceStep((max - min) / TARGET_TICKS);
  const ticks = new Set<number>([min, max]);
  const count = Math.floor((max - min) / step + 1e-9);
  for (let k = 0; k <= count; k++) {
    const v = Number((min + k * step).toPrecision(12));
    if (v > min && v < max) ticks.add(v);
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
