import {
  vec3,
  vec3Distance,
  type IKResult,
  type JointConfig,
  type RobotModel,
  type Vec3,
} from "./robot-model";

/** Link geometry of the MiKo-mini chain, in millimetres (ADR 0015). */
export interface MiKoMiniGeometry {
  /** Height of the shoulder above the base frame origin (Z offset). */
  readonly baseHeightMm: number;
  /** Upper arm length (shoulder → elbow). */
  readonly upperArmMm: number;
  /** Forearm length (elbow → wrist). */
  readonly forearmMm: number;
  /** Horizontal tool offset from the wrist along the forearm's radial direction. */
  readonly toolOffsetMm: number;
}

/** Configuration for the analytic MiKo-mini Robot Model. */
export interface MiKoMiniRobotConfig {
  /** Model kind discriminant used by the registry. */
  readonly kind: "miko-mini";
  /** Registry id; must be unique across the registry. */
  readonly id: string;
  /** Human-readable model name. */
  readonly name: string;
  /** Link geometry in millimetres. */
  readonly geometry: MiKoMiniGeometry;
  /** Exactly three joints, in order q1, q2, q3. */
  readonly joints: readonly JointConfig[];
}

/**
 * The MiKo-mini constants measured on the real prototype (ADR 0015):
 * a 160 mm shoulder column, two 159.8045 mm links (a measured value —
 * never round it), and a 53 mm horizontal tool offset, with the joint
 * and dynamic limits the motion planner must respect. Being
 * configuration, corrected values land here without code changes.
 */
export const DEFAULT_MIKO_MINI_CONFIG: MiKoMiniRobotConfig = {
  kind: "miko-mini",
  id: "miko-mini",
  name: "MiKo-mini",
  geometry: { baseHeightMm: 160, upperArmMm: 159.8045, forearmMm: 159.8045, toolOffsetMm: 53 },
  joints: [
    {
      name: "q1",
      minRad: -Math.PI,
      maxRad: Math.PI,
      maxVelocityRadS: 1.2,
      maxAccelerationRadS2: 2.8,
      maxJerkRadS3: 9.0,
    },
    {
      name: "q2",
      minRad: -Math.PI,
      maxRad: Math.PI,
      maxVelocityRadS: 0.8,
      maxAccelerationRadS2: 3.0,
      maxJerkRadS3: 8.0,
    },
    {
      name: "q3",
      minRad: -Math.PI,
      maxRad: Math.PI,
      maxVelocityRadS: 0.9,
      maxAccelerationRadS2: 2.5,
      maxJerkRadS3: 8.0,
    },
  ],
};

/**
 * The default Home Point (Исходная точка, ADR 0015): the 3D point where
 * the drawn Trajectory starts at editor start and after Clear, in the
 * MiKo-mini's workspace. Coordinates in millimetres, model frame.
 */
export const DEFAULT_MIKO_MINI_HOME_MM: readonly [number, number, number] = [213, 0, 305];

/** Named problems found while validating a {@link MiKoMiniRobotConfig}. */
export type MiKoMiniConfigResult =
  | { readonly status: "ok"; readonly model: RobotModel }
  | { readonly status: "invalid-config"; readonly problems: readonly string[] };

/**
 * Forward kinematics of the MiKo-mini chain (3-DOF: base rotation q1
 * about +Z, then the two planar links in the vertical plane; q2 is the
 * shoulder pitch above horizontal, q3 the elbow pitch relative to the
 * upper arm). The 53 mm tool (ADR 0015) extends the radial term:
 *
 * ```text
 * r = L1·cos(q2) + L2·cos(q2 + q3) + tool
 * x = cos(q1)·r
 * y = sin(q1)·r
 * z = baseHeight + L1·sin(q2) + L2·sin(q2 + q3)
 * ```
 *
 * Inverse kinematics subtracts the tool offset from the radial term
 * first, then returns the shoulder-up branch only: the elbow sits above
 * the shoulder→wrist chord, so `q3 = −acos(D)` and
 * `q2 = atan2(z − h, r − tool) − atan2(L2·sin(q3), L1 + L2·cos(q3))`.
 * Any point whose shoulder-up solution violates a joint limit is
 * reported as an `angle-limit` status rather than solved with the
 * elbow-down branch.
 */
