/**
 * The Preview Scene (Сцена предпросмотра): one headless scene document
 * in millimetres, assembled at Generation time by pure functions from
 * the Trajectory, its Motion Plan, and the Robot Model — the seam both
 * Motion Preview renderers consume.
 *
 * {@link buildPreviewScene} carries the scene-assembly disciplines of
 * the Motion Preview (ADR 0018) into pure mm-space data:
 *
 * - **Per-Segment polylines** of the drawn Trajectory: the
 *   Discretization's consecutive per-Segment runs in traversal order,
 *   flagged LIN/PTP (dashed semantics, ADR 0017), each sample carrying
 *   its plan time derived linearly in arc length from the Segment's
 *   {@link MotionPlan.ranges} window — the Motion Profile is nonlinear
 *   in time, so this time is a schedule cue for the renderers'
 *   time-gradient coloring, pinned by golden tests, not a row time;
 * - **Sampled moments**: the plan rows (one per row, capped at
 *   {@link MOTION_PREVIEW_MAX_FRAMES} by even row spacing), each with
 *   the robot chain skeleton in mm (`RobotModel.chainPoints`,
 *   `joints.length + 2` points — ADR 0018's skeleton seam), the TCP
 *   position (the chain's last point, per-frame forward kinematics),
 *   and the travelled extent per plan range — the drawn sample nearest
 *   the frame's FK TCP (LIN Moves track the drawn geometry exactly,
 *   ADR 0017; completion judged against `min(endMs, durationMs)`, the
 *   grid-rounded duration can sit one control step short of the last
 *   range's unrounded end; a PTP Move contributes no highlight, ADR
 *   0016/0017);
 * - **PTP TCP trace runs**: runs of consecutive sampled moments
 *   traversing one PTP Move, as moment-index arrays — a PTP Move
 *   guarantees only arrival, so the actual TCP path is the FK path
 *   (ADR 0016/0017);
 * - the **Home Point** (Trajectory home, mm) and the **scene bounds** —
 *   the mm bounding box over the trajectory polylines, all chain
 *   points, and the Home Point — the box every camera of the scene
 *   fits against.
 *
 * Pure mm-space data: no projection, no rasterization, no DOM/canvas
 * work — turning the document into pixels is a renderer's job.
 * Identical inputs yield identical documents (the ADR 0006 golden
 * discipline applied to the scene's millimetre geometry).
 */

import { discretizeTrajectory, type DiscretizedPath } from "../core/discretize";
import type { Segment, Trajectory } from "../core/trajectory";
import type { Vec3 as CoreVec3 } from "../core/vec";
import type { RobotModel, Vec3 } from "../kinematics/robot-model";
import type { MotionPlan, MotionRow, PlanSegmentRange } from "../motion/planner";

/** Converts a core point (object shape) to the kinematics tuple shape. */
function asTuple(p: CoreVec3): Vec3 {
  return [p.x, p.y, p.z];
}

/** Moment budget: at most this many sampled moments, evenly paced. */
export const MOTION_PREVIEW_MAX_FRAMES = 300;

/** Slack on completion comparisons, absorbing float dust on range ends. */
const TIME_SLACK_MS = 1e-9;

/**
 * One Segment's drawn polyline in the scene, in millimetres: the
 * Discretization's consecutive samples of one Segment (a merged-away
 * Segment contributes no samples and no polyline).
 */
export interface PreviewSceneSegment {
  /** Index of the Segment in `Trajectory.segments`. */
  readonly segmentIndex: number;
  /** PTP Move (dashed semantics; only arrival guaranteed) or drawn geometry (solid). */
  readonly isPtp: boolean;
  /** The Segment's sampled 3D positions, in traversal order. */
  readonly mm: readonly Vec3[];
  /**
   * Plan time per sample, aligned with `mm`: the Segment's range window
   * (`plan.ranges`) spread linearly over the polyline's arc length. The
   * Motion Profile is nonlinear in time, so this is a schedule cue for
   * the renderers' time-gradient coloring, not a plan row time.
   */
  readonly tMs: readonly number[];
}

