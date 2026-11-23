/**
 * Project File save/open in the Electron main process (ADR 0003): the
 * only place a Project File touches the file system or a dialog. The
 * renderer asks through the preload bridge; these handlers answer with
 * plain result records (`SaveProjectResult` / `OpenProjectResult`) —
 * one shape per outcome, never exceptions across the IPC boundary.
 *
 * The Electron dialog is an injected port, so the handler logic runs in
 * tests against a scripted dialog and the real file system.
 */

import { readFile, writeFile } from "node:fs/promises";

import { CoreError } from "../core";
import { parseProject, ProjectError, type BridgeError, type OpenProjectResult, type SaveProjectResult } from "../project";

/**
 * The slice of the Electron dialog API the Project File handlers use.
 * A system boundary: scripted in tests, bound to the real `dialog` in
 * `main.ts`.
 */
export interface ProjectDialogs {
  /** Shows the save dialog; resolves with the chosen path or `canceled`. */
  showSave(): Promise<{ readonly canceled: boolean; readonly filePath?: string }>;
  /** Shows the open dialog; resolves with the chosen paths or `canceled`. */
  showOpen(): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

/**
 * Saves Project File JSON text: the save dialog picks the destination,
 * the text is written as UTF-8. Cancels cleanly; write failures come
 * back as a named `IoFailed` error record with the path in the message.
 */
export async function saveProjectFile(dialogs: ProjectDialogs, json: string): Promise<SaveProjectResult> {
  const choice = await dialogs.showSave();
  if (choice.canceled || choice.filePath === undefined) return { kind: "canceled" };
  const path = choice.filePath;
  try {
    await writeFile(path, json, "utf8");
    return { kind: "saved", path };
  } catch (cause) {
    return { kind: "error", error: ioError("write", path, cause) };
  }
}

/**
 * Opens a Project File: the open dialog picks the file, the text is
 * read and parsed (validated — every Segment rebuilt through the core).
 * Parse failures come back as named error records carrying the readable
 * message; the drawing state is only ever replaced on `loaded`.
 */
export async function openProjectFile(dialogs: ProjectDialogs): Promise<OpenProjectResult> {
  const choice = await dialogs.showOpen();
  if (choice.canceled || choice.filePaths.length === 0) return { kind: "canceled" };
  const path = choice.filePaths[0] as string;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    return { kind: "error", error: ioError("read", path, cause) };
  }
  try {
    return { kind: "loaded", path, content: parseProject(raw) };
  } catch (cause) {
    return { kind: "error", error: namedError(cause) };
  }
}

/** Builds the `IoFailed` record for a failed file operation. */
function ioError(operation: "read" | "write", path: string, cause: unknown): BridgeError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return { tag: "IoFailed", message: `Failed to ${operation} "${path}": ${reason}` };
}

/** Converts any parse failure into its named tag + readable message. */
function namedError(cause: unknown): BridgeError {
  if (cause instanceof ProjectError || cause instanceof CoreError) {
    return { tag: cause.tag, message: cause.message };
  }
  return { tag: "InvalidProjectFile", message: cause instanceof Error ? cause.message : String(cause) };
}