export function createMiKoMiniModel(config: MiKoMiniRobotConfig): MiKoMiniConfigResult {
  const problems = validateConfig(config);
  if (problems.length > 0) return { status: "invalid-config", problems };

  const { baseHeightMm, upperArmMm, forearmMm, toolOffsetMm } = config.geometry;
  const l1 = upperArmMm;
  const l2 = forearmMm;
  const tool = toolOffsetMm;
  const [j1, j2, j3] = config.joints as readonly [JointConfig, JointConfig, JointConfig];
  const limits = [j1, j2, j3] as const;

  const forwardKinematics = (angles: readonly number[]): Vec3 => {
    if (angles.length !== 3) {
      throw new Error(`MiKo-mini expects 3 joint angles, got ${angles.length}`);
    }
    const q1 = angles[0] as number;
    const q2 = angles[1] as number;
    const q3 = angles[2] as number;
    const r = l1 * Math.cos(q2) + l2 * Math.cos(q2 + q3) + tool;
    return vec3(
      Math.cos(q1) * r,
      Math.sin(q1) * r,
      baseHeightMm + l1 * Math.sin(q2) + l2 * Math.sin(q2 + q3),
    );
  };

  const inverseKinematics = (target: Vec3): IKResult => {
    const zx = target[0];
    const zy = target[1];
    const dz = target[2] - baseHeightMm;
    // A non-finite point is not a place the robot can go; without this
    // guard NaN would silently pass every comparison below and return ok.
    if (![zx, zy, dz].every(Number.isFinite)) return { status: "unreachable" };
    const r2 = zx * zx + zy * zy;
    // The tool offset moves the wrist inward: the planar pair solves for
    // the wrist point, not the TCP.
    const wristR = Math.sqrt(r2) - tool;

    // cos(q3) from the law of cosines on the shoulder→wrist triangle.
    const d = (wristR * wristR + dz * dz - l1 * l1 - l2 * l2) / (2 * l1 * l2);
    // 1e-9 slack absorbs roundoff on the workspace boundary before the clamp.
    if (d > 1 + 1e-9 || d < -1 - 1e-9) return { status: "unreachable" };
    const cosQ3 = Math.min(1, Math.max(-1, d));

    const q3 = -Math.acos(cosQ3); // shoulder-up branch
    const psi = Math.atan2(l2 * Math.sin(q3), l1 + l2 * Math.cos(q3));
    const q2 = Math.atan2(dz, wristR) - psi;
    const q1 = Math.atan2(zy, zx);
    const solution = [q1, q2, q3] as const;

    for (let i = 0; i < limits.length; i++) {
      const limit = limits[i] as JointConfig;
      const value = solution[i] as number;
      if (value < limit.minRad) {
        return {
          status: "angle-limit",
          joint: limit.name,
          bound: "min",
          limitRad: limit.minRad,
          valueRad: value,
        };
      }
      if (value > limit.maxRad) {
        return {
          status: "angle-limit",
          joint: limit.name,
          bound: "max",
          limitRad: limit.maxRad,
          valueRad: value,
        };
      }
    }

    // Safety net: verify the solved angles through FK before trusting them.
    const achieved = forwardKinematics(solution);
    if (vec3Distance(achieved, target) > 1e-6) {
      return { status: "fk-error", target, achieved };
    }
    return { status: "ok", joints: solution };
  };

  return {
    status: "ok",
    model: {
      id: config.id,
      name: config.name,
      joints: limits,
      forwardKinematics,
      inverseKinematics,
    },
  };
}

function validateConfig(config: MiKoMiniRobotConfig): string[] {
  const problems: string[] = [];
  const { baseHeightMm, upperArmMm, forearmMm, toolOffsetMm } = config.geometry;
  if (!Number.isFinite(baseHeightMm) || baseHeightMm < 0) {
    problems.push(`geometry.baseHeightMm must be a finite non-negative number, got ${baseHeightMm}`);
  }
  if (!Number.isFinite(upperArmMm) || upperArmMm <= 0) {
    problems.push(`geometry.upperArmMm must be finite and positive, got ${upperArmMm}`);
  }
  if (!Number.isFinite(forearmMm) || forearmMm <= 0) {
    problems.push(`geometry.forearmMm must be finite and positive, got ${forearmMm}`);
  }
  if (!Number.isFinite(toolOffsetMm) || toolOffsetMm < 0) {
    problems.push(`geometry.toolOffsetMm must be a finite non-negative number, got ${toolOffsetMm}`);
  }
  if (config.joints.length !== 3) {
    problems.push(`MiKo-mini requires exactly 3 joints, got ${config.joints.length}`);
  }
  for (let i = 0; i < config.joints.length; i++) {
    const joint = config.joints[i] as JointConfig;
    if (!Number.isFinite(joint.minRad) || !Number.isFinite(joint.maxRad)) {
      problems.push(`joints[${i}].minRad/maxRad must be finite`);
    } else if (joint.minRad >= joint.maxRad) {
      problems.push(`joints[${i}] (${joint.name}) minRad ${joint.minRad} must be below maxRad ${joint.maxRad}`);
    }
    for (const [field, value] of [
      ["maxVelocityRadS", joint.maxVelocityRadS],
      ["maxAccelerationRadS2", joint.maxAccelerationRadS2],
      ["maxJerkRadS3", joint.maxJerkRadS3],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        problems.push(`joints[${i}] (${joint.name}) ${field} must be finite and positive, got ${value}`);
      }
    }
  }
  return problems;
}
