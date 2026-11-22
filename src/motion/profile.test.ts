import { describe, expect, it } from "vitest";

import { sCurveAt } from "./profile";

describe("smoothstep S-curve motion profile", () => {
  it("maps normalized time 0 → 0 and 1 → full path length", () => {
    expect(sCurveAt({ lengthMm: 40, durationS: 2 }, 0).s).toBe(0);
    expect(sCurveAt({ lengthMm: 40, durationS: 2 }, 2).s).toBeCloseTo(40, 12);
  });

  it("has zero velocity and acceleration at both ends of the Segment", () => {
    for (const t of [0, 2]) {
      const at = sCurveAt({ lengthMm: 40, durationS: 2 }, t);
      expect(at.ds).toBe(0);
      expect(at.dds).toBe(0);
    }
  });

  it("peaks at half the traverse with the tangential speed above the mean", () => {
    // Mean tangential speed = L/T = 20 mm/s; the S-curve peaks well above.
    const mid = sCurveAt({ lengthMm: 40, durationS: 2 }, 1);
    expect(mid.s).toBeCloseTo(20, 12);
    expect(mid.ds).toBeCloseTo(37.5, 9); // 1.875 × L/T for the quintic smoothstep
    expect(mid.dds).toBeCloseTo(0, 9); // symmetric profile: zero accel at the crest
  });

  it("is monotone in time", () => {
    let prevS = -1;
    for (let t = 0; t <= 2 + 1e-9; t += 0.01) {
      const s = sCurveAt({ lengthMm: 40, durationS: 2 }, t).s;
      expect(s).toBeGreaterThanOrEqual(prevS);
      prevS = s;
    }
  });

  it("matches the analytic quintic polynomial and its derivatives", () => {
    // σ(τ) = 6τ⁵ − 15τ⁴ + 10τ³ with s = L·σ(τ), τ = t/T.
    const L = 33;
    const T = 1.7;
    for (const tau of [0.1, 0.37, 0.5, 0.83]) {
      const t = tau * T;
      const at = sCurveAt({ lengthMm: L, durationS: T }, t);
      const sig = 6 * tau ** 5 - 15 * tau ** 4 + 10 * tau ** 3;
      const dSig = 30 * tau ** 4 - 60 * tau ** 3 + 30 * tau ** 2;
      const ddSig = 120 * tau ** 3 - 180 * tau ** 2 + 60 * tau;
      const dddSig = 360 * tau ** 2 - 360 * tau + 60;
      expect(at.s).toBeCloseTo(L * sig, 10);
      expect(at.ds).toBeCloseTo((L / T) * dSig, 10);
      expect(at.dds).toBeCloseTo((L / (T * T)) * ddSig, 10);
      expect(at.ddds).toBeCloseTo((L / (T * T * T)) * dddSig, 10);
    }
  });

  it("clamps evaluation outside the Segment duration", () => {
    const early = sCurveAt({ lengthMm: 40, durationS: 2 }, -1);
    const late = sCurveAt({ lengthMm: 40, durationS: 2 }, 3);
    expect(early.s).toBe(0);
    expect(early.ds).toBe(0);
    expect(late.s).toBe(40);
    expect(late.ds).toBe(0);
  });
});
