/**
 * The Planner's interpolant (ADR 0022): a C³ quintic spline over the
 * Discretization's knots — joint angles q(s) along path length whose
 * value and first three derivatives are continuous across every knot.
 * PCHIP (the previous interpolant) was only C¹: its second derivative
 * jumped at each knot and its third derivative was piecewise constant,
 * so the planned accelerations showed a dense sawtooth and the jerks
 * alternated far past their limits between control rows. The quintic
 * spline removes those jumps at the source.
 *
 * The trade-off is shape preservation: unlike PCHIP, the spline may
 * slightly overshoot the solved IK values between knots. The Planner's
 * verification now checks joint position limits at every control row
 * and dynamic limits at every knot crossing (ADR 0022), so an overshoot
 * past a limit fails the plan instead of silently exporting it.
 *
 * Construction: classic natural cubic-spline tangents first (a C²
 * curvature solve), then a second tridiagonal solve for the knot
 * curvatures that makes the third derivative continuous across knots.
 * Piecewise quintic with per-interval coefficients a, b, c:
 * q(t) = y₀ + d₀t + (s₀/2)t² + at³ + bt⁴ + ct⁵ on each interval.
 */

/** One evaluation of the interpolant with its derivatives in s. */
export interface SplineSample {
  /** Interpolated value. */
  readonly q: number;
  /** First derivative dq/ds. */
  readonly dq: number;
  /** Second derivative d²q/ds². */
  readonly ddq: number;
  /** Third derivative d³q/ds³ (continuous across knots). */
  readonly dddq: number;
}

/** A C³ quintic spline interpolant over strictly increasing knots. */
export interface QuinticSpline {
  /** Knot abscissae (strictly increasing). */
  readonly xs: readonly number[];
  /** Knot values. */
  readonly ys: readonly number[];
  /**
   * Evaluates value and derivatives at `s`, clamped to the knot range.
   * `s` outside `[xs[0], xs[n-1]]` evaluates at the nearer end.
   */
  evalWithDerivatives(s: number): SplineSample;
}

/** One interval's stored evaluation data: the quintic's coefficients. */
interface SplineInterval {
  /** Interval start abscissa. */
  readonly x0: number;
  /** Value at the interval start. */
  readonly y0: number;
  /** First derivative at the interval start. */
  readonly d0: number;
  /** Second derivative at the interval start. */
  readonly s0: number;
  /** Quintic t³ coefficient. */
  readonly a: number;
  /** Quintic t⁴ coefficient. */
  readonly b: number;
  /** Quintic t⁵ coefficient. */
  readonly c: number;
}

/**
 * Builds a C³ quintic spline over strictly increasing abscissae with at
 * least two knots.
 */
export function quinticSpline(xs: readonly number[], ys: readonly number[]): QuinticSpline {
  const n = xs.length;
  if (n !== ys.length) {
    throw new RangeError(`quinticSpline needs equal knot counts, got ${n} xs and ${ys.length} ys`);
  }
  if (n < 2) {
    throw new RangeError(`quinticSpline needs at least two knots, got ${n}`);
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) {
      throw new RangeError(`quinticSpline knots must be finite, got knot ${i}`);
    }
    if (i > 0 && !((xs[i] as number) > (xs[i - 1] as number))) {
      throw new RangeError(`quinticSpline abscissae must strictly increase, got xs[${i - 1}]=${xs[i - 1]} xs[${i}]=${xs[i]}`);
    }
  }

  const tangents = cubicSplineTangents(xs, ys);
  const curvatures = jerkContinuousCurvatures(xs, ys, tangents);

  // Per-interval quintic coefficients from the Hermite data
  // (y0, y1, d0, d1, s0, s1): M·[a, b, c]ᵀ = [R1, R2, R3]ᵀ with
  //   R1 = Δy − d0·h − s0·h²/2   (value at the right end)
  //   R2 = d1 − d0 − s0·h        (first derivative at the right end)
  //   R3 = s1 − s0               (second derivative at the right end)
  const intervals: SplineInterval[] = [];
  for (let k = 0; k < n - 1; k++) {
    const h = (xs[k + 1] as number) - (xs[k] as number);
    const d0 = tangents[k] as number;
    const d1 = tangents[k + 1] as number;
    const s0 = curvatures[k] as number;
    const s1 = curvatures[k + 1] as number;
    const r1 = (ys[k + 1] as number) - (ys[k] as number) - d0 * h - (s0 * h * h) / 2;
    const r2 = d1 - d0 - s0 * h;
    const r3 = s1 - s0;
    const [a, b, c] = solveHermiteSystem(h, r1, r2, r3);
    intervals.push({
      x0: xs[k] as number,
      y0: ys[k] as number,
      d0,
      s0,
      a: a as number,
      b: b as number,
      c: c as number,
    });
  }

  const evalWithDerivatives = (s: number): SplineSample => {
    // Clamp and locate the interval with a linear scan from the ends
    // (knot counts per Segment are small; binary search is not worth it).
    const xLo = xs[0] as number;
    const xHi = xs[n - 1] as number;
    const t = Math.min(xHi, Math.max(xLo, s));
    let k = 0;
    while (k < n - 2 && t >= (xs[k + 1] as number)) k++;

    const interval = intervals[k] as SplineInterval;
    const u = t - interval.x0;
    const u2 = u * u;
    const u3 = u2 * u;
    const u4 = u3 * u;
    const u5 = u4 * u;
    return {
      q: interval.y0 + interval.d0 * u + (interval.s0 / 2) * u2 + interval.a * u3 + interval.b * u4 + interval.c * u5,
      dq: interval.d0 + interval.s0 * u + 3 * interval.a * u2 + 4 * interval.b * u3 + 5 * interval.c * u4,
      ddq: interval.s0 + 6 * interval.a * u + 12 * interval.b * u2 + 20 * interval.c * u3,
      dddq: 6 * interval.a + 24 * interval.b * u + 60 * interval.c * u2,
    };
  };

  return { xs: [...xs], ys: [...ys], evalWithDerivatives };
}

