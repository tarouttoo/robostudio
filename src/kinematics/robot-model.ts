/**
 * The RobotModel seam (ADR 0004, ADR 0008): a named manipulator
 * description — joint and dynamic limits plus forward and inverse
 * kinematics. The rest of the app talks only to this interface, so a new
 * robot is configuration, not pipeline surgery.
 */

/** A 3D point or position in model-frame coordinates, in millimetres. */
export type Vec3 = readonly [number, number, number];

/** Builds a {@link Vec3} point. */
export function vec3(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

/** Euclidean distance in millimetres between two {@link Vec3} points. */
export function vec3Distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Joint angles in radians; the array order matches {@link RobotModel.joints}. */
export type JointAngles = readonly number[];

/** Static and dynamic limits for a single joint. */
export interface JointConfig {
  /** Joint name as used in named IK results and exports (e.g. "q1"). */
  readonly name: string;
  /** Minimum joint angle in radians (inclusive). */
  readonly minRad: number;
  /** Maximum joint angle in radians (inclusive). */
  readonly maxRad: number;
  /** Maximum joint velocity in rad/s used by motion planning. */
  readonly maxVelocityRadS: number;
  /** Maximum joint acceleration in rad/s² used by motion planning. */
  readonly maxAccelerationRadS2: number;
  /** Maximum joint jerk in rad/s³ used by motion planning. */
  readonly maxJerkRadS3: number;
}

/**
 * The result of {@link RobotModel.inverseKinematics}. Failures are named
 * statuses, never exceptions: `unreachable` for points outside the
 * workspace, `angle-limit` when the analytic solution would violate a
 * joint limit, `fk-error` when the solved angles fail the built-in
 * forward-kinematics verification.
 */
export type IKResult =
  | { readonly status: "ok"; readonly joints: JointAngles }
  | { readonly status: "unreachable" }
  | {
      readonly status: "angle-limit";
      /** Name of the first joint whose limit the solution violates. */
      readonly joint: string;
      /** Which bound was violated. */
      readonly bound: "min" | "max";
      /** The violated limit value in radians. */
      readonly limitRad: number;
      /** The solution value that violated the limit, in radians. */
      readonly valueRad: number;
    }
  | {
      readonly status: "fk-error";
      /** The requested target in millimetres. */
      readonly target: Vec3;
      /** Where the solved angles actually land, in millimetres. */
      readonly achieved: Vec3;
    };

/**
 * A named Robot Model (Модель робота): kinematic chain description,
 * joint and dynamic limits, forward kinematics, and inverse kinematics
 * with named failure statuses.
 */
export interface RobotModel {
  /** Registry id, stable across sessions (e.g. "miko-mini"). */
  readonly id: string;
  /** Human-readable model name. */
  readonly name: string;
  /** Per-joint limits; the array order matches angle arrays and IK results. */
  readonly joints: readonly JointConfig[];

  /**
   * Upper bound on the distance from the model-frame origin at which the
   * end-effector can be placed, in millimetres. May overestimate but
   * must never underestimate: workspace scans (e.g. the Reachability
   * zone's bounds) rely on it to cover the whole workspace.
   */
  readonly workspaceRadiusMm: number;

  /**
   * Forward kinematics: joint angles in radians → end-effector position
   * in millimetres.
   * @throws when `angles.length` differs from {@link joints.length}.
   */
  forwardKinematics(angles: JointAngles): Vec3;

  /**
   * World positions of the chain's skeleton for the given joint angles:
   * the fixed base point (the model-frame origin) first, then one point
   * per joint pivot in actuation order, ending with the end-effector
   * position — the same point `forwardKinematics(angles)` returns.
   * Consecutive points are the links a Motion Preview draws (the
   * GIF exporter, `src/export`); the array therefore holds
   * `joints.length + 2` points.
   * @throws when `angles.length` differs from {@link joints.length}.
   */
  chainPoints(angles: JointAngles): readonly Vec3[];

  /**
   * Inverse kinematics: an end-effector position in millimetres → joint
   * angles in radians, or a named failure status.
   */
  inverseKinematics(target: Vec3): IKResult;
}
