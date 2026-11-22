import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { parseProject, serializeProject, type ProjectContent } from "../project";
import { openProjectFile, saveProjectFile, type ProjectDialogs } from "./project-ipc";

/**
 * The dialog is a GUI boundary — replaced by a scripted fake. The file
 * store is NOT faked: these tests run against the real file system in a
 * temp directory, so the bytes written are really on disk.
 */
function fakeDialogs(choice: { save?: { canceled: boolean; filePath?: string }; open?: { canceled: boolean; filePaths: string[] } }): ProjectDialogs {
  return {
    showSave: async () => choice.save ?? { canceled: true },
    showOpen: async () => choice.open ?? { canceled: true, filePaths: [] },
  };
}

describe("project IPC handlers", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "robostudio-project-"));
  });

  afterEach(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("save writes the JSON text to the chosen path", async () => {
    const path = join(dir, "project.json");
    const json = serializeProject(fixture());
    const result = await saveProjectFile(fakeDialogs({ save: { canceled: false, filePath: path } }), json);
    expect(result).toEqual({ kind: "saved", path });
    expect(await readFile(path, "utf8")).toBe(json);
  });

  it("save keeps nothing when the operator cancels the dialog", async () => {
    const path = join(dir, "never-written.json");
    const result = await saveProjectFile(fakeDialogs({ save: { canceled: true, filePath: path } }), "{}");
    expect(result).toEqual({ kind: "canceled" });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("save reports an unwritable target as a named IoFailed error", async () => {
    // A path inside a file is guaranteed to fail the write.
    const blocker = join(dir, "blocker.json");
    const result = await saveProjectFile(
      fakeDialogs({ save: { canceled: false, filePath: join(blocker, "impossible.json") } }),
      "{}",
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.tag).toBe("IoFailed");
    expect(result.error.message).toContain("impossible.json");
  });

  it("open reads the chosen file and returns validated content", async () => {
    const path = join(dir, "project.json");
    const json = serializeProject(fixture());
    await saveProjectFile(fakeDialogs({ save: { canceled: false, filePath: path } }), json);
    const result = await openProjectFile(fakeDialogs({ open: { canceled: false, filePaths: [path] } }));
    expect(result).toEqual({ kind: "loaded", path, content: parseProject(json) });
  });

  it("open keeps the drawing untouched when the operator cancels", async () => {
    const result = await openProjectFile(fakeDialogs({}));
    expect(result).toEqual({ kind: "canceled" });
  });

  it("open reports a bad schema version as a named error, readable", async () => {
    const path = join(dir, "future.json");
    const future = serializeProject(fixture()).replace(/"schemaVersion": 1/, "\"schemaVersion\": 42");
    await saveProjectFile(fakeDialogs({ save: { canceled: false, filePath: path } }), future);
    const result = await openProjectFile(fakeDialogs({ open: { canceled: false, filePaths: [path] } }));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.tag).toBe("UnsupportedSchemaVersion");
    expect(result.error.message).toContain("42");
  });

  it("open reports an unreadable file as a named IoFailed error", async () => {
    const missing = join(dir, "vanishes-between-dialog-and-read.json");
    const result = await openProjectFile(fakeDialogs({ open: { canceled: false, filePaths: [missing] } }));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.tag).toBe("IoFailed");
    expect(result.error.message).toContain(missing);
  });
});

/** A saved content fixture with every segment kind. */
function fixture(): ProjectContent {
  return {
    view: { plane: "XY", fixedMm: 0, feedMmMin: 1200 },
    home: { x: 0, y: 0, z: 0 },
    segments: [],
  };
}
