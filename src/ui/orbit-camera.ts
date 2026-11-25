/**
 * The Orbit Camera: the hand-rolled 3D view math behind the Motion
 * Preview dialog's interactive viewport (drag = orbit, wheel = dolly,
 * reset = the default isometric fit). Pure functions over an immutable
 * record — no DOM, no canvas, no time, no state outside the passed
 * record — in the drawing-canvas camera tradition (ADR 0007), pinned by
 * headless tests. No new runtime dependencies, no three.js (ADR 0004).
 *
 * Conventions. World space is scene millimetres, Z up (the robot
 * model's frame). Screen space is CSS pixels, y growing down. `yaw` is
 * the azimuth of the view direction around +Z, measured from +X toward
 * +Y, unbounded (free spin); `pitch` is the view direction's downward
 * tilt — the camera elevation — clamped strictly inside the poles so
 * the camera cannot flip through them. The projection is orthographic
 * with one uniform mm→px scale (equal aspect, ADR 0007's
 * anti-distortion discipline), and the default angles reproduce the
 * charts' isometric convention (ADR 0013) up to that one scale — so
 * the reset view is exactly the GIF's fixed camera.
 */

import { vec3, type Vec3 } from "../core";
import { domain } from "../export/charts";

/**
 * The live size of the viewport in CSS pixels, measured by the caller
 * on every resize. The device pixel ratio is deliberately absent: it
 * affects only the canvas backing store, never the CSS-pixel mapping
 * (the canvas transform's reasoning, ADR 0007).
 */
export interface Viewport {
  /** Viewport width in CSS pixels. */
  readonly widthPx: number;
  /** Viewport height in CSS pixels. */
  readonly heightPx: number;
}

/** A scene bounding box in millimetres (world coordinates, Z up). */
export interface MmBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * The camera state: what the viewport shows. Immutable — every
 * function below returns a new record; nothing mutates in place.
 */
export interface OrbitCamera {
  /** The viewport this camera was fitted to; its centre is the projection origin. */
  readonly viewport: Viewport;
  /** The scene point (mm) shown at the viewport centre — the orbit and dolly pivot. */
  readonly target: Vec3;
  /** Orbit angle: azimuth of the view direction around +Z, radians, from +X toward +Y, unbounded. */
  readonly yaw: number;
  /** Orbit angle: downward tilt of the view direction (camera elevation), radians, clamped inside the poles. */
  readonly pitch: number;
  /** Dolly distance from the target, millimetres, clamped into [MIN_DISTANCE_MM, MAX_DISTANCE_MM]. */
  readonly distanceMm: number;
  /** The orthographic scale: CSS pixels per screen millimetre, one number for both axes. */
  readonly scalePxPerMm: number;
}

/**
 * Default yaw: the isometric view looks from the (−, −, +) octant
 * toward +x+y, i.e. along azimuth 45°. Derived from the charts'
 * `projectIsometric` (`right = (x−y)·cos30`, `up = z + (x+y)·sin30`),
 * whose orthographic view direction is (1, 1, −1)/√3.
 */
export const DEFAULT_YAW_RAD = Math.atan2(1, 1);

/**
 * Default pitch: the isometric elevation — the view direction
 * (1, 1, −1)/√3 tilts down by asin(1/√3) ≈ 35.26°.
 */
export const DEFAULT_PITCH_RAD = Math.asin(1 / Math.sqrt(3));

/**
 * The pitch clamp: strictly inside the poles, so the screen-up basis
 * vector keeps a positive world-Z component and the view never flips
 * through vertical.
 */
export const MAX_PITCH_RAD = Math.PI / 2 - 0.05;

/** Smallest allowed dolly distance, in millimetres. */
export const MIN_DISTANCE_MM = 1;

/** Largest allowed dolly distance, in millimetres. */
export const MAX_DISTANCE_MM = 20_000;

/**
 * Orbit speed: radians of yaw or pitch per CSS pixel of drag. A
 * 1000-px drag turns the view by a full circle.
 */
export const ROTATE_RADIANS_PER_PIXEL = Math.PI / 500;

/** Dolly ratio per wheel notch: each notch multiplies (or divides) the distance by this. */
export const ZOOM_FACTOR_PER_NOTCH = 1.1;