/** One sampled moment of the Motion Plan inside the scene. */
export interface PreviewSceneMoment {
  /** The sampled plan time, in milliseconds. */
  readonly tMs: number;
  /** The robot chain skeleton in mm (`joints.length + 2` points, ADR 0018). */
  readonly chainMm: readonly Vec3[];
  /** The TCP position in mm (the chain's last point, per-frame FK). */
  readonly tcpMm: Vec3;
  /**
   * Travelled extent per plan range, aligned with `plan.ranges`: how
   * many of that range's Segment polyline samples are travelled at this
   * moment (0 under a PTP Move — only arrival is guaranteed, ADR 0016).
   * Raw counts: a count below 2 spans nothing drawable; the renderer
   * decides what to stroke.
   */
  readonly travelled: readonly number[];
}

/** The scene's mm bounding box, componentwise over the scene's points. */
export interface PreviewSceneBounds {
  /** Componentwise minimum over trajectory polylines, chains, and home. */
  readonly min: Vec3;
  /** Componentwise maximum over the same points. */
  readonly max: Vec3;
}

/**
 * The Preview Scene document: the millimetre-space scene both Motion
 * Preview renderers draw — the GIF renderer through the fixed isometric
 * camera, the playback dialog through its own camera.
 */
export interface PreviewScene {
  /** Per-Segment polylines of the drawn Trajectory, in traversal order. */
  readonly segments: readonly PreviewSceneSegment[];
  /** Sampled plan moments, at most {@link MOTION_PREVIEW_MAX_FRAMES}. */
  readonly moments: readonly PreviewSceneMoment[];
  /** Runs of consecutive moment indices traversing one PTP Move. */
  readonly traceRuns: readonly (readonly number[])[];
  /** The Home Point (Trajectory home), in millimetres. */
  readonly homeMm: Vec3;
  /** The scene's mm bounding box: trajectory + chains + home. */
  readonly boundsMm: PreviewSceneBounds;
}

/** Preview Scene input: the Trajectory, its Motion Plan, and the Robot Model. */
export interface PreviewSceneInput {
  /** The Trajectory the plan was generated from. */
  readonly trajectory: Trajectory;
  /** The validated Motion Plan (the pipeline's output). */
  readonly plan: MotionPlan;
  /** The Robot Model solving the chain skeleton per moment. */
  readonly model: RobotModel;
}

/**
 * Assembles the Preview Scene from the Trajectory, its Motion Plan, and
 * the Robot Model. Pure function; identical inputs yield identical
 * documents. Assumes the pipeline's validated shapes: plan rows on the
 * control grid, ranges chaining from 0 to the plan duration, one range
 * per Segment with a positive span (a merged-away Segment has no
 * polyline and no range — both skip silently).
 */
export function buildPreviewScene(input: PreviewSceneInput): PreviewScene {
  const sampledRows = samplePlanRows(input.plan);
  const path = discretizeTrajectory(input.trajectory);
  const ptp = ptpSegmentIndices(input.trajectory.segments);
  const polylines = segmentPolylines(path);
  const rangeBySegment = rangesBySegment(input.plan);

  const segments = polylines.map((polyline) => ({
    segmentIndex: polyline.segmentIndex,
    isPtp: ptp.has(polyline.segmentIndex),
    mm: polyline.mm,
    tMs: sampleTimesMs(polyline, input.plan, rangeBySegment.get(polyline.segmentIndex)),
  }));

  // The robot skeleton per sampled moment, in model-frame millimetres.
  const chains = sampledRows.map((row) => input.model.chainPoints(row.q));
  const traceRuns = collectTraceRuns(sampledRows, ptp);
  const moments = sampledRows.map((row, index) => {
    const chainMm = chains[index] as Vec3[];
    const tcpMm = chainMm[chainMm.length - 1] as Vec3;
    return {
      tMs: row.tMs,
      chainMm,
      tcpMm,
      travelled: travelledCounts(input.plan, row, tcpMm, polylines, ptp),
    };
  });

  const homeMm = asTuple(input.trajectory.home);
  return {
    segments,
    moments,
    traceRuns,
    homeMm,
    boundsMm: sceneBounds(segments, chains, homeMm),
  };
}

/**
 * Samples the plan rows: one moment per row, capped at the moment
 * budget by even row spacing.
 */
