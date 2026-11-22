import {
  vec3,
  type IKResult,
  type JointConfig,
  type RobotModel,
  type Vec3,
} from "./robot-model";

/**
 * Solver implementations the registry can build for a generic chain.
 * Generic chains have no closed-form solution in general, so the one
 * registered solver is numeric: damped least squares (ADR 0004, 0008).
 */
export type GenericChainSolver = "numeric-dls";

/**
 * Convergence parameters of the numeric inverse-kinematics solver.
 * Part of the model configuration, so a robot tunes its own accuracy
 * and iteration budget without code changes (ADR 0008).
 */
export interface NumericIkConfig {
  /** Maximum end-effector position error in millimetres still accepted as converged. */
  readonly toleranceMm: number;
  /** Maximum number of solver iterations before reporting failure. */
  readonly maxIterations: number;
  /** Damped-least-squares damping factor λ; larger is steadier near singularities, smaller is faster. */
  readonly damping: number;
}

/**
 * One revolute joint of a generic chain: the shared {@link JointConfig}
 * (name, limits, dynamics) plus the geometry that places it in the
 * chain, in the URDF-like spirit of ADR 0008. All frames are defined
 * relative to the parent joint's rotated frame; the first joint's
 * parent is the model frame (model origin, +Z up).
 */
export interface ChainJointConfig extends JointConfig {
  /** Fixed translation from the parent frame to this joint's anchor, in millimetres. */
  readonly origin: Vec3;
  /** Rotation axis in the joint frame; need not be unit length, it is normalized once at build. */
  readonly axis: Vec3;
  /** Fixed link offset applied in the rotated joint frame after the rotation, in millimetres. */
  readonly offset: Vec3;
}

/** Configuration for a generic-chain Robot Model solved numerically. */
export interface GenericChainRobotConfig {
  /** Model kind discriminant used by the registry. */
  readonly kind: "generic-chain";
  /** Which solver implementation solves this chain; see {@link GenericChainSolver}. */
  readonly solver: GenericChainSolver;
  /** Registry id; must be unique across the registry. */
  readonly id: string;
  /** Human-readable model name. */
  readonly name: string;
  /** The kinematic chain: one entry per revolute joint, in actuation order. */
  readonly joints: readonly ChainJointConfig[];
  /** Numeric IK convergence parameters. */
  readonly ik: NumericIkConfig;
}

/** Named problems found while validating a {@link GenericChainRobotConfig}. */
export type GenericChainConfigResult =
  | { readonly status: "ok"; readonly model: RobotModel }
  | { readonly status: "invalid-config"; readonly problems: readonly string[] };

/** Row-major 3×3 matrix. */
type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Rotation matrix about a unit `axis` by `angleRad` (Rodrigues' formula). */
function rotationAbout(axis: Vec3, angleRad: number): Mat3 {
  const [x, y, z] = axis;
  const s = Math.sin(angleRad);
  const c = Math.cos(angleRad);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ] as Mat3;
}

/** Applies a row-major 3×3 matrix to a vector. */
function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ];
}

/** Multiplies two row-major 3×3 matrices (`a · b`). */
function multiply(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3]! * b[col]! +
        a[row * 3 + 1]! * b[3 + col]! +
        a[row * 3 + 2]! * b[6 + col]!;
    }
  }
  return [out[0]!, out[1]!, out[2]!, out[3]!, out[4]!, out[5]!, out[6]!, out[7]!, out[8]!];
}

/** Unit-length normalization; caller guarantees a non-zero vector. */
function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0]! / length, v[1]! / length, v[2]! / length];
}

/**
 * Forward kinematics of a generic chain: frame composition over the
 * revolute joints. For each joint the frame is translated by `origin`,
 * rotated about the joint's normalized `axis` by the joint angle, and
 * translated by `offset`; the end-effector is the final frame origin.
 */
function chainForwardKinematics(joints: readonly ChainJointConfig[], axes: readonly Vec3[], angles: readonly number[]): Vec3 {
  let position: Vec3 = [0, 0, 0];
  let rotation = IDENTITY;
  for (let i = 0; i < joints.length; i++) {
    const joint = joints[i] as ChainJointConfig;
    const origin = apply(rotation, joint.origin);
    position = [
      position[0]! + origin[0]!,
      position[1]! + origin[1]!,
      position[2]! + origin[2]!,
    ];
    rotation = multiply(rotation, rotationAbout(axes[i] as Vec3, angles[i] as number));
    const offset = apply(rotation, joint.offset);
    position = [
      position[0]! + offset[0]!,
      position[1]! + offset[1]!,
      position[2]! + offset[2]!,
    ];
  }
  return position;
}

/**
 * Builds a Robot Model for an arbitrary revolute chain, solved by the
 * registered numeric solver. The chain description is data (ADR 0008):
 * a future robot arrives as configuration, not as new math. The joint
 * geometry is validated up front; the numeric solver's convergence
 * behavior follows the configured tolerance, iteration cap, and damping.
 */
export function createGenericChainModel(config: GenericChainRobotConfig): GenericChainConfigResult {
  const problems = validateConfig(config);
  if (problems.length > 0) return { status: "invalid-config", problems };

  const joints = config.joints;
  const axes = joints.map((joint) => normalize(joint.axis));

  const forwardKinematics = (angles: readonly number[]): Vec3 => {
    if (angles.length !== joints.length) {
      throw new Error(`chain "${config.id}" expects ${joints.length} joint angles, got ${angles.length}`);
    }
    return chainForwardKinematics(joints, axes, angles);
  };

  const inverseKinematics = (_target: Vec3): IKResult => {
    // Convergence cycles replace this stub: RED test drives the damped
    // least squares solver in next.
    return { status: "unreachable" };
  };

  return {
    status: "ok",
    model: {
      id: config.id,
      name: config.name,
      joints,
      forwardKinematics,
      inverseKinematics,
    },
  };
}

function validateConfig(config: GenericChainRobotConfig): string[] {
  const problems: string[] = [];
  if (config.solver !== "numeric-dls") {
    problems.push(`unsupported solver "${String(config.solver)}" for id "${config.id}"`);
  }
  if (config.joints.length < 1) {
    problems.push(`id "${config.id}" requires at least one joint, got ${config.joints.length}`);
  }
  for (let i = 0; i < config.joints.length; i++) {
    const joint = config.joints[i] as ChainJointConfig;
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
    for (const [field, vector] of [
      ["origin", joint.origin],
      ["axis", joint.axis],
      ["offset", joint.offset],
    ] as const) {
      if (![...vector].every(Number.isFinite)) {
        problems.push(`joints[${i}] (${joint.name}) ${field} must be finite, got [${vector.join(", ")}]`);
      }
    }
    const axisLength = Math.hypot(joint.axis[0], joint.axis[1], joint.axis[2]);
    if (axisLength === 0 || !Number.isFinite(axisLength)) {
      problems.push(`joints[${i}] (${joint.name}) axis must be non-zero to be normalized`);
    }
  }
  return problems;
}
