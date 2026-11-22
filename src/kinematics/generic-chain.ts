import {
  vec3Distance,
  type IKResult,
  type JointConfig,
  type RobotModel,
  type Vec3,
} from "./robot-model";

/** Central-difference step for the numerical Jacobian, in radians. */
const JACOBIAN_STEP_RAD = 1e-6;

/** Full turn of a revolute joint, in radians. */
const TWO_PI = 2 * Math.PI;

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
 * Numerical Jacobian of the chain's end-effector position with respect
 * to the joint angles, 3 rows (x, y, z) × n columns (joints), via
 * central differences. Numerical differentiation keeps the solver
 * generic: any chain expressible in {@link ChainJointConfig} works
 * without deriving analytic derivatives per robot.
 */
function numericJacobian(
  fk: (angles: readonly number[]) => Vec3,
  q: readonly number[],
): number[][] {
  const rows: number[][] = [[], [], []];
  for (let col = 0; col < q.length; col++) {
    const plus = q.slice();
    plus[col] = (q[col] as number) + JACOBIAN_STEP_RAD;
    const minus = q.slice();
    minus[col] = (q[col] as number) - JACOBIAN_STEP_RAD;
    const p = fk(plus);
    const m = fk(minus);
    for (let row = 0; row < 3; row++) {
      rows[row]!.push((p[row]! - m[row]!) / (2 * JACOBIAN_STEP_RAD));
    }
  }
  return rows;
}

/**
 * Solves a 3×3 linear system by Gaussian elimination with partial
 * pivoting. Returns `undefined` for singular or non-finite systems; the
 * damped normal matrix is symmetric positive definite, so this only
 * guards degenerate numerics, not expected inputs.
 */
function solve3x3(a: Mat3, b: Vec3): Vec3 | undefined {
  const rows = [
    [a[0]!, a[1]!, a[2]!, b[0]!],
    [a[3]!, a[4]!, a[5]!, b[1]!],
    [a[6]!, a[7]!, a[8]!, b[2]!],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(rows[r]![col]!) > Math.abs(rows[pivot]![col]!)) pivot = r;
    }
    const swap = rows[pivot]!;
    rows[pivot] = rows[col]!;
    rows[col] = swap;
    const diagonal = rows[col]![col]!;
    if (!Number.isFinite(diagonal) || Math.abs(diagonal) < 1e-12) return undefined;
    for (let c = col; c < 4; c++) rows[col]![c] = rows[col]![c]! / diagonal;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = rows[r]![col]!;
      if (factor === 0) continue;
      const targetRow = rows[r] as number[];
      const pivotRow = rows[col] as number[];
      for (let c = col; c < 4; c++) {
        targetRow[c] = targetRow[c]! - factor * pivotRow[c]!;
      }
    }
  }
  return [rows[0]![3]!, rows[1]![3]!, rows[2]![3]!];
}

/** Maximum number of step-halving trials before a descent is declared stuck. */
const BACKTRACK_TRIALS = 20;

/**
 * Deterministic seed poses for the numeric descent: the zeros clamped
 * into the joint limits, then interior poses at fixed fractions of each
 * joint's range. Multiple seeds matter because a clamped descent can
 * stall on a boundary local minimum; a different start basin escapes it.
 */
function seedsFor(joints: readonly ChainJointConfig[]): readonly (readonly number[])[] {
  const fraction = (f: number) =>
    joints.map((joint) => joint.minRad + f * (joint.maxRad - joint.minRad));
  return [
    joints.map((joint) => Math.min(Math.max(0, joint.minRad), joint.maxRad)),
    fraction(0.5),
    fraction(0.25),
    fraction(0.75),
  ];
}

/**
 * One damped-least-squares descent from a seed pose to a target.
 * Iterates `Δq = Jᵀ(JJᵀ + λ²I₃)⁻¹·e` with `e` the position error and λ
 * the configured damping, until the error norm is within the configured
 * tolerance or the iteration cap is exhausted. The step is accepted only
 * if it decreases the error, halving it up to {@link BACKTRACK_TRIALS}
 * times otherwise: a far seed must not overshoot and oscillate. With
 * `clampToLimits` the pose is projected into the joint limits after
 * every step, so a converged result is within limits by construction.
 * Returns the converged angles, or `undefined` when the cap is exhausted,
 * the descent is stuck at a local minimum, or anything turns non-finite
 * — never throws and never loops unbounded.
 */
