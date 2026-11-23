/**
 * Export layer: the headless pipeline (named validation stage chain)
 * and the `Exporter` implementations — named output writers (Robot CSV
 * and RViz CSV; the byte-level formats are contracts pinned by golden
 * fixtures, ADR 0006).
 *
 * May import from `core`, `kinematics`, and `motion` (ADR 0012: the
 * headless pipeline lives here because it is the seam that produces
 * the exported files, and its input is a Robot Model).
 */

export { PipelineError, type PipelineErrorTag, type PipelineStage } from "./errors";
export { runPipeline, PIPELINE_STAGES } from "./pipeline";
export type {
  PipelineInput,
  PipelineResult,
  PipelineStageOutcome,
} from "./pipeline";
export { toRobotCsv } from "./robot-csv";
export { rvizAngles, toRvizCsv } from "./rviz-csv";
