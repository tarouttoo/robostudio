import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FIXTURE_TRAJECTORY } from "../export/golden/fixture";
import { runPipeline } from "../export";
import { DEFAULT_MIKO_MINI_CONFIG, createMiKoMiniModel } from "../kinematics/miko-mini";
import type { RobotModel } from "../kinematics/robot-model";
import { createSplinePlanner } from "../motion";
import { exportCsvs, MOTION_GIF_FILE, ROBOT_CSV_FILE, RVIZ_CSV_FILE, type ExportDialogs } from "./export-ipc";
import type { ExportCsvsResult as RendererExportCsvsResult } from "../ui/bridge";

/** The default MiKo-mini model from validated configuration. */
const model: RobotModel = (() => {
  const built = createMiKoMiniModel(DEFAULT_MIKO_MINI_CONFIG);
  if (built.status !== "ok") throw new Error(`invalid config: ${built.problems.join("; ")}`);
  return built.model;
})();

/**
 * The folder dialog is a GUI boundary — replaced by a scripted fake.
 * The file store is NOT faked: these tests run against the real file
 * system in a temp directory, so the bytes written are really on disk.
 */
function fakeDialogs(folder: string | null): ExportDialogs {
  return {
    showDirectory: async () =>
      folder === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [folder] },
  };
}

