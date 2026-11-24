import { describe, expect, it } from "vitest";

import type { MotionPreviewFrame } from "../export";
import { frameIndexAt } from "./preview-playback";

/**
 * Three crafted frames spanning a 250 ms plan: the first sample, one
 * hundred milliseconds in, and the final frame at the plan's real
 * duration (frame input is data, so the pacing tests feed data).
 */
const FRAMES: readonly MotionPreviewFrame[] = [
  { tMs: 0, primitives: [] },
  { tMs: 100, primitives: [] },
  { tMs: 250, primitives: [] },
];

describe("preview playback pacing", () => {
  it("shows the first frame at the plan's start", () => {
    expect(frameIndexAt(FRAMES, 0)).toBe(0);
  });

  it("holds the sampled frame whose moment has arrived until the next sample", () => {
    expect(frameIndexAt(FRAMES, 99)).toBe(0);
    expect(frameIndexAt(FRAMES, 100)).toBe(1);
    expect(frameIndexAt(FRAMES, 249)).toBe(1);
  });

  it("ends on the final frame at the plan's real duration", () => {
    expect(frameIndexAt(FRAMES, 250)).toBe(2);
  });
});
