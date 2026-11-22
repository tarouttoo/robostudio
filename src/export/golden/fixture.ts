/**
 * The golden fixture Trajectory (ADR 0006): a fixed, fully reachable
 * input that pins both exporters' bytes. It exercises the pipeline's
 * shape — a Line whose Feed sets its range, then a joined quarter Arc
 * with a different Feed — so the committed CSV fixtures cover both
 * Segment kinds, both Feeds, the joined Segment boundary, and the
 * range chaining in the exported rows.
 */

import { arcFromCenter } from "../../core/arc";
import { line, trajectory, type Trajectory } from "../../core/trajectory";
import { vec3 } from "../../core/vec";

/** The fixed golden fixture Trajectory, in the MiKo-mini workspace. */
export const FIXTURE_TRAJECTORY: Trajectory = trajectory(vec3(80, 0, 60), [
  line({ start: vec3(80, 0, 60), end: vec3(100, 20, 60), feed: 20 }),
  arcFromCenter({
    plane: "XY",
    start: vec3(100, 20, 60),
    end: vec3(80, 40, 60),
    center: vec3(80, 20, 60),
    direction: "CCW",
    feed: 10,
  }),
]);
