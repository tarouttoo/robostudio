/**
 * Canvas scene rendering: draws the millimetre grid, the axes, the
 * committed Segments, the Home Point, and the pending Line draft from a
 * {@link CanvasScene}. All geometry flows through the canvas transform,
 * so what is drawn is exactly what the coordinates say (ADR 0007);
 * drawing happens in CSS pixels with the device pixel ratio applied as
 * the context transform, making the picture independent of the display.
 */

import {
  arcPointAt,
  planeCoords,
  segmentEnds,
  vec2,
  type Segment,
  type Vec2,
  type Vec3,
  type WorkingPlane,
} from "../../core";
import {
  REACHABILITY_COLORS,
  type ReachabilitySampler,
} from "./reachability";
import type {
  PointReachability,
  ReachabilityViolation,
} from "../../kinematics/reachability";
import { gridLinesMm } from "./grid";
import { worldBounds, type CanvasTransform } from "./transform";

/** Everything the canvas draws, already in app state. */
export interface CanvasScene {
  /** The live world↔screen mapping. */
  readonly transform: CanvasTransform;
  /** Working Plane the operator is drawing on. */
  readonly plane: WorkingPlane;
  /** Committed canonical Segments, in draw order. */
  readonly segments: readonly Segment[];
  /** The Home Point, or null while unset. */
  readonly home: Vec3 | null;
  /** Pending Line start in plane millimetres, or null. */
  readonly draftStart: Vec2 | null;
  /** Cursor position in plane millimetres, or null when off-canvas. */
  readonly cursor: Vec2 | null;
  /** The live Reachability map painted behind the geometry. */
  readonly reachability: ReachabilitySampler;
  /** Per-Segment Reachability violations, aligned with `segments` by index. */
  readonly violations: readonly (ReachabilityViolation | null)[];
  /** Violation of the pending draft preview, or null when none. */
  readonly draftViolation: ReachabilityViolation | null;
  /** Reachability of the Home Point, or null while unset. */
  readonly homeStatus: PointReachability | null;
}

/** Stroke and fill colours of the canvas scene. */
const COLORS = {
  background: "#fafafa",
  minorGrid: "#ececec",
  majorGrid: "#d8d8d8",
  axis: "#a8a8a8",
  segment: "#1a1a1a",
  home: "#1a7f37",
  draft: "#c46a00",
} as const;

/**
 * The colour a Reachability violation is flagged with, on the canvas
 * (violating Segments, draft preview, Home Point) and in the UI lists.
 */
export const VIOLATION_COLOR = "#c62b2b";

/** Half the size of an endpoint marker, in CSS pixels. */
const ENDPOINT_HALF_PX = 2.5;

/** Radius of the Home Point marker, in CSS pixels. */
const HOME_RADIUS_PX = 5;

/** Samples per drawn Arc. */
const ARC_SAMPLES = 48;

/**
 * Paints the whole scene onto `ctx`. Clears the canvas first and sets
 * the device-pixel-ratio context transform from the viewport, so a
 * redraw after a resize or DPR change always matches the live element.
 */
export function drawScene(ctx: CanvasRenderingContext2D, scene: CanvasScene): void {
  const { transform, plane, segments, home, draftStart, cursor, reachability, violations, draftViolation, homeStatus } = scene;
  const viewport = transform.viewport;
  const dpr = viewport.devicePixelRatio;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, viewport.widthPx, viewport.heightPx);

  drawReachability(ctx, transform, reachability);
  drawGrid(ctx, transform);
  for (const [i, segment] of segments.entries()) {
    const violation = violations[i] ?? null;
    drawSegment(ctx, transform, plane, segment, violation !== null);
  }
  if (home !== null) drawHome(ctx, transform, plane, home, homeStatus === "ok");
  drawDraft(ctx, transform, draftStart, cursor, draftViolation !== null);
}

/** One painted map cell: its screen rectangle (x, y, width, height). */
type CellRect = [number, number, number, number];

/**
 * Paints the Reachability map: one rectangle per lattice cell of the
 * sampler that intersects the visible world range, coloured by its
 * status. Cell statuses come from the sampler's cache, so a repaint
 * never re-runs inverse kinematics over sampled ground.
 */
function drawReachability(
  ctx: CanvasRenderingContext2D,
  transform: CanvasTransform,
  reachability: ReachabilitySampler,
): void {
  const bounds = worldBounds(transform);
  const cell = reachability.cellMm;
  const blocked: CellRect[] = [];
  const limited: CellRect[] = [];
  const allowed: CellRect[] = [];
  const rectsOf = (status: PointReachability): CellRect[] =>
    status === "ok" ? allowed : status === "unreachable" ? blocked : limited;
  // Cells strictly intersecting the visible range: the last index is
  // the cell containing the largest visible coordinate, so a boundary
  // that lands exactly on a cell edge does not paint the empty cell
  // beyond it.
  const lastI = Math.ceil(bounds.maxU / cell) - 1;
  const lastJ = Math.ceil(bounds.maxV / cell) - 1;
  for (let j = Math.floor(bounds.minV / cell); j <= lastJ; j++) {
    for (let i = Math.floor(bounds.minU / cell); i <= lastI; i++) {
      const x0 = Math.round(transform.toScreen(vec2(i * cell, 0)).x);
      const x1 = Math.round(transform.toScreen(vec2((i + 1) * cell, 0)).x);
      const yTop = Math.round(transform.toScreen(vec2(0, (j + 1) * cell)).y);
      const yBottom = Math.round(transform.toScreen(vec2(0, j * cell)).y);
      rectsOf(reachability.statusAt((i + 0.5) * cell, (j + 0.5) * cell)).push([
        x0,
        yTop,
        x1 - x0 + 1,
        yBottom - yTop + 1,
      ]);
    }
  }
  // Paint status by status (one fillStyle change each) and overdraw
  // each cell by one pixel so neighbours leave no seams.
  const layers: readonly {
    readonly status: PointReachability;
    readonly rects: readonly CellRect[];
  }[] = [
    { status: "unreachable", rects: blocked },
    { status: "angle-limit", rects: limited },
    { status: "ok", rects: allowed },
  ];
  for (const { status, rects } of layers) {
    if (rects.length === 0) continue;
    ctx.fillStyle = REACHABILITY_COLORS[status];
    ctx.beginPath();
    for (const [x, y, w, h] of rects) ctx.rect(x, y, w, h);
    ctx.fill();
  }
}

