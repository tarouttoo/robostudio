/**
 * Motion Preview playback pacing (ADR 0018, spec user story 28): which
 * sampled moment plays at a plan time. The dialog advances discretely
 * over the Motion Plan's real duration — at every moment, the last
 * sampled scene moment whose time has arrived is on screen.
 *
 * The GIF plays the same moments paced by one even delay per frame (ADR
 * 0018). For plans inside the frame budget the two coincide exactly
 * (plan rows and GIF delays both step 20 ms); beyond the budget the
 * GIF's 1/100 s delay quantization drifts from the plan's real
 * duration, while this pacing keeps every frame keyed to its sampled
 * plan moment — preview timing matches what the robot will do.
 */

/**
 * The sample shown at `tMs`: the last sampled moment whose time has
 * arrived (the first sample before and at its time). The samples must
 * be in play order (`tMs` non-decreasing), as the Preview Scene's
 * moments are. Anything with a `tMs` qualifies — the scene's moments,
 * the renderer's frames — the pacing reads only the schedule.
 */
export function frameIndexAt(samples: readonly { readonly tMs: number }[], tMs: number): number {
  let index = 0;
  for (let i = 0; i < samples.length; i++) {
    if ((samples[i]?.tMs ?? 0) > tMs) break;
    index = i;
  }
  return index;
}