/** Wheel `deltaY` of one notch in the DOM's pixel convention (Chrome/Chromium ±100). */
export const ZOOM_NOTCH_DELTA_Y = 100;

/** Clamps a dolly distance into the bounded range. */
function clampDistance(distanceMm: number): number {
  return Math.min(MAX_DISTANCE_MM, Math.max(MIN_DISTANCE_MM, distanceMm));
}

/** Clamps a pitch inside the poles. */
function clampPitch(pitch: number): number {
  return Math.min(MAX_PITCH_RAD, Math.max(-MAX_PITCH_RAD, pitch));
}

/** The unit view direction: azimuth `yaw`, tilted down by `pitch`. */
function forwardOf(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return vec3(cp * Math.cos(yaw), cp * Math.sin(yaw), -Math.sin(pitch));
}

/** The unit screen-right direction: horizontal, orthogonal to the view direction. */
function rightOf(yaw: number): Vec3 {
  return vec3(Math.sin(yaw), -Math.cos(yaw), 0);
}

/**
 * The unit screen-up direction — `right × forward`, orthogonal to
 * both, with a strictly positive world-Z component inside the pitch
 * clamp (the horizon never leaves the view).
 */
function upOf(yaw: number, pitch: number): Vec3 {
  return vec3(Math.cos(yaw) * Math.sin(pitch), Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch));
}

/**
 * The screen-mm extents (at unit scale) of a box projected through the
 * camera's orientation, per screen axis, padded when degenerate with
 * the charts' `domain()` — one padding convention for every isometric
 * view, so a single-point or flat scene never collapses the fit scale
 * to NaN/Infinity.
 */
function screenExtents(camera: OrbitCamera, bounds: MmBounds): readonly [number, number, number, number] {
  const r = rightOf(camera.yaw);
  const u = upOf(camera.yaw, camera.pitch);
  let rLo = Infinity;
  let rHi = -Infinity;
  let uLo = Infinity;
  let uHi = -Infinity;
  for (let bits = 0; bits < 8; bits++) {
    const dx = (bits & 1 ? bounds.maxX : bounds.minX) - camera.target.x;
    const dy = (bits & 2 ? bounds.maxY : bounds.minY) - camera.target.y;
    const dz = (bits & 4 ? bounds.maxZ : bounds.minZ) - camera.target.z;
    const rv = dx * r.x + dy * r.y + dz * r.z;
    const uv = dx * u.x + dy * u.y + dz * u.z;
    rLo = Math.min(rLo, rv);
    rHi = Math.max(rHi, rv);
    uLo = Math.min(uLo, uv);
    uHi = Math.max(uHi, uv);
  }
  const [rLoPadded, rHiPadded] = domain(rLo, rHi);
  const [uLoPadded, uHiPadded] = domain(uLo, uHi);
  return [rLoPadded, rHiPadded, uLoPadded, uHiPadded];
}

/**
 * The default camera: the charts' isometric convention fitted to a
 * scene's millimetre bounding box inside a viewport. Degenerate box
 * extents pad (never divide by zero); the dolly distance defaults to
 * one padded scene diagonal, clamped into the bounded range; the fit
 * is equal-aspect — one uniform mm→px scale, the limiting axis fills
 * the viewport, the other centers — so the box's centre lands at the
 * viewport centre. This is the view the dialog's reset restores.
 */
export function defaultOrbitCamera(bounds: MmBounds, viewport: Viewport): OrbitCamera {
  const target = vec3(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  );
  // Degenerate extents pad instead of collapsing the fit (the charts'
  // domain(), one convention for every isometric view); the padding is
  // symmetric, so the target stays the padded box's centre.
  const [minX, maxX] = domain(bounds.minX, bounds.maxX);
  const [minY, maxY] = domain(bounds.minY, bounds.maxY);
  const [minZ, maxZ] = domain(bounds.minZ, bounds.maxZ);
  const padded: MmBounds = { minX, maxX, minY, maxY, minZ, maxZ };
  const diagonalMm = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const unit: OrbitCamera = {
    viewport,
    target,
    yaw: DEFAULT_YAW_RAD,
    pitch: DEFAULT_PITCH_RAD,
    distanceMm: clampDistance(diagonalMm),
    scalePxPerMm: 1,
  };
  // Equal-aspect fit (ADR 0007): the projected box gets one mm→px
  // scale — the limiting screen axis fills the viewport exactly, the
  // other centers, because the target projects to the extents' centre.
  const [rLo, rHi, uLo, uHi] = screenExtents(unit, padded);
  return {
    ...unit,
    scalePxPerMm: Math.min(viewport.widthPx / (rHi - rLo), viewport.heightPx / (uHi - uLo)),
  };
}