/** Draws the millimetre grid: minor and major lines plus the axes. */
function drawGrid(ctx: CanvasRenderingContext2D, transform: CanvasTransform): void {
  const bounds = worldBounds(transform);
  const grid = gridLinesMm(bounds);
  const top = transform.toScreen(vec2(0, bounds.maxV)).y;
  const bottom = transform.toScreen(vec2(0, bounds.minV)).y;
  const left = transform.toScreen(vec2(bounds.minU, 0)).x;
  const right = transform.toScreen(vec2(bounds.maxU, 0)).x;

  const lines = (us: readonly number[], vs: readonly number[], color: string): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const u of us) {
      const x = transform.toScreen(vec2(u, 0)).x;
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (const v of vs) {
      const y = transform.toScreen(vec2(0, v)).y;
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
  };

  lines(grid.minorU, grid.minorV, COLORS.minorGrid);
  lines(grid.majorU, grid.majorV, COLORS.majorGrid);

  // The u = 0 and v = 0 axes through the world origin.
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const origin = transform.toScreen(vec2(0, 0));
  ctx.moveTo(origin.x, top);
  ctx.lineTo(origin.x, bottom);
  ctx.moveTo(left, origin.y);
  ctx.lineTo(right, origin.y);
  ctx.stroke();
}

/** Projects a 3D world point into the plane view's CSS pixels. */
function project(transform: CanvasTransform, plane: WorkingPlane, p: Vec3): Vec2 {
  const coords = planeCoords(plane, p);
  return transform.toScreen(vec2(coords.u, coords.v));
}

/** Draws one canonical Segment: Line as a stroke, Arc sampled, Point as a cross. */
function drawSegment(
  ctx: CanvasRenderingContext2D,
  transform: CanvasTransform,
  plane: WorkingPlane,
  segment: Segment,
  violating: boolean,
): void {
  const color = violating ? VIOLATION_COLOR : COLORS.segment;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  if (segment.kind === "point") {
    drawCross(ctx, project(transform, plane, segment.target));
    return;
  }
  const ends = segmentEnds(segment);
  const points =
    segment.kind === "line"
      ? [ends.start, ends.end]
      : Array.from({ length: ARC_SAMPLES + 1 }, (_, i) => arcPointAt(segment, i / ARC_SAMPLES));
  ctx.beginPath();
  for (const [i, world] of points.entries()) {
    const px = project(transform, plane, world);
    if (i === 0) ctx.moveTo(px.x, px.y);
    else ctx.lineTo(px.x, px.y);
  }
  ctx.stroke();
  drawEndpoint(ctx, project(transform, plane, ends.start));
  drawEndpoint(ctx, project(transform, plane, ends.end));
}

/** Draws the Home Point marker: a filled disc with a cross through it. */
function drawHome(
  ctx: CanvasRenderingContext2D,
  transform: CanvasTransform,
  plane: WorkingPlane,
  home: Vec3,
  reachable: boolean,
): void {
  const px = project(transform, plane, home);
  const color = reachable ? COLORS.home : VIOLATION_COLOR;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(px.x, px.y, HOME_RADIUS_PX, 0, 2 * Math.PI);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(px.x - HOME_RADIUS_PX - 3, px.y);
  ctx.lineTo(px.x + HOME_RADIUS_PX + 3, px.y);
  ctx.moveTo(px.x, px.y - HOME_RADIUS_PX - 3);
  ctx.lineTo(px.x, px.y + HOME_RADIUS_PX + 3);
  ctx.stroke();
}

/** Draws the pending Line: start marker plus a dashed line to the cursor. */
function drawDraft(
  ctx: CanvasRenderingContext2D,
  transform: CanvasTransform,
  draftStart: Vec2 | null,
  cursor: Vec2 | null,
  violating: boolean,
): void {
  if (draftStart === null) return;
  const start = transform.toScreen(draftStart);
  const color = violating ? VIOLATION_COLOR : COLORS.draft;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  if (cursor !== null) {
    const px = transform.toScreen(cursor);
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(px.x, px.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.arc(start.x, start.y, 4, 0, 2 * Math.PI);
  ctx.stroke();
}

/** Draws a small square at a Segment endpoint. */
function drawEndpoint(ctx: CanvasRenderingContext2D, px: Vec2): void {
  ctx.fillRect(px.x - ENDPOINT_HALF_PX, px.y - ENDPOINT_HALF_PX, ENDPOINT_HALF_PX * 2, ENDPOINT_HALF_PX * 2);
}

/** Draws a small cross marking a Point Segment target. */
function drawCross(ctx: CanvasRenderingContext2D, px: Vec2): void {
  ctx.beginPath();
  ctx.moveTo(px.x - 4, px.y);
  ctx.lineTo(px.x + 4, px.y);
  ctx.moveTo(px.x, px.y - 4);
  ctx.lineTo(px.x, px.y + 4);
  ctx.stroke();
}
