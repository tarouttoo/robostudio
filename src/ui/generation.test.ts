import { describe, expect, it } from "vitest";

import { PIPELINE_STAGES, runPipeline } from "../export";
import { line, trajectory } from "../core/trajectory";
import { vec3 } from "../core/vec";
import { createPchipPlanner } from "../motion";
import type { JointAngles, RobotModel } from "../kinematics/robot-model";
import type { ProjectContent } from "../project";
import { editorReducer, initialEditorState, type EditorState } from "./editor";
import {
  createGenerationSession,
  generationIsStale,
  generationLogLines,
  stageLabel,
  type GenerationOutcome,
  type GenerationSession,
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

/** The scripted model's workspace: targets past this x are unreachable, in mm. */
const SCRIPTED_REACH_X_MM = 120;

/**
 * A scripted minimal Robot Model at the RobotModel seam (ADR 0004):
 * identity FK/IK with generous limits, unreachable past
 * {@link SCRIPTED_REACH_X_MM} — no MiKo-mini kinematics, so the
 * generation lifecycle tests exercise the session, not the robot.
 */
function scriptedModel(): RobotModel {
  const joints = [1, 2, 3].map((i) => ({
    name: `q${i}`,
    minRad: -1e6,
    maxRad: 1e6,
    maxVelocityRadS: 1e6,
    maxAccelerationRadS2: 1e6,
    maxJerkRadS3: 1e6,
  }));
  return {
    id: "scripted-test",
    name: "Scripted test model",
    joints,
    forwardKinematics: (angles: JointAngles) => [angles[0] as number, angles[1] as number, angles[2] as number],
    inverseKinematics: (target) =>
      (target[0] ?? 0) > SCRIPTED_REACH_X_MM
        ? { status: "unreachable" }
        : { status: "ok", joints: [...target] as JointAngles },
  };
}

/** The headless pipeline run for the same input the session receives. */
function directPipelineRun(model: RobotModel, state: EditorState) {
  const home = state.home;
  if (home === null) throw new Error("directPipelineRun needs a Home Point");
  return runPipeline({
    trajectory: trajectory(home, state.segments),
    model,
    planner: createPchipPlanner(model),
  });
}

/** Runs the session, failing the test unless the outcome is `ok`. */
function okOutcome(session: GenerationSession, state: EditorState): Extract<GenerationOutcome, { kind: "ok" }> {
  const outcome = session.run(state);
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  return outcome;
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

describe("generation: session", () => {
  it("binds the model once: repeated runs match a fresh pipeline run of the same input", () => {
    const model = scriptedModel();
    const session = createGenerationSession(model);
    const fresh = directPipelineRun(model, stateWith(REACHABLE_LINE));
    for (const outcome of [okOutcome(session, stateWith(REACHABLE_LINE)), okOutcome(session, stateWith(REACHABLE_LINE))]) {
      expect(outcome.result.plan).toEqual(fresh.plan);
      expect(outcome.result.robotCsv).toBe(fresh.robotCsv);
      expect(outcome.result.rvizCsv).toBe(fresh.rvizCsv);
    }
  });

  it("a successful run returns the plan and both CSVs, identical to the headless pipeline's output", () => {
    const model = scriptedModel();
    const outcome = okOutcome(createGenerationSession(model), stateWith(REACHABLE_LINE));
    const direct = directPipelineRun(model, stateWith(REACHABLE_LINE));
    expect(outcome.result.plan).toEqual(direct.plan);
    expect(outcome.result.robotCsv).toBe(direct.robotCsv);
    expect(outcome.result.rvizCsv).toBe(direct.rvizCsv);
    expect(outcome.result.stages).toEqual(direct.stages);
    // The outcome remembers the exact Trajectory that was generated.
    expect(outcome.trajectory.home).toBe(HOME);
    expect(outcome.trajectory.segments).toBe(REACHABLE_LINE);
  });

  it("runs every validation stage in order and reports its outcome", () => {
    const outcome = okOutcome(createGenerationSession(scriptedModel()), stateWith(REACHABLE_LINE));
    expect(outcome.result.stages.map((s) => s.stage)).toEqual([...PIPELINE_STAGES]);
    expect(outcome.result.robotCsv.startsWith("t,q1,q2,q3\n")).toBe(true);
    expect(outcome.result.rvizCsv.startsWith("t,q1,q2,q3\n")).toBe(true);
  });

  it("runs the shipped MiKo-mini configuration: the app's model passes through the session", () => {
    const outcome = okOutcome(createGenerationSession(MIKO_MINI), stateWith(REACHABLE_LINE));
    expect(outcome.result.stages.map((s) => s.stage)).toEqual([...PIPELINE_STAGES]);
    expect(outcome.result.plan.rows.length).toBeGreaterThan(50);
  });

  it("stops with a named failure when the model cannot reach a point", () => {
    const far = [line({ start: HOME, end: vec3(300, 0, 60), feed: 20 })];
    const outcome = createGenerationSession(scriptedModel()).run(stateWith(far));
    if (outcome.kind !== "failed") throw new Error(`expected failed, got ${outcome.kind}`);
    expect(outcome.error.stage).toBe("ik");
    expect(outcome.error.message).toMatch(/outside the robot's workspace/);
  });

  it("stops with a named failure when the drawing moves no pen", () => {
    const degenerate = [line({ start: HOME, end: HOME, feed: 20 })];
    const outcome = createGenerationSession(scriptedModel()).run(stateWith(degenerate));
    if (outcome.kind !== "failed") throw new Error(`expected failed, got ${outcome.kind}`);
    expect(outcome.error.stage).toBe("discretization");
    expect(outcome.error.message).toMatch(/draws nothing/);
  });

  it("refuses generation without a Home Point, naming what to set", () => {
    const outcome = createGenerationSession(scriptedModel()).run({
      ...initialEditorState,
      segments: REACHABLE_LINE,
    });
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
    const outcome = okOutcome(createGenerationSession(MIKO_MINI), restored);
    expect(outcome.result.plan.rows.length).toBeGreaterThan(50);
  });
});

describe("generation: log lines", () => {
  it("on success lists every stage outcome plus a completion line", () => {
    const outcome = okOutcome(createGenerationSession(scriptedModel()), stateWith(REACHABLE_LINE));
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
    const outcome = createGenerationSession(scriptedModel()).run(stateWith(far));
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
    const outcome = createGenerationSession(scriptedModel()).run({ ...initialEditorState });
    if (outcome.kind !== "blocked") throw new Error(`expected blocked, got ${outcome.kind}`);
    expect(generationLogLines(outcome)).toEqual([{ kind: "blocked", text: outcome.reason }]);
  });
});

describe("generation: staleness after edits", () => {
  it("a fresh successful generation is not stale", () => {
    const session = createGenerationSession(scriptedModel());
    const state = stateWith(REACHABLE_LINE);
    const outcome = session.run(state);
    expect(generationIsStale(outcome, state)).toBe(false);
  });

  it("editing the drawing after generation is stale (Feed edit, new Home Point)", () => {
    const session = createGenerationSession(scriptedModel());
    const state = stateWith(REACHABLE_LINE);
    const outcome = okOutcome(session, state);
    const feedEdited = editorReducer(state, { type: "setSegmentFeedMmMin", index: 0, raw: "600" });
    expect(generationIsStale(outcome, feedEdited)).toBe(true);
    const homeMoved = editorReducer({ ...state, tool: "home" }, { type: "canvasClick", u: 90, v: 0 });
    expect(generationIsStale(outcome, homeMoved)).toBe(true);
  });

  it("failed or blocked generations are never stale, and neither is no generation", () => {
    const session = createGenerationSession(scriptedModel());
    const state = stateWith(REACHABLE_LINE);
    const failed = session.run(stateWith([line({ start: HOME, end: vec3(300, 0, 60), feed: 20 })]));
    expect(generationIsStale(failed, state)).toBe(false);
    const blocked = session.run({ ...initialEditorState });
    expect(generationIsStale(blocked, state)).toBe(false);
    expect(generationIsStale(null, state)).toBe(false);
  });
});
