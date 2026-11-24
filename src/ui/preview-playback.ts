/**
 * Motion Preview playback pacing (ADR 0018, spec user story 28): which
 * frame plays at a plan moment. The dialog advances discretely over the
 * Motion Plan's real duration — at every moment, the last sampled
 * frame whose moment has arrived is on screen.
 *
 * The GIF plays the same frames paced by one even delay per frame (ADR
 * 0018). For plans inside the frame budget the two coincide exactly
 * (plan rows and GIF delays both step 20 ms); beyond the budget the
 * GIF's 1/100 s delay quantization drifts from the plan's real
 * duration, while this pacing keeps every frame keyed to its sampled
 * plan moment — preview timing matches what the robot will do.
 */

import type { MotionPreviewFrame } from "../export";

/**
 * The frame shown at `tMs`: the last sampled frame whose moment has
 * arrived (frame 0 before and at the first sample). The frames must be
 * in play order (`tMs` non-decreasing), as the renderer produces them.
 */
export function frameIndexAt(frames: readonly MotionPreviewFrame[], tMs: number): number {
  let index = 0;
  for (let i = 0; i < frames.length; i++) {
    if ((frames[i]?.tMs ?? 0) > tMs) break;
    index = i;
  }
  return index;
}
