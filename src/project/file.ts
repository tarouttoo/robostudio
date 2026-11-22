/**
 * The versioned Project File (Файл проекта): JSON with a `schemaVersion`
 * storing the view settings (Working Plane with its fixed coordinate and
 * the default Feed in mm/min), the Home Point, and the canonical
 * Segments with their Feeds — the canonical save/load format
 * (GLOSSARY.md, Spec #1 decision 31).
 *
 * Serialization is plain, hand-inspectable JSON in internal units
 * (millimetres, mm/s, radians). Parsing rebuilds every Segment through
 * the core constructors, so a loaded file is re-validated from scratch:
 * a corrupt file fails with a named error, never with silently wrong
 * geometry.
 *
 * May import only from `core`.
 */

import {
  arcFromCenter,
  line,
  point,
  type ArcDirection,
  type Segment,
  type Vec3,
  type WorkingPlane,
} from "../core";

/**
 * The schema version this app writes and reads. Files with any other
 * version — newer or unknown — fail to open with a readable error
 * naming both versions, instead of loading garbage.
 */
export const PROJECT_SCHEMA_VERSION = 1;

/**
 * The view settings restored with the drawing: the Working Plane the
 * operator drew on, its fixed third coordinate, and the default Feed
 * shown in the UI (mm/min) for the next Segment.
 */
export interface ProjectView {
  /** Working Plane the operator draws on. */
  readonly plane: WorkingPlane;
  /** The plane's fixed third coordinate, in millimetres. */
  readonly fixedMm: number;
  /** Default Feed shown in the UI, in mm/min. */
  readonly feedMmMin: number;
}

/**
 * The content of a Project File: what the editor restores on open. The
 * Home Point and Segments form the Trajectory; the view settings are
 * the drawing setup around it.
 */
export interface ProjectContent {
  /** View settings: Working Plane, fixed coordinate, default Feed. */
  readonly view: ProjectView;
  /** The Home Point, or null while unset. */
  readonly home: Vec3 | null;
  /** Canonical Segments in draw order, each with its Feed (mm/s). */
  readonly segments: readonly Segment[];
}

