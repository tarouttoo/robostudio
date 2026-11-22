/**
 * The drawing editor's application state: the Working Plane with its
 * fixed coordinate, the Feed, the active tool, the Home Point, and the
 * canonical Segments in draw order. A plain reducer over immutable
 * records — drawn geometry enters the state as canonical Segments built
 * by the core (`line`), never as screen coordinates.
 *
 * Unit conventions follow GLOSSARY.md: the UI works in mm/min (CNC
 * convention), the internal unit is mm/s; conversion happens here, in
 * one place, when a Segment is constructed.
 */

import {
  line,
  planeAxes,
  planePoint,
  vec2,
  type Segment,
  type Vec2,
  type Vec3,
  type WorkingPlane,
} from "../core";
import type { ProjectContent } from "../project";

/** The active drawing tool: Line (two clicks) or Home Point (one click). */
export type EditorTool = "line" | "home";

/** The editor's application state. */
export interface EditorState {
  /** Working Plane the operator draws on. */
  readonly plane: WorkingPlane;
  /** The plane's fixed third coordinate, in millimetres. */
  readonly fixedMm: number;
  /** Feed shown in the UI, in mm/min. */
  readonly feedMmMin: number;
  /** Active tool. */
  readonly tool: EditorTool;
  /** The Home Point, or null while unset. */
  readonly home: Vec3 | null;
  /** Canonical Segments in draw order. */
  readonly segments: readonly Segment[];
  /** Pending Line start in plane millimetres, or null before the first click. */
  readonly draftStart: Vec2 | null;
}

/** Default Feed shown in the UI: 1200 mm/min = 20 mm/s. */
export const DEFAULT_FEED_MM_MIN = 1200;

/** The initial editor state: XY plane at fixed 0, Line tool, empty canvas. */
export const initialEditorState: EditorState = {
  plane: "XY",
  fixedMm: 0,
  feedMmMin: DEFAULT_FEED_MM_MIN,
  tool: "line",
  home: null,
  segments: [],
  draftStart: null,
};

/** Actions the editor reducer understands. */
export type EditorAction =
  | { readonly type: "setPlane"; readonly plane: WorkingPlane }
  | { readonly type: "setFixedMm"; readonly raw: string }
  | { readonly type: "setFeedMmMin"; readonly raw: string }
  | { readonly type: "setTool"; readonly tool: EditorTool }
  | { readonly type: "canvasClick"; readonly u: number; readonly v: number }
  | { readonly type: "cancelDraft" }
  | { readonly type: "undo" }
  | { readonly type: "clear" }
  | { readonly type: "loadProject"; readonly content: ProjectContent };

/** Converts a UI Feed in mm/min to the internal mm/s. */
export function mmMinToMmS(feedMmMin: number): number {
  return feedMmMin / 60;
}

/** Converts an internal Feed in mm/s to the UI's mm/min. */
export function mmSToMmMin(feedMmS: number): number {
  return feedMmS * 60;
}

/**
 * The display axis letters of a Working Plane: the (u, v) axes the
 * operator moves along and the fixed w axis, in that plane's order.
 */
export function planeAxisLetters(plane: WorkingPlane): { u: string; v: string; w: string } {
  const letters = ["X", "Y", "Z"];
  const axes = planeAxes[plane];
  return {
    u: letters[axes.u] ?? "X",
    v: letters[axes.v] ?? "Y",
    w: letters[axes.w] ?? "Z",
  };
}

/**
 * Applies an editor action. Parsing actions (`setFixedMm`,
 * `setFeedMmMin`) keep the previous value on invalid input rather than
 * breaking the drawing setup; `canvasClick` ignores non-finite plane
 * coordinates. All geometry is placed on the current plane's fixed
 * coordinate, so drawing stays on the plane across clicks.
 */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "setPlane":
      // The fixed value carries over as the new plane's fixed coordinate;
      // a pending Line started on the old plane is cancelled.
      return { ...state, plane: action.plane, draftStart: null };
    case "setFixedMm":
      return { ...state, fixedMm: parseNumberOr(action.raw, state.fixedMm) };
    case "setFeedMmMin":
      return {
        ...state,
        feedMmMin: parsePositiveNumberOr(action.raw, state.feedMmMin),
      };
    case "setTool":
      return { ...state, tool: action.tool, draftStart: null };
    case "canvasClick": {
      const { u, v } = action;
      if (!(Number.isFinite(u) && Number.isFinite(v))) return state;
      const target = planePoint(state.plane, u, v, state.fixedMm);
      if (state.tool === "home") return { ...state, home: target };
      if (state.draftStart === null) return { ...state, draftStart: vec2(u, v) };
      const start = planePoint(state.plane, state.draftStart.x, state.draftStart.y, state.fixedMm);
      const segment = line({ start, end: target, feed: mmMinToMmS(state.feedMmMin) });
      return { ...state, segments: [...state.segments, segment], draftStart: null };
    }
    case "cancelDraft":
      return { ...state, draftStart: null };
    case "undo":
      return { ...state, segments: state.segments.slice(0, -1) };
    case "clear":
      return { ...state, segments: [], home: null, draftStart: null };
    case "loadProject":
      // The content is already validated by the project layer; restore
      // the drawing (view settings, Home Point, Segments) wholesale and
      // drop any pending draft. The active tool is not part of the
      // drawing and stays as the operator left it.
      return {
        ...state,
        plane: action.content.view.plane,
        fixedMm: action.content.view.fixedMm,
        feedMmMin: action.content.view.feedMmMin,
        home: action.content.home,
        segments: [...action.content.segments],
        draftStart: null,
      };
  }
}

/**
 * Collects the Project File content from the editor state: the view
 * settings (Working Plane, fixed coordinate, default Feed in mm/min),
 * the Home Point, and the canonical Segments. Transient state (active
 * tool, pending draft) is not saved.
 */
export function projectContentOf(state: EditorState): ProjectContent {
  return {
    view: { plane: state.plane, fixedMm: state.fixedMm, feedMmMin: state.feedMmMin },
    home: state.home,
    segments: state.segments,
  };
}

/** Parses `raw` as any finite number, falling back to `fallback`. */
function parseNumberOr(raw: string, fallback: number): number {
  const parsed = Number(raw);
  return raw.trim() !== "" && Number.isFinite(parsed) ? parsed : fallback;
}

/** Parses `raw` as a strictly positive finite number, falling back. */
function parsePositiveNumberOr(raw: string, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
