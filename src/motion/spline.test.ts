import { describe, expect, it } from "vitest";

import { quinticSpline } from "./spline";

describe("quintic spline (ADR 0022)", () => {
  it("reproduces linear data exactly with zero higher derivatives", () => {
    const spline = quinticSpline([0, 0.5, 1, 1.5], [0, 2, 4, 6]);
    for (const s of [0, 0.3, 0.5, 1.2, 1.5]) {
      const sample = spline.evalWithDerivatives(s);
      expect(sample.q).toBeCloseTo(4 * s, 9);
      expect(sample.dq).toBeCloseTo(4, 9);
      expect(sample.ddq).toBeCloseTo(0, 9);
      expect(sample.dddq).toBeCloseTo(0, 9);
    }
  });

  it("passes through every knot", () => {
    const xs = [0, 0.5, 1, 2.5, 4];
    const ys = [0.1, 0.42, 0.71, 0.95, 1.08];
    const spline = quinticSpline(xs, ys);
    xs.forEach((x, i) => {
      expect(spline.evalWithDerivatives(x).q).toBeCloseTo(ys[i] as number, 12);
    });
  });

  it("keeps value and all three derivatives continuous across every knot", () => {
    // Elbow-like data: q3 = −acos(…) shape over 0.5 mm knots — the shape
    // whose PCHIP second and third derivatives jumped at every knot.
    const xs = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    const ys = [0.1, 0.42, 0.71, 0.95, 1.08, 1.14, 1.17];
    const spline = quinticSpline(xs, ys);
    // One-sided limits at the knot via linear extrapolation from ±eps:
    // the raw left/right value difference would be dominated by the true
    // slope (2·dq·eps), not by a discontinuity.
    const eps = 1e-7;
    for (let i = 1; i < xs.length - 1; i++) {
      const knot = xs[i] as number;
      const fromLeft = spline.evalWithDerivatives(knot - eps);
      const fromRight = spline.evalWithDerivatives(knot + eps);
      const qLeft = fromLeft.q + fromLeft.dq * eps;
      const qRight = fromRight.q - fromRight.dq * eps;
      const dqLeft = fromLeft.dq + fromLeft.ddq * eps;
      const dqRight = fromRight.dq - fromRight.ddq * eps;
      const ddqLeft = fromLeft.ddq + fromLeft.dddq * eps;
      const ddqRight = fromRight.ddq - fromRight.dddq * eps;
      expect(Math.abs(qRight - qLeft)).toBeLessThan(1e-10);
      expect(Math.abs(dqRight - dqLeft)).toBeLessThan(1e-8);
      expect(Math.abs(ddqRight - ddqLeft)).toBeLessThan(1e-6);
      expect(Math.abs(fromRight.dddq - fromLeft.dddq)).toBeLessThan(1e-3);
    }
  });

  it("clamps evaluations outside the knot range to the nearer end", () => {
    const spline = quinticSpline([0, 1, 2], [0, 1, 1.5]);
    const first = spline.evalWithDerivatives(0);
    const last = spline.evalWithDerivatives(2);
    expect(spline.evalWithDerivatives(-5).q).toBeCloseTo(first.q, 12);
    expect(spline.evalWithDerivatives(5).q).toBeCloseTo(last.q, 12);
    expect(spline.evalWithDerivatives(-5).dq).toBeCloseTo(first.dq, 9);
    expect(spline.evalWithDerivatives(5).dq).toBeCloseTo(last.dq, 9);
  });

  it("rejects malformed knots with named RangeErrors", () => {
    expect(() => quinticSpline([0, 1], [0])).toThrow(RangeError);
    expect(() => quinticSpline([0], [0])).toThrow(RangeError);
    expect(() => quinticSpline([0, Number.NaN], [0, 1])).toThrow(RangeError);
    expect(() => quinticSpline([1, 0], [0, 1])).toThrow(RangeError);
    expect(() => quinticSpline([0, 1, 1], [0, 1, 2])).toThrow(RangeError);
  });
});
