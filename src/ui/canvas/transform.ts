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
 * Builds the canvas transform for a measured viewport. The world origin
 * sits at the viewport centre; the scale is uniform (one number for both
 * axes), so equal world extents map to equal pixel extents at any
 * viewport size or device pixel ratio.
 */
export function makeCanvasTransform(
  viewport: Viewport,
  pxPerMm: number = DEFAULT_PX_PER_MM,
): CanvasTransform {
  const originX = viewport.widthPx / 2;
  const originY = viewport.heightPx / 2;
  return {
    viewport,
    pxPerMm,
    toScreen: (p) => vec2(originX + p.x * pxPerMm, originY - p.y * pxPerMm),
    toWorld: (p) => vec2((p.x - originX) / pxPerMm, (originY - p.y) / pxPerMm),
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