describe("export IPC handlers", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "robostudio-export-"));
  });

  afterEach(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("writes both CSVs and the Motion Preview GIF byte-identical to the headless pipeline output for the same input", async () => {
    // The bytes the renderer hands over come straight from runPipeline;
    // a second, fresh run must reproduce them exactly (deterministic
    // pipeline), and the files on disk must match both (verbatim write).
    // The GIF is binary and must survive as bytes, not as UTF-8 text.
    const first = runPipeline({ trajectory: FIXTURE_TRAJECTORY, model, planner: createSplinePlanner(model) });
    const result = await exportCsvs(fakeDialogs(dir), first.robotCsv, first.rvizCsv, first.motionGif);
    if (result.kind !== "exported") throw new Error(`expected exported, got ${result.kind}`);
    expect(result.folder).toBe(dir);
    expect(result.files).toEqual([join(dir, ROBOT_CSV_FILE), join(dir, RVIZ_CSV_FILE), join(dir, MOTION_GIF_FILE)]);

    const second = runPipeline({ trajectory: FIXTURE_TRAJECTORY, model, planner: createSplinePlanner(model) });
    expect(second.robotCsv).toBe(first.robotCsv);
    expect(second.rvizCsv).toBe(first.rvizCsv);
    expect(second.motionGif).toEqual(first.motionGif);
    expect(await readFile(join(dir, ROBOT_CSV_FILE), "utf8")).toBe(second.robotCsv);
    expect(await readFile(join(dir, RVIZ_CSV_FILE), "utf8")).toBe(second.rvizCsv);
    const gifOnDisk = await readFile(join(dir, MOTION_GIF_FILE));
    expect(new Uint8Array(gifOnDisk)).toEqual(second.motionGif);
    // The GIF file is named robot_motion.gif (the pipeline contract).
    expect(MOTION_GIF_FILE).toBe("robot_motion.gif");
  });

  it("writes nothing when the operator cancels the folder picker", async () => {
    const result = await exportCsvs(fakeDialogs(null), "t,q1,q2,q3\n", "t,q1,q2,q3\n", new Uint8Array([1]));
    expect(result).toEqual({ kind: "canceled" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("reports an unwritable folder as a named IoFailed error", async () => {
    // A path inside a regular file is guaranteed to fail the write.
    const blocker = join(dir, "blocker.txt");
    await writeFile(blocker, "not a folder", "utf8");
    const result = await exportCsvs(fakeDialogs(join(blocker, "nested")), "a", "b", new Uint8Array([1]));
    if (result.kind !== "error") throw new Error(`expected error, got ${result.kind}`);
    expect(result.error.tag).toBe("IoFailed");
    expect(result.error.message).toContain(blocker);
  });

  it("keeps nothing on disk when the folder does not exist and the write fails", async () => {
    const missing = join(dir, "missing-folder");
    const result = await exportCsvs(fakeDialogs(missing), "a", "b", new Uint8Array([1]));
    expect(result.kind).toBe("error");
    expect(await readdir(dir)).toEqual([]);
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a failure while the bytes are produced leaves the previous export untouched", async () => {
    // Re-export into the same folder is the primary operator loop. The
    // second staging file cannot be written (its path is taken by a
    // directory), which — before the staged writes — left a fresh
    // Robot CSV beside the stale RViz CSV: two files describing
    // different runs, and the Robot CSV feeds the controller (ADR
    // 0006). The staged writes keep the old pair byte-identical.
    await writeFile(join(dir, ROBOT_CSV_FILE), "old robot", "utf8");
    await writeFile(join(dir, RVIZ_CSV_FILE), "old rviz", "utf8");
    await mkdir(join(dir, `${RVIZ_CSV_FILE}.partial`));
    const result = await exportCsvs(fakeDialogs(dir), "new robot", "new rviz", new Uint8Array([9, 9, 9]));
    if (result.kind !== "error") throw new Error(`expected error, got ${result.kind}`);
    expect(result.error.tag).toBe("IoFailed");
    expect(await readFile(join(dir, ROBOT_CSV_FILE), "utf8")).toBe("old robot");
    expect(await readFile(join(dir, RVIZ_CSV_FILE), "utf8")).toBe("old rviz");
    // Nothing new: the staging directory (never removed recursively —
    // it could hold the operator's own files) is all that remains.
    expect((await readdir(dir)).sort()).toEqual([ROBOT_CSV_FILE, `${RVIZ_CSV_FILE}.partial`, RVIZ_CSV_FILE].sort());
  });

  it("re-exporting into the same folder replaces all three files and leaves no staging files", async () => {
    await exportCsvs(fakeDialogs(dir), "one robot", "one rviz", new Uint8Array([1]));
    const result = await exportCsvs(fakeDialogs(dir), "two robot", "two rviz", new Uint8Array([2]));
    if (result.kind !== "exported") throw new Error(`expected exported, got ${result.kind}`);
    expect(await readFile(join(dir, ROBOT_CSV_FILE), "utf8")).toBe("two robot");
    expect(await readFile(join(dir, RVIZ_CSV_FILE), "utf8")).toBe("two rviz");
    expect(new Uint8Array(await readFile(join(dir, MOTION_GIF_FILE)))).toEqual(new Uint8Array([2]));
    expect((await readdir(dir)).sort()).toEqual([ROBOT_CSV_FILE, RVIZ_CSV_FILE, MOTION_GIF_FILE].sort());
  });

  it("every outcome satisfies the renderer-side bridge contract (ui/bridge.ts)", async () => {
    // The contract types live on both sides of the IPC boundary (app
    // may not import ui); this assignment is the compile-time pin that
    // keeps them structurally in sync.
    const exported = await exportCsvs(fakeDialogs(dir), "t,q1,q2,q3\n", "t,q1,q2,q3\n", new Uint8Array([1]));
    const asRenderer: RendererExportCsvsResult = exported;
    expect(asRenderer).toEqual(exported);
    expect(asRenderer.kind === "exported" && asRenderer.files.length === 3).toBe(true);
    const canceled: RendererExportCsvsResult = await exportCsvs(fakeDialogs(null), "a", "b", new Uint8Array([1]));
    expect(canceled).toEqual({ kind: "canceled" });
    const blocker = join(dir, "blocker.txt");
    await writeFile(blocker, "not a folder", "utf8");
    const failed: RendererExportCsvsResult = await exportCsvs(fakeDialogs(join(blocker, "nested")), "a", "b", new Uint8Array([1]));
    expect(failed.kind).toBe("error");
  });
});
