/**
 * The typed view of the preload bridge as the renderer sees it. The
 * bridge is the only surface the sandboxed renderer can reach the main
 * process through (ADR 0003); every privileged Project File operation —
 * the save/open dialogs and the file system access behind them — goes
 * through it and nowhere else.
 */

import type { OpenProjectResult, SaveProjectResult } from "../project";

/** The `window.robostudio` bridge exposed by the preload script. */
export interface RobostudioBridge {
  /** Static app info, shown in the header. */
  readonly appName: string;
  readonly appVersion: string;
  /**
   * Saves Project File JSON text: the main process shows the save
   * dialog and writes the file. Never throws — resolves with a
   * `SaveProjectResult` describing the outcome.
   */
  saveProject(json: string): Promise<SaveProjectResult>;
  /**
   * Opens a Project File: the main process shows the open dialog,
   * reads the chosen file, and parses it (validated). Never throws —
   * resolves with an `OpenProjectResult`; parse failures arrive as a
   * `{kind: "error"}` record with a readable message.
   */
  openProject(): Promise<OpenProjectResult>;
}

declare global {
  interface Window {
    /** Exposed by `src/app/preload.ts`; absent outside Electron. */
    readonly robostudio?: RobostudioBridge;
  }
}

/** Returns the preload bridge, or null when it was not exposed. */
export function projectBridge(): RobostudioBridge | null {
  return typeof window !== "undefined" ? (window.robostudio ?? null) : null;
}
