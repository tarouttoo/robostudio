import { describe, expect, it } from "vitest";

import { PIPELINE_STAGES } from "../export";
import { line } from "../core/trajectory";
import { vec3 } from "../core/vec";
import type { ProjectContent } from "../project";
import { editorReducer, initialEditorState, type EditorState } from "./editor";
import {
  generationIsStale,
  generationLogLines,
  runGeneration,
  stageLabel,
} from "./generation";
import { MIKO_MINI } from "./robot";

/** A reachable Home Point in the MiKo-mini workspace (as in the pipeline tests). */
const HOME = vec3(80, 0, 60);

/** A Line into the workspace, starting at the Home Point. */
const REACHABLE_LINE = [line({ start: HOME, end: vec3(100, 0, 60), feed: 20 })];

/** Editor state holding exactly this drawing: Home Point plus Segments. */
function stateWith(segments: EditorState["segments"], home: EditorState["home"] = HOME): EditorState {
  return { ...initialEditorState, home, segments };
}

describe("generation: stage labels", () => {
  it("names every validation stage in Russian per GLOSSARY", () => {
    expect(stageLabel("discretization")).toBe("Дискретизация");
    expect(stageLabel("ik")).toBe("Достижимость");
    expect(stageLabel("motion-plan")).toBe("План движения");
    expect(stageLabel("collision")).toBe("Проверка коллизий");
    expect(stageLabel("export")).toBe("Экспорт");
  });
});

describe("generation: runGeneration", () => {
  it("runs the pipeline on the drawn Trajectory and returns every stage outcome", () => {
    const outcome = runGeneration(stateWith(REACHABLE_LINE), MIKO_MINI);
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
    expect(outcome.result.stages.map((s) => s.stage)).toEqual([...PIPELINE_STAGES]);
    expect(outcome.result.robotCsv.startsWith("t,q1,q2,q3\n")).toBe(true);
    expect(outcome.result.rvizCsv.startsWith("t,q1,q2,q3\n")).toBe(true);
  });

  it("stops with a named failure when a point is out of reach", () => {
    const far = [line({ start: HOME, end: vec3(300, 0, 60), feed: 20 })];
    const outcome = runGeneration(stateWith(far), MIKO_MINI);
    if (outcome.kind !== "failed") throw new Error(`expected failed, got ${outcome.kind}`);
    expect(outcome.error.stage).toBe("ik");
    expect(outcome.error.message).toMatch(/outside the robot's workspace/);
  });

  it("stops with a named failure when the drawing moves no pen", () => {
    const degenerate = [line({ start: HOME, end: HOME, feed: 20 })];
    const outcome = runGeneration(stateWith(degenerate), MIKO_MINI);
    if (outcome.kind !== "failed") throw new Error(`expected failed, got ${outcome.kind}`);
    expect(outcome.error.stage).toBe("discretization");
    expect(outcome.error.message).toMatch(/draws nothing/);
  });

  it("refuses generation without a Home Point, naming what to set", () => {
    const outcome = runGeneration({ ...initialEditorState, segments: REACHABLE_LINE }, MIKO_MINI);
    if (outcome.kind !== "blocked") throw new Error(`expected blocked, got ${outcome.kind}`);
    expect(outcome.reason).toContain("Исходная точка");
  });

  it("generates from a Trajectory loaded from a Project File", () => {
    const content: ProjectContent = {
      view: { plane: "XY", fixedMm: 0, feedMmMin: 1200 },
      home: HOME,
      segments: REACHABLE_LINE,
    };
    const restored = editorReducer(initialEditorState, { type: "loadProject", content });
    const outcome = runGeneration(restored, MIKO_MINI);
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    expect(outcome.result.plan.rows.length).toBeGreaterThan(50);
  });
});

describe("generation: log lines", () => {
  it("on success lists every stage outcome plus a completion line", () => {
    const outcome = runGeneration(stateWith(REACHABLE_LINE), MIKO_MINI);
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    const lines = generationLogLines(outcome);
    expect(lines.slice(0, -1)).toEqual(
      outcome.result.stages.map((stage) => ({
        kind: "ok",
        text: `${stageLabel(stage.stage)}: ${stage.detail}`,
      })),
    );
    const last = lines[lines.length - 1];
    expect(last?.kind).toBe("summary");
    expect(last?.text).toContain("Robot CSV");
    expect(last?.text).toContain("RViz CSV");
  });

  it("on failure names the failing stage and the reason", () => {
    const far = [line({ start: HOME, end: vec3(300, 0, 60), feed: 20 })];
    const outcome = runGeneration(stateWith(far), MIKO_MINI);
    if (outcome.kind !== "failed") throw new Error(`expected failed, got ${outcome.kind}`);
    const lines = generationLogLines(outcome);
    expect(lines).toEqual([
      {
        kind: "failed",
        text: expect.stringContaining("«Достижимость»") as string,
      },
    ]);
    expect(lines[0]?.text).toContain(outcome.error.message);
  });

  it("on a blocked start carries the operator reason", () => {
    const outcome = runGeneration({ ...initialEditorState }, MIKO_MINI);
    if (outcome.kind !== "blocked") throw new Error(`expected blocked, got ${outcome.kind}`);
    expect(generationLogLines(outcome)).toEqual([{ kind: "blocked", text: outcome.reason }]);
  });
});

describe("generation: staleness after edits", () => {
  it("a fresh successful generation is not stale", () => {
    const state = stateWith(REACHABLE_LINE);
    const outcome = runGeneration(state, MIKO_MINI);
    expect(generationIsStale(outcome, state)).toBe(false);
  });

  it("editing the drawing after generation is stale (Feed edit, new Home Point)", () => {
    const state = stateWith(REACHABLE_LINE);
    const outcome = runGeneration(state, MIKO_MINI);
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    const feedEdited = editorReducer(state, { type: "setSegmentFeedMmMin", index: 0, raw: "600" });
    expect(generationIsStale(outcome, feedEdited)).toBe(true);
    const homeMoved = editorReducer({ ...state, tool: "home" }, { type: "canvasClick", u: 90, v: 0 });
    expect(generationIsStale(outcome, homeMoved)).toBe(true);
  });

  it("failed or blocked generations are never stale, and neither is no generation", () => {
    const state = stateWith(REACHABLE_LINE);
    const failed = runGeneration(stateWith([line({ start: HOME, end: vec3(300, 0, 60), feed: 20 })]), MIKO_MINI);
    expect(generationIsStale(failed, state)).toBe(false);
    const blocked = runGeneration({ ...initialEditorState }, MIKO_MINI);
    expect(generationIsStale(blocked, state)).toBe(false);
    expect(generationIsStale(null, state)).toBe(false);
  });
});
