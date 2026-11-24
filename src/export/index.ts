/**
 * Export layer: the headless pipeline (named validation stage chain)
 * and the `Exporter` implementations — named output writers (Robot CSV
 * and RViz CSV; the byte-level formats are contracts pinned by golden
 * fixtures, ADR 0006).
 *
 * May import from `core`, `kinematics`, and `motion` (ADR 0012: the
 * headless pipeline lives here because it is the seam that produces
 * the exported files, and its input is a Robot Model).
 *
 * The chart renderer (`renderCharts`) is the same seam shape: Motion
 * Plan + Robot Model in, named output documents out (SVG chart files,
 * rendered headless — ADR 0013), so CI verifies every spec plot before
 * any UI exists and the UI shows the very documents CI verified. The
 * Motion Preview (`renderMotionPreviewGif`) completes the family: the
 * animated GIF bytes ride on the pipeline result next to the CSVs.
 */

export { PipelineError, type PipelineErrorTag, type PipelineStage } from "./errors";
export { runPipeline, PIPELINE_STAGES } from "./pipeline";
export type {
  PipelineInput,
  PipelineResult,
  PipelineStageOutcome,
} from "./pipeline";
export { CHART_IDS, renderCharts } from "./charts";
export type { ChartId, RenderedChart } from "./charts";
export { toRobotCsv } from "./robot-csv";
export { rvizAngles, toRvizCsv } from "./rviz-csv";
export { renderMotionPreviewFrames, renderMotionPreviewGif, rasterizePreviewFrame, MOTION_PREVIEW_MAX_FRAMES, MOTION_PREVIEW_WIDTH, MOTION_PREVIEW_HEIGHT, MOTION_PREVIEW_PALETTE, MOTION_PREVIEW_COLORS } from "./motion-preview";
export type { MotionPreviewInput, MotionPreviewFrame, MotionPreviewGif, PreviewPrimitive } from "./motion-preview";
