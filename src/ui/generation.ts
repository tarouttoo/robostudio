/**
 * Run generation from the app (Spec #1 user story 14): the drawn
 * Trajectory goes through the headless pipeline (`runPipeline`, ADR
 * 0012), and the outcome — every validation stage's outcome, or the
 * named stage failure — becomes a readable log for the operator. The
 * stage names render in Russian per GLOSSARY.md; the stage details are
 * the pipeline's own (English) texts.
 *
 * The Robot Model is bound once, at session creation (ADR 0008): the
 * PCHIP Planner is created inside the session from that model, so the
 * app shell holds one stable reference and a second robot is one
 * configuration change at the factory, not edits at every call site.
 * A successful run renders the Charts right there, through the same
 * headless seam as the pipeline (`renderCharts`, ADR 0013), and the
 * outcome carries them: the «Графики» view shows exactly the documents
 * of the last successful Generation, as data — no view-side
 * re-derivation from plan + model. The pipeline and the chart renderer
 * are the seams: this module only turns editor state into a Trajectory,
 * runs it, and hands over the complete outcome — no plotting or export
 * logic lives here.
 */

import { trajectory, type Trajectory } from "../core";
import {
  PipelineError,
  renderCharts,
  runPipeline,
  type PipelineResult,
  type PipelineStage,
  type RenderedChart,
} from "../export";
import { createPchipPlanner } from "../motion";
import type { RobotModel } from "../kinematics/robot-model";
import type { EditorState } from "./editor";

/** One generation attempt's outcome, shown in the generation log. */
export type GenerationOutcome =
  | {
      /** The pipeline ran to the end; the plan and both CSVs are ready. */
      readonly kind: "ok";
      /** The exact Trajectory that was generated (for staleness checks). */
      readonly trajectory: Trajectory;
      /** The pipeline result: plan, stage outcomes, exported bytes. */
      readonly result: PipelineResult;
      /**
       * Every Chart of this Generation (the eight chart kinds, in run
       * order), rendered at Generation time by the headless renderer
       * (ADR 0013) from the run's Motion Plan and the session's bound
       * Robot Model. The «Графики» view shows exactly these documents.
       */
      readonly charts: readonly RenderedChart[];
    }
  | {
      /** A validation stage failed and stopped the pipeline. */
      readonly kind: "failed";
      /** The named stage failure: stage + operator-readable reason. */
      readonly error: PipelineError;
    }
  | {
      /** Generation could not start (the drawing misses a prerequisite). */
      readonly kind: "blocked";
      /** Operator-readable reason, in Russian. */
      readonly reason: string;
    };

/**
 * A bound Generation session: the Robot Model and its Planner bound
 * once at creation, serving every run from editor state.
 */
export interface GenerationSession {
  /**
   * Runs generation on the drawn Trajectory: builds the Trajectory
   * (Home Point + Segments) and runs it through the headless pipeline
   * with the session's Robot Model and Planner, reporting the outcome.
   * A `PipelineError` becomes a `failed` outcome; a missing Home Point
   * becomes `blocked` — the pen position before the first Segment is
   * part of the Trajectory itself (GLOSSARY.md), so generation without
   * it cannot start. On success the Charts are rendered here, at
   * Generation time, and carried on the outcome.
   */
  run(state: EditorState): GenerationOutcome;
}

/**
 * Binds the Robot Model exactly once (ADR 0008): creates the PCHIP
 * Planner from it inside the session and returns the session the app
 * runs generations through. Runs carry no model or planner at the call
 * site, and repeated runs share the binding.
 */
export function createGenerationSession(model: RobotModel): GenerationSession {
  const planner = createPchipPlanner(model);
  return {
    run: (state: EditorState): GenerationOutcome => {
      if (state.home === null) {
        return {
          kind: "blocked",
          reason:
            "Генерация невозможна: не задана Исходная точка — укажите её инструментом «Исходная точка».",
        };
      }
      const traj = trajectory(state.home, state.segments);
      try {
        const result = runPipeline({ trajectory: traj, model, planner });
        return {
          kind: "ok",
          trajectory: traj,
          result,
          charts: renderCharts(result.plan, model),
        };
      } catch (error) {
        if (error instanceof PipelineError) return { kind: "failed", error };
        throw error;
      }
    },
  };
}

/** The Russian UI name of one validation stage, per GLOSSARY.md. */
export function stageLabel(stage: PipelineStage): string {
  switch (stage) {
    case "discretization":
      return "Дискретизация";
    case "ik":
      return "Достижимость";
    case "motion-plan":
      return "План движения";
    case "collision":
      return "Проверка коллизий";
    case "export":
      return "Экспорт";
  }
}

/** One line of the generation log: its role decides the styling. */
export interface GenerationLogLine {
  /** `ok` — a passed stage; `failed`/`blocked` — the stop reason; `summary` — completion. */
  readonly kind: "ok" | "failed" | "summary" | "blocked";
  /** The line text (Russian heading, pipeline detail). */
  readonly text: string;
}

/**
 * Builds the readable generation log from an outcome: on success one
 * line per validation stage in run order plus a completion line; on a
 * failure a single line naming the failing stage and the reason; on a
 * blocked start the operator reason.
 */
export function generationLogLines(outcome: GenerationOutcome): readonly GenerationLogLine[] {
  switch (outcome.kind) {
    case "ok":
      return [
        ...outcome.result.stages.map(
          (stage): GenerationLogLine => ({
            kind: "ok",
            text: `${stageLabel(stage.stage)}: ${stage.detail}`,
          }),
        ),
        { kind: "summary", text: "Генерация завершена — Robot CSV и RViz CSV готовы к экспорту." },
      ];
    case "failed":
      return [
        {
          kind: "failed",
          text: `Стадия «${stageLabel(outcome.error.stage)}» не пройдена: ${outcome.error.message}`,
        },
      ];
    case "blocked":
      return [{ kind: "blocked", text: outcome.reason }];
  }
}

/**
 * Whether the drawing changed since this generation ran: the exported
 * CSVs must never describe an older drawing, so a stale generation
 * locks the export until the operator regenerates. Compares the
 * generated Trajectory's parts against the live editor state by
 * reference — the immutable reducer replaces `home` and `segments` on
 * every edit that affects the Trajectory.
 */
export function generationIsStale(outcome: GenerationOutcome | null, state: EditorState): boolean {
  if (outcome === null || outcome.kind !== "ok") return false;
  return outcome.trajectory.home !== state.home || outcome.trajectory.segments !== state.segments;
}
