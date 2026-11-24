/**
 * Canvas world↔screen transform (ADR 0007): the projection is a pure
 * function of the live canvas viewport — never of constants captured at
 * startup. The caller measures the canvas element on every resize and
 * passes the resulting {@link Viewport} record to
 * {@link makeCanvasTransform}; the mapping derives from that record
 * alone, so a window resize or a device-pixel-ratio change cannot
 * desynchronize clicks from drawn geometry (the prototype's distortion
 * bug class, removed by construction).
 *
 * World coordinates here are Working Plane coordinates (u, v) in
 * millimetres, v pointing up; screen coordinates are CSS pixels with y
 * pointing down. The device pixel ratio affects only the backing-store
 * resolution (see {@link backingSize}); the CSS-pixel mapping is
 * identical on every display.
 */

import { vec2, type Vec2 } from "../../core";

/** Default drawing scale: CSS pixels per millimetre. */
export const DEFAULT_PX_PER_MM = 4;

/** Smallest allowed zoom: CSS pixels per millimetre. */
export const MIN_PX_PER_MM = 0.5;

/** Largest allowed zoom: CSS pixels per millimetre. */
export const MAX_PX_PER_MM = 20;

/**
 * The scale and pan offset state of the canvas view (issue #44): what
 * the viewport shows, independent of the viewport's live size. The
 * transform (ADR 0007) is a pure function of the viewport plus this
 * record, so a resize or device-pixel-ratio change cannot move what is
 * drawn relative to the world — the zoom and pan survive both.
 */
export interface Camera {
  /** Scale: CSS pixels per millimetre, within [MIN, MAX] px/mm. */
  readonly pxPerMm: number;
  /** The Working Plane point (mm) shown at the viewport centre — the pan offset. */
  readonly center: Vec2;
}

/** The camera matching the pre-issue mapping: origin centred at 4 px/mm. */
export const DEFAULT_CAMERA: Camera = { pxPerMm: DEFAULT_PX_PER_MM, center: vec2(0, 0) };

/** Clamps a scale into the bounded px/mm range. */
function clampScale(pxPerMm: number): number {
  return Math.min(MAX_PX_PER_MM, Math.max(MIN_PX_PER_MM, pxPerMm));
}

/**
 * The live size of the canvas element in CSS pixels, plus the device
 * pixel ratio at measurement time. Re-measured on every resize; the
 * only input of the canvas transform.
 */
export interface Viewport {
  /** Canvas element width in CSS pixels. */
  readonly widthPx: number;
  /** Canvas element height in CSS pixels. */
  readonly heightPx: number;
  /** Device pixel ratio at measurement time. */
  readonly devicePixelRatio: number;
}

/**
 * The world↔screen mapping derived from a {@link Viewport}. Pure: the
 * same viewport always yields the same mapping, and the mapping carries
 * no mutable state.
 */
export interface CanvasTransform {
  /** The viewport this mapping was derived from. */
  readonly viewport: Viewport;
  /** Scale: CSS pixels per millimetre. */
  readonly pxPerMm: number;
  /** Projects Working Plane millimetres (u, v) to CSS pixels. */
  readonly toScreen: (p: Vec2) => Vec2;
  /** Unprojects CSS pixels to Working Plane millimetres (u, v). */
  readonly toWorld: (p: Vec2) => Vec2;
}

/**
 * Builds the canvas transform for a measured viewport and camera. The
 * camera's centre sits at the viewport centre and the scale is uniform
 * (one number for both axes), so equal world extents map to equal
 * pixel extents at any viewport size, camera, or device pixel ratio.
 * Called without a camera it reproduces the pre-issue mapping
 * ({@link DEFAULT_CAMERA}), so existing callers are unaffected.
 */
