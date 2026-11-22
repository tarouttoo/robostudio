/**
 * Vector primitives for the math core. Pure functions over immutable
 * records; no runtime dependencies (ADR 0004).
 */

/** A 2D coordinate, e.g. the in-plane projection of a point. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** A 3D point or direction in millimetres (world coordinates). */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Builds a 2D coordinate. */
export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

/** Builds a 3D point. */
export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/** Component-wise sum of two vectors. */
export function add(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x + b.x, a.y + b.y, a.z + b.z);
}

/** Component-wise difference `a − b`. */
export function sub(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Scalar multiplication. */
export function scale(a: Vec3, s: number): Vec3 {
  return vec3(a.x * s, a.y * s, a.z * s);
}

/** Euclidean length of a vector. */
export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

/** Euclidean distance between two points (a Vec2 is treated as z = 0). */
export function distance(a: Vec2 | Vec3, b: Vec2 | Vec3): number {
  const az = "z" in a ? a.z : 0;
  const bz = "z" in b ? b.z : 0;
  return Math.hypot(a.x - b.x, a.y - b.y, az - bz);
}

/** Linear interpolation from `a` (t = 0) to `b` (t = 1). */
export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}
