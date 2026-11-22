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
  const { transform, plane, segments, home, draftStart, cursor } = scene;
  const viewport = transform.viewport;
  const dpr = viewport.devicePixelRatio;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, viewport.widthPx, viewport.heightPx);

  drawGrid(ctx, transform);
  for (const segment of segments) drawSegment(ctx, transform, plane, segment);
  if (home !== null) drawHome(ctx, transform, plane, home);
  drawDraft(ctx, transform, draftStart, cursor);
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
): void {
  ctx.strokeStyle = COLORS.segment;
  ctx.fillStyle = COLORS.segment;
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
): void {
  const px = project(transform, plane, home);
  ctx.strokeStyle = COLORS.home;
  ctx.fillStyle = COLORS.home;
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
): void {
  if (draftStart === null) return;
  const start = transform.toScreen(draftStart);
  ctx.strokeStyle = COLORS.draft;
  ctx.fillStyle = COLORS.draft;
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
