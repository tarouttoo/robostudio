/**
 * Named errors of the motion layer. Every planning failure throws a
 * `MotionError` carrying a stable `tag` discriminant so callers (UI,
 * pipeline stages) can recover narrowly instead of string-matching
 * messages — the same tagged-error discipline as the core's
 * `CoreError` (the Motion Plan is one of the pipeline's Validation
 * stages per GLOSSARY.md).
 */

/** All error tags the motion layer can fail with. */
export type MotionErrorTag =
  | "InvalidSolution"
  | "TimeScalingFailed"
  | "PlanDurationExceeded"
  | "VerificationFailed";

/**
 * Base class of every named motion error. `name` and `tag` both carry
 * the stable discriminant; `message` is human-readable and may include
 * the offending numbers.
 */
export class MotionError extends Error {
  /** Stable discriminant for narrow error handling. */
  readonly tag: MotionErrorTag;

  constructor(tag: MotionErrorTag, message: string) {
    super(message);
    this.name = tag;
    this.tag = tag;
  }
}
