/**
 * The typed view of the preload bridge as the renderer sees it. The
 * bridge is the only surface the sandboxed renderer can reach the main
 * process through (ADR 0003); every privileged operation — the Project
 * File save/open dialogs, the CSV export folder picker and the file
 * system access behind them — goes through it and nowhere else.
 */

import type { BridgeError, OpenProjectResult, SaveProjectResult } from "../project";

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
  /**
   * Exports the generated files: the main process shows the folder
   * picker and writes `robot.csv` (Robot CSV), `rviz.csv` (RViz CSV),
   * and `robot_motion.gif` (the Motion Preview GIF, binary bytes)
   * into the chosen folder, byte-for-byte as passed. Never throws —
   * resolves with an `ExportCsvsResult` describing the outcome.
   */
  exportCsvs(robotCsv: string, rvizCsv: string, motionGif: Uint8Array): Promise<ExportCsvsResult>;
}

/** Outcome of a generation export: folder picker → write all three files. */
export type ExportCsvsResult =
  | {
      /** All three files were written into the chosen folder. */
      readonly kind: "exported";
      /** The folder the operator picked. */
      readonly folder: string;
      /** Full paths of the written files: Robot CSV, RViz CSV, Motion Preview GIF. */
      readonly files: readonly string[];
    }
  | { readonly kind: "canceled" }
  | { readonly kind: "error"; readonly error: BridgeError };

declare global {
  interface Window {
    /** Exposed by `src/app/preload.ts`; absent outside Electron. */
    readonly robostudio?: RobostudioBridge;
  }
}

/** Returns the preload bridge, or null when it was not exposed. */
export function bridge(): RobostudioBridge | null {
  return (globalThis as { robostudio?: RobostudioBridge }).robostudio ?? null;
}