/**
 * Classic natural cubic-spline tangents: solve the tridiagonal
 * curvature system (zero curvature at both ends), then convert
 * curvatures and secants to knot tangents via the spline's derivative
 * formula `S'(x_i) = secant_i − h_i·(2m_i + m_{i+1})/6` (mirrored at
 * the right end).
 */
function cubicSplineTangents(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length;
  if (n === 2) {
    // Two knots: one interval, curvature system is empty, both end
    // tangents are the plain secant.
    const secant = ((ys[1] as number) - (ys[0] as number)) / ((xs[1] as number) - (xs[0] as number));
    return [secant, secant];
  }
  const h: number[] = [];
  for (let i = 0; i < n - 1; i++) h.push((xs[i + 1] as number) - (xs[i] as number));

  const interiorCurvatures = solveTridiagonal(
    Array.from({ length: n - 2 }, (_, i) => {
      const secantHi = ((ys[i + 2] as number) - (ys[i + 1] as number)) / (h[i + 1] as number);
      const secantLo = ((ys[i + 1] as number) - (ys[i] as number)) / (h[i] as number);
      return {
        lower: h[i] as number,
        diagonal: 2 * ((h[i] as number) + (h[i + 1] as number)),
        upper: h[i + 1] as number,
        rhs: 6 * (secantHi - secantLo),
      };
    }),
  );
  // Natural ends: zero curvature at knots 0 and n−1.
  const m: number[] = [0, ...interiorCurvatures, 0];

  const tangents: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < n - 1) {
      const secant = ((ys[i + 1] as number) - (ys[i] as number)) / (h[i] as number);
      tangents.push(secant - (h[i] as number) * (2 * (m[i] as number) + (m[i + 1] as number)) / 6);
    } else {
      const secant = ((ys[i] as number) - (ys[i - 1] as number)) / (h[i - 1] as number);
      tangents.push(secant + (h[i - 1] as number) * (2 * (m[i] as number) + (m[i - 1] as number)) / 6);
    }
  }
  return tangents;
}

/**
 * Knot curvatures that make the third derivative continuous across
 * knots (ADR 0022): with tangents fixed from the C² solve, each
 * interval's quintic coefficients a, b, c are affine in the two
 * endpoint curvatures — computed by solving the Hermite system for the
 * constant, s₀-unit, and s₁-unit right-hand sides. Equating the left
 * and right jerk limits at every interior knot then yields a
 * tridiagonal system with natural (zero) end curvatures.
 */