export function makeCanvasTransform(
  viewport: Viewport,
  camera: Camera = DEFAULT_CAMERA,
): CanvasTransform {
  const originX = viewport.widthPx / 2 - camera.center.x * camera.pxPerMm;
  const originY = viewport.heightPx / 2 + camera.center.y * camera.pxPerMm;
  return {
    viewport,
    pxPerMm: camera.pxPerMm,
    toScreen: (p) => vec2(originX + p.x * camera.pxPerMm, originY - p.y * camera.pxPerMm),
    toWorld: (p) => vec2((p.x - originX) / camera.pxPerMm, (originY - p.y) / camera.pxPerMm),
  };
}

/**
 * The camera that fits a Working Plane millimetre rectangle (such as a
 * Reachability zone's bounds) into the viewport: the scale is the
 * smaller of the two axis ratios, clamped into the bounded px/mm range,
 * and the rectangle's centre lands at the viewport centre. A degenerate
 * (single-point) rectangle fits centred at the clamped scale.
 */
export function fitCamera(viewport: Viewport, zone: WorldBounds): Camera {
  const widthMm = zone.maxU - zone.minU;
  const heightMm = zone.maxV - zone.minV;
  const pxPerMm = clampScale(
    Math.min(viewport.widthPx / widthMm, viewport.heightPx / heightMm),
  );
  return {
    pxPerMm,
    center: vec2((zone.minU + zone.maxU) / 2, (zone.minV + zone.maxV) / 2),
  };
}

/**
 * Zooms a camera to the given scale, anchored at a viewport pixel: the
 * world point under `screenPx` stays under it after the zoom, so the
 * geometry the cursor rests on does not shift. The scale is clamped
 * into the bounded px/mm range first — the anchor holds at the bounds.
 */
export function zoomAtCamera(camera: Camera, viewport: Viewport, pxPerMm: number, screenPx: Vec2): Camera {
  const nextPxPerMm = clampScale(pxPerMm);
  const underCursor = makeCanvasTransform(viewport, camera).toWorld(screenPx);
  return {
    pxPerMm: nextPxPerMm,
    center: vec2(
      underCursor.x - (screenPx.x - viewport.widthPx / 2) / nextPxPerMm,
      underCursor.y + (screenPx.y - viewport.heightPx / 2) / nextPxPerMm,
    ),
  };
}

/**
 * Pans a camera by a pointer drag given in CSS pixels: the world point
 * under the drag start lands at `dPx` after it. Only the centre moves —
 * a pan never rescales.
 */
export function panCameraBy(camera: Camera, dPx: Vec2): Camera {
  return {
    pxPerMm: camera.pxPerMm,
    center: vec2(camera.center.x - dPx.x / camera.pxPerMm, camera.center.y + dPx.y / camera.pxPerMm),
  };
}

/** The range of Working Plane millimetres visible in the viewport. */
export interface WorldBounds {
  /** Smallest visible u, in millimetres. */
  readonly minU: number;
  /** Largest visible u, in millimetres. */
  readonly maxU: number;
  /** Smallest visible v, in millimetres. */
  readonly minV: number;
  /** Largest visible v, in millimetres. */
  readonly maxV: number;
}

/** Computes the Working Plane millimetre range currently visible. */
export function worldBounds(t: CanvasTransform): WorldBounds {
  const topLeft = t.toWorld(vec2(0, 0));
  const bottomRight = t.toWorld(vec2(t.viewport.widthPx, t.viewport.heightPx));
  return { minU: topLeft.x, maxU: bottomRight.x, minV: bottomRight.y, maxV: topLeft.y };
}

/**
 * The canvas backing-store size in device pixels for a viewport: the
 * CSS size scaled by the device pixel ratio, rounded, never smaller
 * than 1×1 (a collapsed element must still yield a valid canvas).
 * Drawing happens in CSS pixels after the caller applies the ratio as a
 * context transform, so geometry is independent of the display.
 */
export function backingSize(viewport: Viewport): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(viewport.widthPx * viewport.devicePixelRatio)),
    height: Math.max(1, Math.round(viewport.heightPx * viewport.devicePixelRatio)),
  };
}