function samplePlanRows(plan: MotionPlan): readonly MotionRow[] {
  const n = plan.rows.length;
  if (n <= MOTION_PREVIEW_MAX_FRAMES) return plan.rows;
  const last = n - 1;
  return Array.from(
    { length: MOTION_PREVIEW_MAX_FRAMES },
    (_, i) => plan.rows[Math.round((i * last) / (MOTION_PREVIEW_MAX_FRAMES - 1))] as MotionRow,
  );
}

/** The segment indices carrying a PTP Move (dashed; arrival only). */
function ptpSegmentIndices(segments: readonly Segment[]): ReadonlySet<number> {
  const set = new Set<number>();
  segments.forEach((segment, index) => {
    if (segment.kind === "point" && segment.motionType === "PTP") set.add(index);
  });
  return set;
}

/**
 * One Segment's polyline under assembly: the grouped mm samples plus
 * each sample's cumulative path length, which the per-sample time
 * mapping walks.
 */
interface SegmentPolyline {
  /** Index of the Segment in `Trajectory.segments`. */
  readonly segmentIndex: number;
  /** The Segment's sampled 3D positions, in traversal order. */
  readonly mm: readonly Vec3[];
  /** Cumulative pen travel per sample, aligned with `mm`, in mm. */
  readonly pathLengthMm: readonly number[];
}

/**
 * Groups the discretized path's samples into per-Segment polylines, in
 * traversal order. Samples of one Segment form one consecutive run; a
 * merged-away Segment contributes no samples and no polyline.
 */
function segmentPolylines(path: DiscretizedPath): readonly SegmentPolyline[] {
  const polylines: SegmentPolyline[] = [];
  let currentIndex = -1;
  let current: { mm: Vec3[]; pathLengthMm: number[] } | undefined;
  for (const sample of path.samples) {
    if (sample.segmentIndex !== currentIndex || current === undefined) {
      currentIndex = sample.segmentIndex;
      current = { mm: [], pathLengthMm: [] };
      polylines.push({ segmentIndex: currentIndex, mm: current.mm, pathLengthMm: current.pathLengthMm });
    }
    current.mm.push(asTuple(sample.position));
    current.pathLengthMm.push(sample.pathLengthMm);
  }
  return polylines;
}

/** The plan's ranges keyed by Segment index (ranges are unique per Segment). */
function rangesBySegment(plan: MotionPlan): ReadonlyMap<number, PlanSegmentRange> {
  const map = new Map<number, PlanSegmentRange>();
  for (const range of plan.ranges) {
    if (!map.has(range.segmentIndex)) map.set(range.segmentIndex, range);
  }
  return map;
}

/**
 * Per-sample plan times: the Segment's range window spread linearly in
 * arc length between the polyline's first and last samples (which map
 * exactly onto the range's start and end). The Motion Profile is
 * nonlinear in time, so these times are a schedule cue — pinned by the
 * golden tests, never fed to the robot.
 */
function sampleTimesMs(polyline: SegmentPolyline, plan: MotionPlan, range: PlanSegmentRange | undefined): number[] {
  const times = new Array<number>(polyline.mm.length);
  const sStart = polyline.pathLengthMm[0] as number;
  const sEnd = polyline.pathLengthMm[polyline.pathLengthMm.length - 1] as number;
  const spanMm = sEnd - sStart;
  for (let i = 0; i < polyline.mm.length; i++) {
    if (range !== undefined && spanMm > 0) {
      const s = polyline.pathLengthMm[i] as number;
      times[i] = range.startMs + ((s - sStart) / spanMm) * (range.endMs - range.startMs);
    } else if (range !== undefined) {
      // No arc length to spread (a single-sample polyline): the sample
      // stands at its range's start.
      times[i] = range.startMs;
    } else {
      // No range: the Segment spans no plan time (a zero-length Segment
      // merged into its join). The pen stands there at the boundary
      // between the neighbouring ranges — the next range's start, or
      // the plan's duration when no range follows.
      times[i] = boundaryTimeMs(plan, polyline.segmentIndex);
    }
  }
  return times;
}

