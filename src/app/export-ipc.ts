/**
 * Generated CSV export in the Electron main process (ADR 0003): the
 * only place the exported Robot CSV and RViz CSV touch the file
 * system. The renderer generates the bytes with the headless pipeline
 * and hands them over through the preload bridge; this handler shows
 * the folder picker and writes both files into the chosen folder —
 * `robot.csv` (the Robot CSV the controller consumes, ADR 0006) and
 * `rviz.csv` (the sign-transformed visualization variant).
 *
 * Like the Project File handlers, it answers with plain result records
 * — one shape per outcome, never exceptions across the IPC boundary —
 * and the Electron dialog is an injected port, so the handler logic
 * runs in tests against a scripted dialog and the real file system.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeError } from "../project";

/** The file name the Robot CSV lands under in the chosen folder. */
export const ROBOT_CSV_FILE = "robot.csv";

/** The file name the RViz CSV lands under in the chosen folder. */
export const RVIZ_CSV_FILE = "rviz.csv";

/**
 * The slice of the Electron dialog API the export handler uses. A
 * system boundary: scripted in tests, bound to the real `dialog` in
 * `main.ts`.
 */
export interface ExportDialogs {
  /** Shows the folder picker; resolves with the chosen folder or `canceled`. */
  showDirectory(): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

/** Outcome of a CSV export: folder picker → write both files. */
export type ExportCsvsResult =
  | {
      /** Both files were written into the chosen folder. */
      readonly kind: "exported";
      /** The folder the operator picked. */
      readonly folder: string;
      /** Full paths of the written files: Robot CSV first, RViz CSV second. */
      readonly files: readonly string[];
    }
  | { readonly kind: "canceled" }
  | { readonly kind: "error"; readonly error: BridgeError };

/**
 * Exports the two generated CSV files: the folder dialog picks the
 * destination, the bytes are written as UTF-8 (`robot.csv`,
 * `rviz.csv`). Cancels cleanly; write failures come back as a named
 * `IoFailed` error record naming the folder.
 */
export async function exportCsvs(
  dialogs: ExportDialogs,
  robotCsv: string,
  rvizCsv: string,
): Promise<ExportCsvsResult> {
  const choice = await dialogs.showDirectory();
  if (choice.canceled || choice.filePaths.length === 0) return { kind: "canceled" };
  const folder = choice.filePaths[0] as string;
  const files = [join(folder, ROBOT_CSV_FILE), join(folder, RVIZ_CSV_FILE)];
  try {
    await writeFile(files[0] as string, robotCsv, "utf8");
    await writeFile(files[1] as string, rvizCsv, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: "error",
      error: { tag: "IoFailed", message: `Failed to write the CSV files into "${folder}": ${reason}` },
    };
  }
  return { kind: "exported", folder, files };
}
