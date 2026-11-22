/**
 * Project layer: the versioned Project File (Файл проекта) — JSON with
 * `schemaVersion` storing the Working Plane, Home Point, Segments, and
 * view settings; the canonical save/load format.
 *
 * May import only from `core`.
 */
export { PROJECT_SCHEMA_VERSION, parseProject, serializeProject } from "./file";
export type { ProjectContent, ProjectView } from "./file";
export { ProjectError, type ProjectErrorTag } from "./errors";