/**
 * Orbits the camera by a pointer-drag delta in CSS pixels: yaw from the
 * horizontal drag (unbounded — free spin around Z), pitch from the
 * vertical drag, clamped inside the poles. Grab feel: the scene
 * follows the cursor — dragging right turns the scene's front
 * rightward (yaw decreases), dragging down tips the top toward the
 * operator (pitch increases). No inertia.
 */
export function orbitCamera(camera: OrbitCamera, dxPx: number, dyPx: number): OrbitCamera {
  return {
    ...camera,
    yaw: camera.yaw - dxPx * ROTATE_RADIANS_PER_PIXEL,
    pitch: clampPitch(camera.pitch + dyPx * ROTATE_RADIANS_PER_PIXEL),
  };
}

/**
 * Dollies the camera by a wheel delta: positive `deltaY` (wheel down)
 * moves away from the target, negative moves closer. The dolly
 * distance is multiplicative per notch and clamped into the bounded
 * range; the orthographic scale follows the realized dolly inversely —
 * dollying in magnifies the view exactly by the distance ratio, and a
 * wheel at a clamp leaves the record unchanged.
 */
export function zoomCamera(camera: OrbitCamera, deltaY: number): OrbitCamera {
  const ratio = Math.pow(ZOOM_FACTOR_PER_NOTCH, deltaY / ZOOM_NOTCH_DELTA_Y);
  const distanceMm = clampDistance(camera.distanceMm * ratio);
  return {
    ...camera,
    distanceMm,
    scalePxPerMm: camera.scalePxPerMm * (camera.distanceMm / distanceMm),
  };
}

/**
 * Resets to the default isometric fit of the whole scene — «Вписать» /
 * double-click. Exactly {@link defaultOrbitCamera} of the bounds in the
 * camera's own viewport: a fresh default record, no residue of the
 * explored view.
 */
export function resetOrbitCamera(camera: OrbitCamera, bounds: MmBounds): OrbitCamera {
  return defaultOrbitCamera(bounds, camera.viewport);
}

/**
 * Projects a scene point (mm) to CSS pixels, y growing down.
 * Orthographic through the camera's yaw/pitch basis at one uniform
 * mm→px scale, with the target at the viewport centre. Pure: the same
 * camera and point always project to the same pixel.
 */
export function projectOrbit(camera: OrbitCamera, p: Vec3): readonly [number, number] {
  const dx = p.x - camera.target.x;
  const dy = p.y - camera.target.y;
  const dz = p.z - camera.target.z;
  const r = rightOf(camera.yaw);
  const u = upOf(camera.yaw, camera.pitch);
  return [
    camera.viewport.widthPx / 2 + camera.scalePxPerMm * (dx * r.x + dy * r.y + dz * r.z),
    camera.viewport.heightPx / 2 - camera.scalePxPerMm * (dx * u.x + dy * u.y + dz * u.z),
  ];
}

/**
 * The view-space depth of a scene point (mm): its distance from the
 * camera's eye plane along the view direction — larger is farther.
 * The sort key for painter's-algorithm drawing: sort descending, draw
 * farthest first. For fixed angles the depth *order* is independent of
 * the dolly distance and scale (the distance shifts every depth by the
 * same constant).
 */
export function depthOrbit(camera: OrbitCamera, p: Vec3): number {
  const f = forwardOf(camera.yaw, camera.pitch);
  const dx = p.x - camera.target.x;
  const dy = p.y - camera.target.y;
  const dz = p.z - camera.target.z;
  return dx * f.x + dy * f.y + dz * f.z + camera.distanceMm;
}
