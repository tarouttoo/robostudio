import { describe, expect, it } from "vitest";

import { pchip } from "./pchip";

/** Central finite-difference derivative of the interpolant at s. */
function finiteSlope(p: ReturnType<typeof pchip>, s: number, h = 1e-4): number {
  const lo = p.evalWithDerivatives(s - h).q;
  const hi = p.evalWithDerivatives(s + h).q;
  return (hi - lo) / (2 * h);
}

describe("PCHIP interpolant", () => {
  it("passes exactly through every knot", () => {
    const p = pchip([0, 1, 2.5, 4], [0.1, -0.3, 0.7, 0.2]);
    const xs = [0, 1, 2.5, 4];
    const ys = [0.1, -0.3, 0.7, 0.2];
    xs.forEach((x, i) => {
      expect(p.evalWithDerivatives(x).q).toBeCloseTo(ys[i] as number, 12);
    });
  });

  it("stays inside the knot range on every interval (no PCHIP overshoot)", () => {
    // A steep monotone rise that a natural cubic spline would overshoot.
    const p = pchip([0, 1, 2, 3], [0, 0.01, 1, 1.01]);
    for (let s = 0; s <= 3; s += 0.01) {
      const { q } = p.evalWithDerivatives(s);
      expect(q).toBeGreaterThanOrEqual(-1e-12);
      expect(q).toBeLessThanOrEqual(1.01 + 1e-12);
    }
  });

  it("preserves monotone data: no local extrema between knots", () => {
    const p = pchip([0, 1, 2, 3], [0, 0.5, 0.6, 1]);
    const h = 1e-3;
    let prev = p.evalWithDerivatives(0).q;
    for (let s = h; s <= 3 + 1e-12; s += h) {
      const cur = p.evalWithDerivatives(s).q;
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = cur;
    }
  });

  it("first derivative matches a central finite difference of the interpolant", () => {
    const p = pchip([0, 0.7, 2.1, 3], [0, 0.4, -0.2, 0.5]);
    for (const s of [0.05, 0.7, 1.3, 2.1, 2.9]) {
      expect(p.evalWithDerivatives(s).dq).toBeCloseTo(finiteSlope(p, s), 4);
    }
  });

  it("second derivative matches a central finite difference of the first derivative", () => {
    const p = pchip([0, 0.7, 2.1, 3], [0, 0.4, -0.2, 0.5]);
    const h = 1e-3;
    for (const s of [0.05, 1.3, 2.9]) {
      const ddq = p.evalWithDerivatives(s).ddq;
      const hi = p.evalWithDerivatives(s + h).dq;
      const lo = p.evalWithDerivatives(s - h).dq;
      expect(ddq).toBeCloseTo((hi - lo) / (2 * h), 3);
    }
  });

  it("clamps evaluation to the knot range", () => {
    const p = pchip([0, 1, 2], [0, 1, 0]);
    expect(p.evalWithDerivatives(-5).q).toBe(0);
    expect(p.evalWithDerivatives(5).q).toBe(0);
  });

  it("is exact on two knots (linear)", () => {
    const p = pchip([0, 10], [2, 5]);
    const { q, dq } = p.evalWithDerivatives(4);
    expect(q).toBeCloseTo(2 + 0.3 * 4, 12);
    expect(dq).toBeCloseTo(0.3, 12);
    expect(p.evalWithDerivatives(10).ddq).toBeCloseTo(0, 12);
  });

  it("rejects fewer than two knots and non-increasing abscissae", () => {
    expect(() => pchip([0], [1])).toThrow(RangeError);
    expect(() => pchip([0, 1], [0])).toThrow(RangeError);
    expect(() => pchip([0, 1, 1], [0, 1, 2])).toThrow(RangeError);
    expect(() => pchip([1, 0], [0, 1])).toThrow(RangeError);
    expect(() => pchip([0, Number.NaN, 2], [0, 1, 2])).toThrow(RangeError);
  });
});
