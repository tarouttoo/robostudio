/**
 * Named errors of the export layer's headless pipeline. Every
 * validation stage fails with a `PipelineError` carrying the stage's
 * name and an operator-readable reason, so callers (UI, CLI) can show
 * which stage stopped generation and why (GLOSSARY.md: Validation
 * stages) and recover narrowly via the stable `tag`.
 */

/** The named validation stages of the headless pipeline, in run order. */
export type PipelineStage =
  | "discretization"
  | "ik"
  | "motion-plan"
  | "collision"
  | "export";

/** All error tags the export layer can fail with. */
export type PipelineErrorTag = "PipelineStageFailed";

/**
 * Base class of the pipeline's stage failures. `name` and `tag` both
 * carry the stable discriminant; `stage` names the stage that stopped
 * the chain; `message` is operator-readable (which stage, what went
 * wrong, with the offending numbers).
 */
export class PipelineError extends Error {
  /** Stable discriminant for narrow error handling. */
  readonly tag: PipelineErrorTag = "PipelineStageFailed";

  /** The validation stage that failed and stopped the pipeline. */
  readonly stage: PipelineStage;

  constructor(stage: PipelineStage, message: string) {
    super(message);
    this.name = "PipelineStageFailed";
    this.stage = stage;
  }
}
