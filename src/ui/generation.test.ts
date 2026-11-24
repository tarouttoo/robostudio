import { describe, expect, it } from "vitest";

import { CHART_IDS, PIPELINE_STAGES, renderCharts, runPipeline } from "../export";
import { line, trajectory } from "../core/trajectory";
import { vec3 } from "../core/vec";
import { createPchipPlanner } from "../motion";
import type { JointAngles, RobotModel } from "../kinematics/robot-model";
import type { ProjectContent } from "../project";
import { editorReducer, initialEditorState, type EditorState } from "./editor";
import {
  createGenerationSession,
  exportEligibility,
  generationLogLines,
  stageLabel,
  viewAfterGeneration,
  type GenerationOutcome,
  type GenerationSession,
  type MainView,
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
    // Unused by these tests; the interface requires a finite bound.
    workspaceRadiusMm: 1000,
    forwardKinematics: (angles: JointAngles) => [angles[0] as number, angles[1] as number, angles[2] as number],
    chainPoints: (angles: JointAngles) => [
      [0, 0, 0],
      [0, 0, 0],
      [angles[0] as number, 0, 0],
      [angles[1] as number, 0, 0],
      [angles[2] as number, 0, 0],
    ],
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

  it("serves different drawings from one binding: every run matches its own fresh pipeline run", () => {
    const model = scriptedModel();
    const session = createGenerationSession(model);
    const short = stateWith(REACHABLE_LINE);
    const longer = stateWith([line({ start: HOME, end: vec3(110, 0, 60), feed: 40 })]);
    // A failed run sits between the successful ones; the shared binding
    // serves every run without carrying results across.
    const failed = session.run(stateWith([line({ start: HOME, end: vec3(300, 0, 60), feed: 20 })]));
    if (failed.kind !== "failed") throw new Error(`expected failed, got ${failed.kind}`);
    for (const state of [short, longer, short]) {
      const outcome = okOutcome(session, state);
      const fresh = directPipelineRun(model, state);
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

  it("plans a chained Move → Arc → Move drawing continuously through the shipped MiKo-mini", () => {
    // Drawn through the editor reducer around the default Home Point
    // [213, 0, 305]: a LIN Move, a chained radius-mode Arc (R = 10),
    // and a chained Move — one continuous Trajectory, every join exact.
    let state: EditorState = { ...initialEditorState, plane: "XY", fixedMm: 305 };
    state = editorReducer(state, { type: "canvasClick", u: 223, v: 0 });
    state = editorReducer({ ...state, tool: "arc", arcRadiusMm: 10 }, { type: "canvasClick", u: 231, v: 0 });
    state = editorReducer({ ...state, tool: "point" }, { type: "canvasClick", u: 239, v: 0 });
    expect(state.segments.map((s) => s.kind)).toEqual(["point", "arc", "point"]);
    const outcome = okOutcome(createGenerationSession(MIKO_MINI), state);
    // Every validation stage ran — the chained joins plan continuously.
    expect(outcome.result.stages.map((s) => s.stage)).toEqual([...PIPELINE_STAGES]);
    // The Motion Plan spans the whole chained path: Move + arc + Move.
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
      home: null, // the editor defaults to [213, 0, 305]; unset it explicitly
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

describe("generation: the outcome carries its charts", () => {
  it("a successful outcome carries every chart document, in run order", () => {
    const outcome = okOutcome(createGenerationSession(scriptedModel()), stateWith(REACHABLE_LINE));
    expect(outcome.charts.map((chart) => chart.id)).toEqual([...CHART_IDS]);
  });

  it("the carried documents are the headless renderer's output for the run's plan and the session's bound model", () => {
    const model = scriptedModel();
    const outcome = okOutcome(createGenerationSession(model), stateWith(REACHABLE_LINE));
    expect(outcome.charts).toEqual(renderCharts(outcome.result.plan, model));
    // The shipped MiKo-mini configuration renders through its own
    // bound model the same way.
    const miko = okOutcome(createGenerationSession(MIKO_MINI), stateWith(REACHABLE_LINE));
    expect(miko.charts).toEqual(renderCharts(miko.result.plan, MIKO_MINI));
  });

  it("regeneration replaces the carried charts with the new plan's documents", () => {
    const session = createGenerationSession(MIKO_MINI);
    const first = okOutcome(session, stateWith([line({ start: HOME, end: vec3(100, 0, 60), feed: 20 })]));
    const second = okOutcome(session, stateWith([line({ start: HOME, end: vec3(180, 0, 60), feed: 20 })]));
    // Every chart redraws: no document survives the regeneration as-is.
    expect(second.charts.map((chart) => chart.svg)).not.toEqual(first.charts.map((chart) => chart.svg));
    // The new data is the new plan's: the time axis labels the longer
    // plan's duration, not the first run's.
    const durationMs = Math.max(...second.result.plan.rows.map((row) => row.tMs));
    const positions = second.charts.find((chart) => chart.id === "joint-positions");
    if (!positions) throw new Error("expected a joint-positions chart");
    const tickTexts = [...positions.svg.matchAll(/<text class="tick-x"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1] as string);
    expect(tickTexts).toContain(String(durationMs));
  });

  it("failed and blocked outcomes carry no charts", () => {
    const session = createGenerationSession(scriptedModel());
    const failed = session.run(stateWith([line({ start: HOME, end: vec3(300, 0, 60), feed: 20 })]));
    if (failed.kind !== "failed") throw new Error(`expected failed, got ${failed.kind}`);
    expect("charts" in failed).toBe(false);
    const blocked = session.run({ ...initialEditorState, home: null });
    if (blocked.kind !== "blocked") throw new Error(`expected blocked, got ${blocked.kind}`);
    expect("charts" in blocked).toBe(false);
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
    const outcome = createGenerationSession(scriptedModel()).run({ ...initialEditorState, home: null });
    if (outcome.kind !== "blocked") throw new Error(`expected blocked, got ${outcome.kind}`);
    expect(generationLogLines(outcome)).toEqual([{ kind: "blocked", text: outcome.reason }]);
  });
});

describe("generation: export eligibility", () => {
  it("a fresh successful generation is eligible, carrying exactly the CSVs and the GIF it generated", () => {
    const session = createGenerationSession(scriptedModel());
    const state = stateWith(REACHABLE_LINE);
    const outcome = okOutcome(session, state);
    const eligibility = exportEligibility(outcome, state);
    if (eligibility.kind !== "eligible") throw new Error(`expected eligible, got ${eligibility.kind}`);
    expect(eligibility.robotCsv).toBe(outcome.result.robotCsv);
    expect(eligibility.rvizCsv).toBe(outcome.result.rvizCsv);
    expect(eligibility.motionGif).toBe(outcome.result.motionGif);
  });

  it("editing the drawing after a successful generation goes stale, with the module's Russian regeneration notice", () => {
    const session = createGenerationSession(scriptedModel());
    const state = stateWith(REACHABLE_LINE);
    const outcome = okOutcome(session, state);
    const feedEdited = editorReducer(state, { type: "setSegmentFeedMmMin", index: 0, raw: "600" });
    const stale = exportEligibility(outcome, feedEdited);
    if (stale.kind !== "stale") throw new Error(`expected stale, got ${stale.kind}`);
    expect(stale.notice).toContain("Чертёж изменился");
    expect(stale.notice).toContain("сгенерируйте заново");
    const homeMoved = editorReducer({ ...state, tool: "home" }, { type: "canvasClick", u: 90, v: 0 });
    expect(exportEligibility(outcome, homeMoved).kind).toBe("stale");
  });

  it("regenerating after an edit is eligible again, with the new run's CSVs and GIF", () => {
    const session = createGenerationSession(scriptedModel());
    const state = stateWith(REACHABLE_LINE);
    const outcome = okOutcome(session, state);
    const edited = editorReducer(state, { type: "setSegmentFeedMmMin", index: 0, raw: "600" });
    expect(exportEligibility(outcome, edited).kind).toBe("stale");
    const regenerated = okOutcome(session, edited);
    const eligibility = exportEligibility(regenerated, edited);
    if (eligibility.kind !== "eligible") throw new Error(`expected eligible, got ${eligibility.kind}`);
    expect(eligibility.robotCsv).toBe(regenerated.result.robotCsv);
    expect(eligibility.rvizCsv).toBe(regenerated.result.rvizCsv);
    expect(eligibility.motionGif).toBe(regenerated.result.motionGif);
  });

  it("without a successful generation export stays locked: no run yet, a failed or a blocked attempt", () => {
    const session = createGenerationSession(scriptedModel());
    const state = stateWith(REACHABLE_LINE);
    expect(exportEligibility(null, state).kind).toBe("no-success");
    const failed = session.run(stateWith([line({ start: HOME, end: vec3(300, 0, 60), feed: 20 })]));
    expect(exportEligibility(failed, state).kind).toBe("no-success");
    const blocked = session.run({ ...initialEditorState });
    expect(exportEligibility(blocked, state).kind).toBe("no-success");
  });
});

describe("generation: landing view after an attempt", () => {
  it("a successful attempt lands on the charts; a failed or blocked attempt returns to the drawing", () => {
    const session = createGenerationSession(scriptedModel());
    // A successful run opens the refreshed charts.
    const ok = okOutcome(session, stateWith(REACHABLE_LINE));
    expect(viewAfterGeneration(ok)).toBe<MainView>("charts");
    // A failed run keeps no charts: the tab locks, the operator lands
    // on the drawing while the sidebar log names the failure.
    const failed = session.run(stateWith([line({ start: HOME, end: vec3(300, 0, 60), feed: 20 })]));
    if (failed.kind !== "failed") throw new Error(`expected failed, got ${failed.kind}`);
    expect(viewAfterGeneration(failed)).toBe<MainView>("drawing");
    // Same for a blocked start (no Home Point set).
    const blocked = session.run({ ...initialEditorState, home: null, segments: [line({ start: HOME, end: vec3(100, 0, 60), feed: 20 })] });
    if (blocked.kind !== "blocked") throw new Error(`expected blocked, got ${blocked.kind}`);
    expect(viewAfterGeneration(blocked)).toBe<MainView>("drawing");
  });
});
