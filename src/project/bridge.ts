/**
 * The renderer↔main contract for Project File operations (save/open
 * through the Electron main process; the sandboxed renderer never
 * touches the file system itself — ADR 0003). These are the result
 * records the preload bridge resolves with: one shape per outcome, so
 * the renderer switches on `kind` instead of catching errors across the
 * process boundary.
 */

import type { ProjectContent } from "./file";
import type { ProjectErrorTag } from "./errors";

/** An error reported across the bridge: a stable tag plus a readable message. */
export interface BridgeError {
  /** Stable discriminant (see `ProjectErrorTag`, or `IoFailed` for file I/O faults). */
  readonly tag: ProjectErrorTag | "IoFailed";
  /** Human-readable message, safe to show to the operator. */
  readonly message: string;
}

/** Outcome of a Project File save: dialog → write. */
export type SaveProjectResult =
  | { readonly kind: "saved"; readonly path: string }
  | { readonly kind: "canceled" }
  | { readonly kind: "error"; readonly error: BridgeError };

/** Outcome of a Project File open: dialog → read → parse. */
export type OpenProjectResult =
  | { readonly kind: "loaded"; readonly path: string; readonly content: ProjectContent }
  | { readonly kind: "canceled" }
  | { readonly kind: "error"; readonly error: BridgeError };
