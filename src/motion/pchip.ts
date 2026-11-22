/**
 * PCHIP — monotone cubic Hermite interpolation (Fritsch–Carlson), the
 * shape-preserving interpolant of the v1 Planner: joint angles q(s)
 * along path length never overshoot the solved IK values between knots,
 * unlike a natural cubic spline. Piecewise cubic, C¹ across knots; the
 * evaluation returns the value and its derivatives in s, which the
 * Planner chains with the Motion Profile's s(t) derivatives into joint
 * velocities, accelerations, and jerks.
 */

/** One evaluation of the interpolant with its derivatives in s. */
export interface PchipSample {
  /** Interpolated value. */
  readonly q: number;
  /** First derivative dq/ds. */
  readonly dq: number;
  /** Second derivative d²q/ds². */
  readonly ddq: number;
  /** Third derivative d³q/ds³ (piecewise-constant: jumps at knots). */
  readonly dddq: number;
}

/** A monotone cubic Hermite interpolant over strictly increasing knots. */
export interface Pchip {
  /** Knot abscissae (strictly increasing). */
  readonly xs: readonly number[];
  /** Knot values. */
  readonly ys: readonly number[];
  /**
   * Evaluates value and derivatives at `s`, clamped to the knot range.
   * `s` outside `[xs[0], xs[n-1]]` evaluates at the nearer end.
   */
  evalWithDerivatives(s: number): PchipSample;
}

/**
 * Builds a PCHIP interpolant over strictly increasing abscissae with at
 * least two knots. Tangents follow Fritsch–Carlson: interior tangents
 * are the shape-preserving weighted harmonic mean of the neighboring
 * secants (zero where the data changes direction), and the endpoint
 * tangents use the guarded noncentered three-point formula so the ends
 * neither overshoot nor flatten more than the data demands.
 */
export function pchip(xs: readonly number[], ys: readonly number[]): Pchip {
  const n = xs.length;
  if (n !== ys.length) {
    throw new RangeError(`pchip needs equal knot counts, got ${n} xs and ${ys.length} ys`);
  }
  if (n < 2) {
    throw new RangeError(`pchip needs at least two knots, got ${n}`);
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) {
      throw new RangeError(`pchip knots must be finite, got knot ${i}`);
    }
    if (i > 0 && !((xs[i] as number) > (xs[i - 1] as number))) {
      throw new RangeError(`pchip abscissae must strictly increase, got xs[${i - 1}]=${xs[i - 1]} xs[${i}]=${xs[i]}`);
    }
  }

  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const hi = (xs[i + 1] as number) - (xs[i] as number);
    h.push(hi);
    delta.push(((ys[i + 1] as number) - (ys[i] as number)) / hi);
  }

  const d: number[] = new Array<number>(n).fill(0);
  if (n === 2) {
    d[0] = delta[0] as number;
    d[1] = delta[0] as number;
  } else {
    d[0] = edgeTangent(h[0] as number, h[1] as number, delta[0] as number, delta[1] as number);
    d[n - 1] = edgeTangent(h[n - 2] as number, h[n - 3] as number, delta[n - 2] as number, delta[n - 3] as number);
  }
  for (let i = 1; i < n - 1; i++) {
    const dLo = delta[i - 1] as number;
    const dHi = delta[i] as number;
    if (dLo * dHi <= 0) {
      d[i] = 0; // local extremum: shape preservation demands a flat tangent
    } else {
      const w1 = 2 * (h[i] as number) + (h[i - 1] as number);
      const w2 = (h[i] as number) + 2 * (h[i - 1] as number);
      d[i] = (w1 + w2) / (w1 / dLo + w2 / dHi);
    }
  }

  const evalWithDerivatives = (s: number): PchipSample => {
    // Clamp and locate the interval with a linear scan from the ends
    // (knot counts per Segment are small; binary search is not worth it).
    const xLo = xs[0] as number;
    const xHi = xs[n - 1] as number;
    const t = Math.min(xHi, Math.max(xLo, s));
    let k = 0;
    while (k < n - 2 && t >= (xs[k + 1] as number)) k++;

    const hi = h[k] as number;
    const tau = (t - (xs[k] as number)) / hi;
    const y0 = ys[k] as number;
    const y1 = ys[k + 1] as number;
    const d0 = d[k] as number;
    const d1 = d[k + 1] as number;

    const t2 = tau * tau;
    const t3 = t2 * tau;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + tau;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const dh00 = 6 * t2 - 6 * tau;
    const dh10 = 3 * t2 - 4 * tau + 1;
    const dh01 = -dh00;
    const dh11 = 3 * t2 - 2 * tau;
    const ddh00 = 12 * tau - 6;
    const ddh10 = 6 * tau - 4;
    const ddh01 = -ddh00;
    const ddh11 = 6 * tau - 2;

    return {
      q: h00 * y0 + h10 * hi * d0 + h01 * y1 + h11 * hi * d1,
      dq: (dh00 * y0 + dh10 * hi * d0 + dh01 * y1 + dh11 * hi * d1) / hi,
      ddq: (ddh00 * y0 + ddh10 * hi * d0 + ddh01 * y1 + ddh11 * hi * d1) / (hi * hi),
      dddq: (12 * (y0 - y1) + 6 * hi * (d0 + d1)) / (hi * hi * hi),
    };
  };

  return { xs: [...xs], ys: [...ys], evalWithDerivatives };
}

/**
 * The guarded three-point endpoint tangent (scipy's `_edge_case`):
 * `h1` is the end interval's width, `h0` its neighbor's; `s0`/`s1` the
 * end and next secant. Falls back to the end secant when the estimate
 * would break the end interval's monotonicity.
 */
function edgeTangent(h1: number, h0: number, s0: number, s1: number): number {
  if (!Number.isFinite(s1)) return s0; // two-knot interpolant: plain secant
  let d = ((2 * h1 + h0) * s0 - h1 * s1) / (h1 + h0);
  if (Math.sign(d) !== Math.sign(s0)) {
    d = 0;
  } else if (Math.sign(s0) !== Math.sign(s1) && Math.abs(d) > 3 * Math.abs(s0)) {
    d = 3 * s0;
  }
  return d;
}
