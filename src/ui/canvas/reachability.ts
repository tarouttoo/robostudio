/**
 * The live Reachability map behind the drawing canvas: the Working
 * Plane sampled on a millimetre lattice against the Robot Model, one
 * classification per lattice cell. Every answered cell is memoized, so
 * redraws and resizes never re-run inverse kinematics over ground
 * already covered — the map stays responsive while drawing. Recolouring
 * triggers when the map's inputs change: a fresh sampler is created per
 * (Robot Model, plane, fixed coordinate), which is exactly the plane
 * and fixed-coordinate change the operator makes.
 */

import { planePoint, type WorkingPlane } from "../../core";
import {
  checkPointReachability,
  type PointReachability,
} from "../../kinematics/reachability";
import type { RobotModel } from "../../kinematics/robot-model";

/** Edge length of one map cell, in millimetres. */
export const REACHABILITY_CELL_MM = 5;

/** Display colours of the map statuses, shared by the canvas layer and the UI legend. */
export const REACHABILITY_COLORS: Record<PointReachability, string> = {
  ok: "#e2efe2",
  unreachable: "#f6d0cb",
  "angle-limit": "#f2e2bc",
};

/** The sampled Reachability map over the operator's Working Plane. */
export interface ReachabilitySampler {
  /** Lattice cell edge length, in millimetres. */
  readonly cellMm: number;

  /**
   * Reachability of the lattice cell containing plane point (u, v) in
   * millimetres: the cell is classified once by its centre, then every
   * query inside it answers from the cache.
   */
  statusAt(u: number, v: number): PointReachability;
}

/**
 * Builds a Reachability map over the given Working Plane at the given
 * fixed coordinate, sampling cells of {@link REACHABILITY_CELL_MM} mm
 * (or the `cellMm` override) against the Robot Model.
 */
export function createReachabilitySampler(
  model: RobotModel,
  plane: WorkingPlane,
  fixedMm: number,
  cellMm: number = REACHABILITY_CELL_MM,
): ReachabilitySampler {
  const cells = new Map<string, PointReachability>();

  const statusAt = (u: number, v: number): PointReachability => {
    const i = Math.floor(u / cellMm);
    const j = Math.floor(v / cellMm);
    const key = `${i}:${j}`;
    const cached = cells.get(key);
    if (cached !== undefined) return cached;
    // Classify by the cell centre: the lattice cell is small enough
    // (5 mm) that its centre represents the whole cell.
    const centre = planePoint(plane, (i + 0.5) * cellMm, (j + 0.5) * cellMm, fixedMm);
    const status = checkPointReachability(model, [centre.x, centre.y, centre.z]);
    cells.set(key, status);
    return status;
  };

  return { cellMm, statusAt };
}