/** JSON shape of a point (millimetres, one field per axis). */
interface PointJson {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** JSON shape of one Segment: the geometric definition + Feed. */
type SegmentJson =
  | { readonly kind: "line"; readonly start: PointJson; readonly end: PointJson; readonly feed: number }
  | { readonly kind: "point"; readonly target: PointJson; readonly feed: number }
  | {
      readonly kind: "arc";
      readonly plane: WorkingPlane;
      readonly start: PointJson;
      readonly end: PointJson;
      readonly direction: ArcDirection;
      readonly center: PointJson;
      readonly feed: number;
    };

/** JSON shape of a Project File. */
interface ProjectFileJson {
  readonly schemaVersion: number;
  readonly view: ProjectView;
  readonly home: PointJson | null;
  readonly segments: readonly SegmentJson[];
}

/** Converts a Segment to its stored JSON form. */
function segmentToJson(segment: Segment): SegmentJson {
  switch (segment.kind) {
    case "line":
      return {
        kind: "line",
        start: { ...segment.start },
        end: { ...segment.end },
        feed: segment.feed,
      };
    case "point":
      return { kind: "point", target: { ...segment.target }, feed: segment.feed };
    case "arc":
      // Only the geometric definition is stored: radius and sweep derive
      // from the center at parse time, so a stored file cannot disagree
      // with itself on derived values.
      return {
        kind: "arc",
        plane: segment.plane,
        start: { ...segment.start },
        end: { ...segment.end },
        direction: segment.direction,
        center: { ...segment.center },
        feed: segment.feed,
      };
  }
}

/**
 * Serializes Project File content to versioned JSON text — the exact
 * bytes the app writes to disk. Indented for hand inspection; parse is
 * indifferent to formatting.
 */
export function serializeProject(content: ProjectContent): string {
  const file: ProjectFileJson = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    view: content.view,
    home: content.home === null ? null : { ...content.home },
    segments: content.segments.map(segmentToJson),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Parses Project File text into validated content. Rebuilds every
 * Segment through the core constructors, so the result is canonical and
 * the geometry is re-checked from scratch. Fails with a named
 * `ProjectError`:
 *
 * - `UnsupportedSchemaVersion` — the `schemaVersion` is any number
 *   other than the supported one (newer or unknown); the message names
 *   both versions and is operator-readable.
 * - `InvalidProjectFile` — malformed JSON, or a shape the schema does
 *   not describe. `CoreError`s from the core constructors (impossible
 *   geometry, bad Feed) propagate unchanged: they are equally named and
 *   readable.
 */
export function parseProject(json: string): ProjectContent {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new ProjectError(
      "InvalidProjectFile",
      `Project File is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!isObject(value)) {
    throw new ProjectError(
      "InvalidProjectFile",
      `Project File must be a JSON object, got ${JSON.stringify(value)}`,
    );
  }
  const version = value["schemaVersion"];
  if (typeof version !== "number" || !Number.isFinite(version)) {
    throw new ProjectError(
      "InvalidProjectFile",
      `Project File: "schemaVersion" must be a number, got ${JSON.stringify(version)}`,
    );
  }
  if (version !== PROJECT_SCHEMA_VERSION) {
    throw new ProjectError(
      "UnsupportedSchemaVersion",
      version > PROJECT_SCHEMA_VERSION
        ? `Project File schema version ${version} is newer than this app supports (version ${PROJECT_SCHEMA_VERSION}): update robostudio to open this file.`
        : `Project File schema version ${version} is unknown; this app supports version ${PROJECT_SCHEMA_VERSION}. The file may be damaged.`,
    );
  }
  return {
    view: requireView(value),
    home: requireHome(value),
    segments: requireSegments(value),
  };
}

import { ProjectError } from "./errors";

/** Type guard: the value is a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a required finite number, failing with a readable message. */
function requireNumber(record: Record<string, unknown>, field: string, where: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProjectError(
      "InvalidProjectFile",
      `${where}: field "${field}" must be a finite number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Reads a required JSON point (three finite millimetre coordinates). */
function requirePoint(record: Record<string, unknown>, field: string, where: string): Vec3 {
  const value = record[field];
  if (!isObject(value)) {
    throw new ProjectError(
      "InvalidProjectFile",
      `${where}: field "${field}" must be a point object {x, y, z}, got ${JSON.stringify(value)}`,
    );
  }
  return {
    x: requireNumber(value, "x", `${where}.${field}`),
    y: requireNumber(value, "y", `${where}.${field}`),
    z: requireNumber(value, "z", `${where}.${field}`),
  };
}

/** Reads a required positive Feed (mm/s, or the default Feed in mm/min). */
function requireFeed(record: Record<string, unknown>, field: string, where: string): number {
  const feed = requireNumber(record, field, where);
  if (feed <= 0) {
    throw new ProjectError(
      "InvalidProjectFile",
      `${where}: "${field}" must be a positive number, got ${feed}`,
    );
  }
  return feed;
}

/** Reads a required Segment of a known kind, re-validated by the core. */
function requireSegment(value: unknown, where: string): Segment {
  if (!isObject(value)) {
    throw new ProjectError(
      "InvalidProjectFile",
      `${where}: must be a Segment object, got ${JSON.stringify(value)}`,
    );
  }
  const kind = value["kind"];
  switch (kind) {
    case "line":
      return line({
        start: requirePoint(value, "start", where),
        end: requirePoint(value, "end", where),
        feed: requireFeed(value, "feed", where),
      });
    case "point":
      return point({ target: requirePoint(value, "target", where), feed: requireFeed(value, "feed", where) });
    case "arc":
      return arcFromCenter({
        plane: requirePlane(value, where),
        start: requirePoint(value, "start", where),
        end: requirePoint(value, "end", where),
        center: requirePoint(value, "center", where),
        direction: requireDirection(value, where),
        feed: requireFeed(value, "feed", where),
      });
    default:
      throw new ProjectError(
        "InvalidProjectFile",
        `${where}: unknown Segment kind ${JSON.stringify(kind)}; known kinds are "line", "arc", "point"`,
      );
  }
}

/** Reads a required Working Plane name. */
function requirePlane(record: Record<string, unknown>, where: string): WorkingPlane {
  const value = record["plane"];
  if (value !== "XY" && value !== "XZ" && value !== "YZ") {
    throw new ProjectError(
      "InvalidProjectFile",
      `${where}: "plane" must be "XY", "XZ", or "YZ", got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Reads a required Arc direction. */
function requireDirection(record: Record<string, unknown>, where: string): ArcDirection {
  const value = record["direction"];
  if (value !== "CW" && value !== "CCW") {
    throw new ProjectError(
      "InvalidProjectFile",
      `${where}: "direction" must be "CW" or "CCW", got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Reads the view settings block. */
function requireView(record: Record<string, unknown>): ProjectView {
  const view = record["view"];
  if (!isObject(view)) {
    throw new ProjectError(
      "InvalidProjectFile",
      `Project File: field "view" must be an object, got ${JSON.stringify(view)}`,
    );
  }
  return {
    plane: requirePlane(view, "view"),
    fixedMm: requireNumber(view, "fixedMm", "view"),
    feedMmMin: requireFeed(view, "feedMmMin", "view"),
  };
}

/** Reads the Home Point: null while unset, else a point. */
function requireHome(record: Record<string, unknown>): Vec3 | null {
  const value = record["home"];
  if (value === null || value === undefined) return null;
  if (!isObject(value)) {
    throw new ProjectError(
      "InvalidProjectFile",
      `Project File: field "home" must be a point object or null, got ${JSON.stringify(value)}`,
    );
  }
  return {
    x: requireNumber(value, "x", "home"),
    y: requireNumber(value, "y", "home"),
    z: requireNumber(value, "z", "home"),
  };
}

/** Reads the Segments array (possibly empty). */
function requireSegments(record: Record<string, unknown>): Segment[] {
  const value = record["segments"];
  if (!Array.isArray(value)) {
    throw new ProjectError(
      "InvalidProjectFile",
      `Project File: field "segments" must be an array, got ${JSON.stringify(value)}`,
    );
  }
  return value.map((segment, i) => requireSegment(segment, `segments[${i}]`));
}