function runDampedLeastSquares(
  joints: readonly ChainJointConfig[],
  axes: readonly Vec3[],
  target: Vec3,
  ik: NumericIkConfig,
  clampToLimits: boolean,
  seed: readonly number[],
): readonly number[] | undefined {
  const n = joints.length;
  const fk = (angles: readonly number[]) => chainForwardKinematics(joints, axes, angles);
  let q: readonly number[] = seed;
  const lambda2 = ik.damping * ik.damping;
  const project = (angles: readonly number[]): readonly number[] => {
    if (!clampToLimits) return angles;
    return angles.map((value, i) => {
      const joint = joints[i] as ChainJointConfig;
      return Math.min(Math.max(value, joint.minRad), joint.maxRad);
    });
  };

  let position = fk(q);
  let errorNorm = vec3Distance(target, position);
  for (let iteration = 0; iteration <= ik.maxIterations; iteration++) {
    if (Number.isFinite(errorNorm) && errorNorm <= ik.toleranceMm) return q;
    if (iteration === ik.maxIterations) return undefined;

    const error: Vec3 = [
      target[0]! - position[0]!,
      target[1]! - position[1]!,
      target[2]! - position[2]!,
    ];
    if (!error.every(Number.isFinite)) return undefined;

    const jacobian = numericJacobian(fk, q);
    // Damped normal matrix A = JJᵀ + λ²I₃ (symmetric positive definite);
    // Δq = JᵀA⁻¹e applies it to the position error directly.
    const entry = (row: number, col: number): number => {
      let d = 0;
      for (let k = 0; k < n; k++) d += jacobian[row]![k]! * jacobian[col]![k]!;
      return d + (row === col ? lambda2 : 0);
    };
    const step = solve3x3(
      [
        entry(0, 0), entry(0, 1), entry(0, 2),
        entry(1, 0), entry(1, 1), entry(1, 2),
        entry(2, 0), entry(2, 1), entry(2, 2),
      ],
      error,
    );
    if (!step || !step.every(Number.isFinite)) return undefined;

    const delta: number[] = [];
    for (let col = 0; col < n; col++) {
      delta.push(
        jacobian[0]![col]! * step[0]! +
        jacobian[1]![col]! * step[1]! +
        jacobian[2]![col]! * step[2]!,
      );
    }
    if (!delta.every(Number.isFinite)) return undefined;

    // Backtracking line search: accept only error-decreasing steps.
    let accepted = false;
    let scale = 1;
    for (let trial = 0; trial < BACKTRACK_TRIALS && !accepted; trial++) {
      const candidate = project(q.map((value, i) => value + scale * (delta[i] as number)));
      const candidatePosition = fk(candidate);
      const candidateError = vec3Distance(target, candidatePosition);
      if (Number.isFinite(candidateError) && candidateError < errorNorm) {
        q = candidate;
        position = candidatePosition;
        errorNorm = candidateError;
        accepted = true;
      }
      scale /= 2;
    }
    if (!accepted) return undefined; // Stuck at a local minimum.
  }
  return undefined;
}

/**
 * Shifts each angle by whole 2π turns — a no-op for revolute joints —
 * until it lies inside the joint's limits. Returns `undefined` when any
 * joint's range is narrower than a full turn and no equivalent angle
 * fits, i.e. the pose is genuinely outside the limits, not just
 * unwrapped.
 */
function wrapIntoLimits(
  joints: readonly ChainJointConfig[],
  angles: readonly number[],
): readonly number[] | undefined {
  const wrapped: (number | undefined)[] = angles.map((value, i) => {
    const joint = joints[i] as ChainJointConfig;
    if (!Number.isFinite(value)) return undefined;
    if (value >= joint.minRad && value <= joint.maxRad) return value;
    const turns = Math.ceil((joint.minRad - value) / TWO_PI);
    const candidate = value + turns * TWO_PI;
    return candidate <= joint.maxRad ? candidate : undefined;
  });
  if (wrapped.some((value) => value === undefined)) return undefined;
  return wrapped as readonly number[];
}

/** First joint whose limit `angles` violates, as a named `angle-limit` result. */
function firstLimitViolation(
  joints: readonly ChainJointConfig[],
  angles: readonly number[],
): IKResult | undefined {
  for (let i = 0; i < joints.length; i++) {
    const joint = joints[i] as ChainJointConfig;
    const value = angles[i] as number;
    if (value < joint.minRad) {
      return { status: "angle-limit", joint: joint.name, bound: "min", limitRad: joint.minRad, valueRad: value };
    }
    if (value > joint.maxRad) {
      return { status: "angle-limit", joint: joint.name, bound: "max", limitRad: joint.maxRad, valueRad: value };
    }
  }
  return undefined;
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

  const inverseKinematics = (target: Vec3): IKResult => {
    // Phase 1 — limit-aware: steps are clamped into the joint limits, so
    // convergence yields an in-limits solution directly. Each seed gets
    // its own descent; the first success wins.
    for (const seed of seedsFor(joints)) {
      const constrained = runDampedLeastSquares(joints, axes, target, config.ik, true, seed);
      if (constrained) return { status: "ok", joints: constrained };
    }
    // Phase 2 — unconstrained: a converged solution proves the target is
    // inside the workspace. Revolute joints are 2π-periodic, so the pose
    // is wrapped into the limits and accepted when every joint fits; a
    // solution that cannot be wrapped is a named angle-limit failure, and
    // no convergence at all is the named unreachable failure — never a
    // throw or an unbounded loop.
    let violation: IKResult | undefined;
    for (const seed of seedsFor(joints)) {
      const free = runDampedLeastSquares(joints, axes, target, config.ik, false, seed);
      if (!free) continue;
      const wrapped = wrapIntoLimits(joints, free);
      if (wrapped) return { status: "ok", joints: wrapped };
      violation ??= firstLimitViolation(joints, free);
    }
    return violation ?? { status: "unreachable" };
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
  const { toleranceMm, maxIterations, damping } = config.ik;
  if (!Number.isFinite(toleranceMm) || toleranceMm <= 0) {
    problems.push(`ik.toleranceMm must be finite and positive, got ${toleranceMm}`);
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    problems.push(`ik.maxIterations must be an integer of at least 1, got ${maxIterations}`);
  }
  if (!Number.isFinite(damping) || damping <= 0) {
    problems.push(`ik.damping must be finite and positive, got ${damping}`);
  }
  return problems;
}
