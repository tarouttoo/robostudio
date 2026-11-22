/**
 * The v1 Motion Profile (GLOSSARY.md): a quintic smoothstep S-curve —
 * the smooth schedule along the Segment's path that the Motion Plan
 * follows. Normalized progress σ(τ) = 6τ⁵ − 15τ⁴ + 10τ³ starts and ends
 * with zero velocity and zero acceleration, so motion is continuous
 * across Segment boundaries and each Segment eases in and out.
 */

/** The tangential schedule s(t) of one Segment with its derivatives. */
export interface ProfileSample {
  /** Path length within the Segment at time `t`, mm. */
  readonly s: number;
  /** Tangential speed ds/dt, mm/s. */
  readonly ds: number;
  /** Tangential acceleration d²s/dt², mm/s². */
  readonly dds: number;
  /** Tangential jerk d³s/dt³, mm/s³. */
  readonly ddds: number;
}

/** One Segment's path traversal: length and planned duration. */
export interface ProfileSpec {
  /** Path length to traverse within the Segment, mm. */
  readonly lengthMm: number;
  /** Planned traverse duration, s. */
  readonly durationS: number;
}

/**
 * Evaluates the S-curve at absolute time `t` within the Segment
 * (t = 0 at the Segment's first plan moment). Times outside
 * `[0, durationS]` clamp to the nearer end — the Segment holds its
 * end pose, so the last control row of a plan can overshoot the exact
 * total duration by less than one control step.
 */
export function sCurveAt(spec: ProfileSpec, t: number): ProfileSample {
  const { lengthMm, durationS } = spec;
  if (!(Number.isFinite(lengthMm) && lengthMm > 0)) {
    throw new RangeError(`lengthMm must be a positive number of mm, got ${lengthMm}`);
  }
  if (!(Number.isFinite(durationS) && durationS > 0)) {
    throw new RangeError(`durationS must be a positive number of seconds, got ${durationS}`);
  }
  const tau = Math.min(1, Math.max(0, t / durationS));
  const t2 = tau * tau;
  const t3 = t2 * tau;
  const t4 = t3 * tau;
  const t5 = t4 * tau;
  const sig = 6 * t5 - 15 * t4 + 10 * t3;
  const dSig = 30 * t4 - 60 * t3 + 30 * t2;
  const ddSig = 120 * t3 - 180 * t2 + 60 * tau;
  const dddSig = 360 * t2 - 360 * tau + 60;
  return {
    s: lengthMm * sig,
    ds: (lengthMm / durationS) * dSig,
    dds: (lengthMm / (durationS * durationS)) * ddSig,
    ddds: (lengthMm / (durationS * durationS * durationS)) * dddSig,
  };
}