function jerkContinuousCurvatures(xs: readonly number[], ys: readonly number[], tangents: readonly number[]): number[] {
  const n = xs.length;
  if (n === 2) return [0, 0];
  const h: number[] = [];
  for (let k = 0; k < n - 1; k++) h.push((xs[k + 1] as number) - (xs[k] as number));

  // Per-interval affine coefficients of a: a = aC + aS0·s_left + aS1·s_right.
  const aC: number[] = [];
  const aS0: number[] = [];
  const aS1: number[] = [];
  const bC: number[] = [];
  const bS0: number[] = [];
  const bS1: number[] = [];
  const cC: number[] = [];
  const cS0: number[] = [];
  const cS1: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    const hk = h[k] as number;
    const dy = (ys[k + 1] as number) - (ys[k] as number) - (tangents[k] as number) * hk; // R1's constant part: Δy − d0·h
    const dd = (tangents[k + 1] as number) - (tangents[k] as number); // R2's constant part
    const [ac, bc, cc] = solveHermiteSystem(hk, dy, dd, 0);
    const [as0, bs0, cs0] = solveHermiteSystem(hk, -(hk * hk) / 2, -hk, -1);
    const [as1, bs1, cs1] = solveHermiteSystem(hk, 0, 0, 1);
    aC.push(ac as number);
    aS0.push(as0 as number);
    aS1.push(as1 as number);
    bC.push(bc as number);
    bS0.push(bs0 as number);
    bS1.push(bs1 as number);
    cC.push(cc as number);
    cS0.push(cs0 as number);
    cS1.push(cs1 as number);
  }
  // Jerk at an interval's left end is 6a; at its right end
  // 6a + 24b·h + 60c·h². Substituting the affine pieces:
  const jerkRightC = (k: number): number =>
    6 * (aC[k] as number) + 24 * (bC[k] as number) * (h[k] as number) + 60 * (cC[k] as number) * (h[k] as number) ** 2;
  const jerkRightSLeft = (k: number): number =>
    6 * (aS0[k] as number) + 24 * (bS0[k] as number) * (h[k] as number) + 60 * (cS0[k] as number) * (h[k] as number) ** 2;
  const jerkRightSRight = (k: number): number =>
    6 * (aS1[k] as number) + 24 * (bS1[k] as number) * (h[k] as number) + 60 * (cS1[k] as number) * (h[k] as number) ** 2;

  // Continuity at interior knot i+1 (rows i = 0..n−3): the right jerk of
  // interval i equals the left jerk (6a) of interval i+1. Unknowns are
  // the curvatures at knots 1..n−2; the natural ends (s_0 = s_{n−1} = 0)
  // contribute nothing and drop out of the first and last rows.
  const rows = Array.from({ length: n - 2 }, (_, i) => ({
    lower: jerkRightSLeft(i),
    diagonal: jerkRightSRight(i) - 6 * (aS0[i + 1] as number),
    upper: -6 * (aS1[i + 1] as number),
    rhs: -(jerkRightC(i) - 6 * (aC[i + 1] as number)),
  }));
  const interior = solveTridiagonal(rows);
  return [0, ...interior, 0];
}

/**
 * The 3×3 Hermite system for one interval of width `h`:
 * M·[a, b, c]ᵀ = [r1, r2, r3]ᵀ with
 * M = [[h³, h⁴, h⁵], [3h², 4h³, 5h⁴], [6h, 12h², 20h³]], det(M) = 2h⁹.
 * Solved by Cramer's rule (nonsingular for every h > 0).
 */
function solveHermiteSystem(h: number, r1: number, r2: number, r3: number): [number, number, number] {
  const h2 = h * h;
  const h3 = h2 * h;
  const h4 = h3 * h;
  const h5 = h4 * h;
  const det = 2 * h3 * h3 * h3;
  // a: first column replaced by [r1, r2, r3].
  const detA =
    r1 * (4 * h3 * 20 * h3 - 5 * h4 * 12 * h2) -
    h4 * (r2 * 20 * h3 - 5 * h4 * r3) +
    h5 * (r2 * 12 * h2 - 4 * h3 * r3);
  // b: second column replaced.
  const detB =
    h3 * (r2 * 20 * h3 - 5 * h4 * r3) -
    r1 * (3 * h2 * 20 * h3 - 5 * h4 * 6 * h) +
    h5 * (3 * h2 * r3 - r2 * 6 * h);
  // c: third column replaced.
  const detC =
    h3 * (4 * h3 * r3 - r2 * 12 * h2) -
    h4 * (3 * h2 * r3 - r2 * 6 * h) +
    r1 * (3 * h2 * 12 * h2 - 4 * h3 * 6 * h);
  return [detA / det, detB / det, detC / det];
}

/** Solves a tridiagonal system with the Thomas algorithm. */
function solveTridiagonal(rows: readonly {
  lower: number;
  diagonal: number;
  upper: number;
  rhs: number;
}[]): number[] {
  const n = rows.length;
  if (n === 0) return [];
  const cPrime: number[] = [];
  const dPrime: number[] = [];
  let beta = rows[0]!.diagonal;
  cPrime.push(rows[0]!.upper / beta);
  dPrime.push(rows[0]!.rhs / beta);
  for (let i = 1; i < n; i++) {
    const row = rows[i] as (typeof rows)[number];
    beta = row.diagonal - row.lower * (cPrime[i - 1] as number);
    cPrime.push(i < n - 1 ? row.upper / beta : 0);
    dPrime.push((row.rhs - row.lower * (dPrime[i - 1] as number)) / beta);
  }
  const solution: number[] = new Array<number>(n).fill(0);
  solution[n - 1] = dPrime[n - 1] as number;
  for (let i = n - 2; i >= 0; i--) {
    solution[i] = (dPrime[i] as number) - (cPrime[i] as number) * (solution[i + 1] as number);
  }
  return solution;
}
