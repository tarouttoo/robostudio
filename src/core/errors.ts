/**
 * Named errors of the math core. Every validation failure throws a
 * `CoreError` carrying a stable `tag` discriminant so callers (UI,
 * pipeline stages) can recover narrowly instead of string-matching
 * messages — the tagged-error discipline of the coding standards,
 * implemented dependency-free because the core has zero runtime
 * dependencies (ADR 0004).
 */

/** All error tags the core can fail with. */
export type CoreErrorTag =
  | "InvalidFeed"
  | "InvalidMotionType"
  | "InvalidArcRadius"
  | "InvalidCoordinate"
  | "ArcRadiusTooSmall"
  | "ArcAmbiguousCenter"
  | "ArcCenterOffCircle"
  | "ArcOffPlane";

/**
 * Base class of every named core error. `name` and `tag` both carry the
 * stable discriminant; `message` is human-readable and may include the
 * offending numbers.
 */
export class CoreError extends Error {
  /** Stable discriminant for narrow error handling. */
  readonly tag: CoreErrorTag;

  constructor(tag: CoreErrorTag, message: string) {
    super(message);
    this.name = tag;
    this.tag = tag;
  }
}