/**
 * The plan time the pen stands at a Segment with no own range: the
 * first later range's start (ranges chain in traversal order), or the
 * plan's duration when the Segment trails every range.
 */
function boundaryTimeMs(plan: MotionPlan, segmentIndex: number): number {
  for (const range of plan.ranges) {
    if (range.segmentIndex > segmentIndex) return range.startMs;
  }
  return plan.durationMs;
}

/**
 * Runs of consecutive sampled moments traversing one PTP Move, as
 * moment-index arrays. The TCP hop between two poses is real motion the
 * plan does not draw — the trace shows where the tool actually went.
 */
function collectTraceRuns(rows: readonly MotionRow[], ptp: ReadonlySet<number>): readonly (readonly number[])[] {
  const runs: number[][] = [];
  let current: number[] | undefined;
  let currentSegment = -1;
  rows.forEach((row, index) => {
    if (ptp.has(row.segmentIndex)) {
      if (current !== undefined && currentSegment === row.segmentIndex) {
        current.push(index);
        return;
      }
      current = [index];
      currentSegment = row.segmentIndex;
      runs.push(current);
      return;
    }
    current = undefined;
    currentSegment = -1;
  });
  return runs;
}

/**
 * Travelled extent per plan range at one moment: the drawn polyline up
 * to where the pen actually is — the drawn sample nearest the moment's
 * forward-kinematics TCP (`tcpMm`). LIN Moves track the drawn geometry
 * exactly (ADR 0017), so the extent always ends where the TCP marker
 * sits, whatever pace the Motion Profile keeps inside the range (the
 * S-curve is nonlinear in time, so a time-fraction cut would visibly
 * lead or trail the pen — the same honesty the PTP trace is drawn for,
 * ADR 0016). A PTP Move contributes no extent — only arrival is
 * guaranteed, and the travelled reality is the TCP trace. Completion is
 * judged against `min(endMs, durationMs)`: the grid-rounded
 * `durationMs` can sit one control step short of the last range's
 * unrounded end, and the final moment must still hold the journey
 * complete.
 */
function travelledCounts(
  plan: MotionPlan,
  row: MotionRow,
  tcpMm: Vec3,
  polylines: readonly SegmentPolyline[],
  ptp: ReadonlySet<number>,
): number[] {
  return plan.ranges.map((range) => {
    if (ptp.has(range.segmentIndex)) return 0;
    const polyline = polylines.find((p) => p.segmentIndex === range.segmentIndex);
    if (polyline === undefined || polyline.mm.length === 0) return 0;
    const completeAt = Math.min(range.endMs, plan.durationMs);
    if (row.tMs >= completeAt - TIME_SLACK_MS) return polyline.mm.length;
    if (row.tMs > range.startMs) return nearestSample(polyline, tcpMm) + 1;
    return 0;
  });
}

/**
 * Index of the polyline sample nearest `p` (3D millimetres, squared
 * distance — no sqrt needed for an argmin).
 */
function nearestSample(polyline: SegmentPolyline, p: Vec3): number {
  let nearest = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.mm.length; i++) {
    const s = polyline.mm[i] as Vec3;
    const dx = s[0] - p[0];
    const dy = s[1] - p[1];
    const dz = s[2] - p[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) {
      best = d;
      nearest = i;
    }
  }
  return nearest;
}

/**
 * The scene's mm bounding box: the componentwise min/max over the
 * trajectory polylines, every moment's chain points, and the Home
 * Point — the box both renderers' cameras fit against.
 */
function sceneBounds(
  segments: readonly PreviewSceneSegment[],
  chains: readonly (readonly Vec3[])[],
  homeMm: Vec3,
): PreviewSceneBounds {
  const min: [number, number, number] = [homeMm[0], homeMm[1], homeMm[2]];
  const max: [number, number, number] = [homeMm[0], homeMm[1], homeMm[2]];
  const include = (p: Vec3): void => {
    for (const axis of [0, 1, 2] as const) {
      if (p[axis] < min[axis]) min[axis] = p[axis];
      if (p[axis] > max[axis]) max[axis] = p[axis];
    }
  };
  for (const segment of segments) for (const p of segment.mm) include(p);
  for (const chain of chains) for (const p of chain) include(p);
  return { min, max };
}
