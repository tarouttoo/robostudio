/**
 * Discretization (GLOSSARY.md): sampling a Trajectory into a dense
 * point path with cumulative path length — the input to kinematics.
 *
 * Contract:
 *
 * - Segments are sampled at equal fractions of their geometry with a
 *   spacing of at most `maxStepMm` (default 0.5 mm) along the path.
 * - A Segment join whose points are within `mergeDistanceMm`
 *   (default 1 mm) of each other is merged: the next Segment's start
 *   sample is dropped and the residual offset is folded into the join
 *   (treated as zero path length). This covers exact duplicates and
 *   float dust from consecutive drawing.
 * - `pathLengthMm` is cumulative pen travel from the Home Point:
 *   analytic along each Segment's geometry, Euclidean across transits.
 *   Transits — the approach from Home, gaps between Segments, and Point
 *   moves — are single-sample hops and are counted at full distance.
 * - The first sample of a non-empty path is the pen start pose
 *   (Home, or the first Segment's start when it coincides with Home
 *   within the merge distance).
 * - Every sample carries the Feed (mm/s) and index of the Segment being
 *   traversed; a merged Point changes no geometry and emits no sample.
 */

import { arcLengthMm, arcPointAt } from "./arc";
import type { Feed, Trajectory } from "./trajectory";
import { distance, lerp, type Vec3 } from "./vec";

/** Default maximum spacing between consecutive samples, in mm. */
export const DEFAULT_MAX_STEP_MM = 0.5;

/** Default join-merge distance: closer points count as one, in mm. */
export const DEFAULT_MERGE_DISTANCE_MM = 1;

/** Tuning for discretization. Defaults are the v1 pipeline constants. */
export interface DiscretizeOptions {
  /** Maximum spacing between consecutive samples along the path, mm. */
  readonly maxStepMm?: number;
  /** Join points closer than this count as one point, mm. */
  readonly mergeDistanceMm?: number;
}

/** One sampled point of the discretized path. */
export interface PathSample {
  /** Position in millimetres. */
  readonly position: Vec3;
  /** Cumulative pen travel from the Home Point to this position, mm. */
  readonly pathLengthMm: number;
  /** Feed of the Segment being traversed, mm/s. */
  readonly feed: Feed;
  /** Index of the Segment being traversed in `Trajectory.segments`. */
  readonly segmentIndex: number;
}

/** A Trajectory sampled into a dense point path. */
export interface DiscretizedPath {
  /** The Home Point the pen started from (also sample 0's origin). */
  readonly home: Vec3;
  /** Samples in traversal order; empty for a Trajectory with no Segments. */
  readonly samples: readonly PathSample[];
  /** Total cumulative pen travel, mm; equals the last sample's length. */
  readonly totalLengthMm: number;
}

/**
 * Samples a Trajectory into a `DiscretizedPath` at a fixed maximum step,
 * merging near-duplicate points at Segment joins. Pure function; the
 * Trajectory's Segments are already validated at construction.
 */
export function discretizeTrajectory(
  traj: Trajectory,
  options?: DiscretizeOptions,
): DiscretizedPath {
  const maxStepMm = options?.maxStepMm ?? DEFAULT_MAX_STEP_MM;
  const mergeDistanceMm = options?.mergeDistanceMm ?? DEFAULT_MERGE_DISTANCE_MM;
  if (!(Number.isFinite(maxStepMm) && maxStepMm > 0)) {
    throw new RangeError(`maxStepMm must be a positive number of mm, got ${maxStepMm}`);
  }
  if (!(Number.isFinite(mergeDistanceMm) && mergeDistanceMm >= 0)) {
    throw new RangeError(`mergeDistanceMm must be a non-negative number of mm, got ${mergeDistanceMm}`);
  }

  const samples: PathSample[] = [];
  const emit = (position: Vec3, pathLengthMm: number, feed: Feed, segmentIndex: number): void => {
    samples.push({ position, pathLengthMm, feed, segmentIndex });
  };

  let base = 0; // cumulative length at the current segment's start
  let pen = traj.home;

  traj.segments.forEach((seg, index) => {
    if (seg.kind === "point") {
      const hop = distance(pen, seg.target);
      if (hop > mergeDistanceMm) {
        // Transit: keep the start pose when it is not on file yet, then
        // arrive at the target.
        if (samples.length === 0) emit(pen, base, seg.feed, index);
        base += hop;
        emit(seg.target, base, seg.feed, index);
      } else if (samples.length === 0) {
        // The target stands in for the Home Point as the start pose.
        emit(seg.target, base, seg.feed, index);
      }
      pen = seg.target;
      return;
    }

    const hop = distance(pen, seg.start);
    const joined = hop <= mergeDistanceMm;
    if (!joined && samples.length === 0) {
      // Approach transit from Home: keep the start pose first.
      emit(pen, base, seg.feed, index);
    }
    if (!joined) base += hop; // the transit counts at full distance
    const lengthMm =
      seg.kind === "line" ? distance(seg.start, seg.end) : arcLengthMm(seg);
    const n = Math.max(1, Math.ceil(lengthMm / maxStepMm));
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      // A joined start sample duplicates the previous segment's end.
      if (i === 0 && joined && samples.length > 0) continue;
      const position = seg.kind === "line" ? lerp(seg.start, seg.end, f) : arcPointAt(seg, f);
      emit(position, base + f * lengthMm, seg.feed, index);
    }
    base += lengthMm;
    pen = seg.end;
  });

  const last = samples.at(-1);
  return {
    home: traj.home,
    samples,
    totalLengthMm: last !== undefined ? last.pathLengthMm : 0,
  };
}
