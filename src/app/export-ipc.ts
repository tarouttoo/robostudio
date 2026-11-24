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

import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeError } from "../project";

/** The file name the Robot CSV lands under in the chosen folder. */
export const ROBOT_CSV_FILE = "robot.csv";

/** The file name the RViz CSV lands under in the chosen folder. */
export const RVIZ_CSV_FILE = "rviz.csv";

/** The file name the Motion Preview GIF lands under in the chosen folder. */
export const MOTION_GIF_FILE = "robot_motion.gif";

/** Suffix of the staging files the bytes are written to before the final rename. */
const STAGING_SUFFIX = ".partial";

/**
 * The slice of the Electron dialog API the export handler uses. A
 * system boundary: scripted in tests, bound to the real `dialog` in
 * `main.ts`.
 */
export interface ExportDialogs {
  /** Shows the folder picker; resolves with the chosen folder or `canceled`. */
  showDirectory(): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
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

/**
 * Exports the generated files: the folder dialog picks the destination,
 * the CSVs land as UTF-8 (`robot.csv`, `rviz.csv`) and the Motion
 * Preview GIF as binary bytes (`robot_motion.gif`). Cancels cleanly;
 * failures come back as a named `IoFailed` error record naming the
 * folder.
 */
export async function exportCsvs(
  dialogs: ExportDialogs,
  robotCsv: string,
  rvizCsv: string,
  motionGif: Uint8Array,
): Promise<ExportCsvsResult> {
  const choice = await dialogs.showDirectory();
  if (choice.canceled || choice.filePaths.length === 0) return { kind: "canceled" };
  const folder = choice.filePaths[0] as string;
  const files = [join(folder, ROBOT_CSV_FILE), join(folder, RVIZ_CSV_FILE), join(folder, MOTION_GIF_FILE)];
  // All three files are staged as sibling `.partial` files and only
  // then renamed onto their final names (a rename replaces the target
  // on every supported platform). A failure while the bytes are
  // produced — disk full, no permission, the folder gone — therefore
  // leaves the folder exactly as it was: a half-updated export would
  // be worse than no export, because all three files describe one and
  // the same run and the Robot CSV feeds the controller (ADR 0006). A
  // crash can still strand a `.partial` file; the next export
  // overwrites it. A failure at a later rename (a target another
  // program holds open) can still leave earlier files replaced; the
  // error names the folder either way. Staged cleanup never recurses,
  // so a staging path occupied by a directory of the operator's is
  // left alone. The GIF is written without an encoding — binary in,
  // binary out — so its bytes survive verbatim.
  const staging = files.map((file) => `${file}${STAGING_SUFFIX}`);
  try {
    await writeFile(staging[0] as string, robotCsv, "utf8");
    await writeFile(staging[1] as string, rvizCsv, "utf8");
    await writeFile(staging[2] as string, motionGif);
    await rename(staging[0] as string, files[0] as string);
    await rename(staging[1] as string, files[1] as string);
    await rename(staging[2] as string, files[2] as string);
  } catch (cause) {
    // Best effort: staged files never belong in the operator's folder.
    await Promise.allSettled(staging.map((file) => rm(file, { force: true })));
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: "error",
      error: { tag: "IoFailed", message: `Failed to write the generated files into "${folder}": ${reason}` },
    };
  }
  return { kind: "exported", folder, files };
}
