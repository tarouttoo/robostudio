/**
 * Named errors of the project layer. Same discipline as the core's
 * `CoreError`: a stable `tag` discriminant so callers (the Electron main
 * process IPC, the renderer) can recover narrowly and show an
 * operator-readable message instead of string-matching.
 */

/** All error tags the project layer can fail with. */
export type ProjectErrorTag =
  | "InvalidProjectFile"
  | "UnsupportedSchemaVersion";

/**
 * Base class of every named project error. `name` and `tag` both carry
 * the stable discriminant; `message` is human-readable and names the
 * offending file content, in operator language.
 */
export class ProjectError extends Error {
  /** Stable discriminant for narrow error handling. */
  readonly tag: ProjectErrorTag;

  constructor(tag: ProjectErrorTag, message: string) {
    super(message);
    this.name = tag;
    this.tag = tag;
  }
}
