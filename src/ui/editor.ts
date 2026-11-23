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
  arcFromCenter,
  arcFromRadius,
  CoreError,
  distance,
  line,
  planeAxes,
  planePoint,
  point,
  vec2,
  type ArcDirection,
  type Segment,
  type Vec2,
  type Vec3,
  type WorkingPlane,
} from "../core";
import type { ProjectContent } from "../project";

/** Arc travel direction, re-exported for the UI that configures it. */
export type { ArcDirection };

/** The active drawing tool: Line (two clicks), Arc, Point (one click), or Home Point (one click). */
export type EditorTool = "line" | "arc" | "point" | "home";

/** How an Arc is defined: radius R (two clicks) or explicit center (three clicks, ADR 0005). */
export type ArcMode = "radius" | "center";

/** Default Arc radius shown in the UI, in millimetres. */
export const DEFAULT_ARC_RADIUS_MM = 10;

/** A click closer than this to the draft start cannot be an Arc center, in mm. */
const CENTER_EPS_MM = 1e-6;

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
  /** How the Arc tool defines an Arc. */
  readonly arcMode: ArcMode;
  /** Arc travel direction the Arc tool commits. */
  readonly arcDirection: ArcDirection;
  /** Arc radius in the radius definition mode, in millimetres. */
  readonly arcRadiusMm: number;
  /** The Home Point, or null while unset. */
  readonly home: Vec3 | null;
  /** Canonical Segments in draw order. */
  readonly segments: readonly Segment[];
  /** Pending draft start in plane millimetres, or null before the first click. */
  readonly draftStart: Vec2 | null;
  /** Pending Arc center in plane millimetres (center mode, after the second click), or null. */
  readonly draftCenter: Vec2 | null;
  /** Readable rejection message of the last failed draw, or null when the last action succeeded. */
  readonly error: string | null;
}

/** Default Feed shown in the UI: 1200 mm/min = 20 mm/s. */
export const DEFAULT_FEED_MM_MIN = 1200;

/** The initial editor state: XY plane at fixed 0, Line tool, empty canvas. */
export const initialEditorState: EditorState = {
  plane: "XY",
  fixedMm: 0,
  feedMmMin: DEFAULT_FEED_MM_MIN,
  tool: "line",
  arcMode: "radius",
  arcDirection: "CCW",
  arcRadiusMm: DEFAULT_ARC_RADIUS_MM,
  home: null,
  segments: [],
  draftStart: null,
  draftCenter: null,
  error: null,
};

/** Actions the editor reducer understands. */
export type EditorAction =
  | { readonly type: "setPlane"; readonly plane: WorkingPlane }
  | { readonly type: "setFixedMm"; readonly raw: string }
  | { readonly type: "setFeedMmMin"; readonly raw: string }
  | { readonly type: "setTool"; readonly tool: EditorTool }
  | { readonly type: "setArcMode"; readonly mode: ArcMode }
  | { readonly type: "setArcDirection"; readonly direction: ArcDirection }
  | { readonly type: "setArcRadiusMm"; readonly raw: string }
  | { readonly type: "canvasClick"; readonly u: number; readonly v: number }
  | { readonly type: "numericEntry"; readonly u: number; readonly v: number }
  | { readonly type: "setSegmentFeedMmMin"; readonly index: number; readonly raw: string }
  | { readonly type: "cancelDraft" }
  | { readonly type: "undo" }
  | { readonly type: "clear" }
  | { readonly type: "loadProject"; readonly content: ProjectContent };

/**
 * Converts a UI Feed in mm/min to the internal mm/s.
 */
export function mmMinToMmS(feedMmMin: number): number {
  return feedMmMin / 60;
}

/**
 * The pending draft as the canvas view needs it: which clicks are done
 * and with which Arc parameters the next click would commit. A pure
 * projection of the editor state — the canvas holds no geometry state
 * itself (ADR 0007). Null when the active tool holds no draft.
 */
export type DraftPreview =
  | { readonly kind: "line"; readonly start: Vec2 }
  | {
      readonly kind: "arcRadius";
      readonly start: Vec2;
      readonly radiusMm: number;
      readonly direction: ArcDirection;
    }
  | {
      readonly kind: "arcCenter";
      readonly start: Vec2;
      readonly center: Vec2 | null;
      readonly direction: ArcDirection;
    };

/** Projects the editor state onto the draft descriptor the canvas draws. */
export function draftPreviewOf(state: EditorState): DraftPreview | null {
  if (state.draftStart === null) return null;
  switch (state.tool) {
    case "line":
      return { kind: "line", start: state.draftStart };
    case "arc":
      return state.arcMode === "radius"
        ? {
            kind: "arcRadius",
            start: state.draftStart,
            radiusMm: state.arcRadiusMm,
            direction: state.arcDirection,
          }
        : {
            kind: "arcCenter",
            start: state.draftStart,
            center: state.draftCenter,
            direction: state.arcDirection,
          };
    default:
      // One-click tools (Home Point, Point) commit immediately — no draft.
      return null;
  }
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
      // a pending draft started on the old plane is cancelled.
      return { ...state, plane: action.plane, draftStart: null, draftCenter: null, error: null };
    case "setFixedMm":
      return { ...state, fixedMm: parseNumberOr(action.raw, state.fixedMm) };
    case "setFeedMmMin":
      return {
        ...state,
        feedMmMin: parsePositiveNumberOr(action.raw, state.feedMmMin),
      };
    case "setTool":
      return { ...state, tool: action.tool, draftStart: null, draftCenter: null, error: null };
    case "setArcMode":
      // The pending start carries over; a pending center belongs to the
      // other definition mode and is dropped.
      return { ...state, arcMode: action.mode, draftCenter: null, error: null };
    case "setArcDirection":
      // Direction applies live: a pending draft commits with the new direction.
      return { ...state, arcDirection: action.direction };
    case "setArcRadiusMm":
      return { ...state, arcRadiusMm: parsePositiveNumberOr(action.raw, state.arcRadiusMm) };
    case "canvasClick": {
      const { u, v } = action;
      if (!(Number.isFinite(u) && Number.isFinite(v))) return state;
      const uv = vec2(u, v);
      const target = planePoint(state.plane, u, v, state.fixedMm);
      if (state.tool === "home") return { ...state, home: target, error: null };
      if (state.tool === "point") {
        const segment = point({ target, feed: mmMinToMmS(state.feedMmMin) });
        return { ...state, segments: [...state.segments, segment], error: null };
      }
      if (state.tool === "arc") return arcClick(state, uv, target);
      return lineClick(state, uv, target);
    }
    case "numericEntry":
      // Typed coordinates are exact clicks: they enter the same draft
      // and commit path, so a typed point lands exactly where the
      // operator typed it.
      return editorReducer(state, { type: "canvasClick", u: action.u, v: action.v });
    case "setSegmentFeedMmMin": {
      // Every Segment kind carries its own Feed; the edit rewrites that
      // one field, keeping the geometry untouched.
      const segment = state.segments[action.index];
      if (segment === undefined) return state;
      const feed = mmMinToMmS(parsePositiveNumberOr(action.raw, mmSToMmMin(segment.feed)));
      return {
        ...state,
        segments: state.segments.map((s, i) => (i === action.index ? { ...s, feed } : s)),
      };
    }
    case "cancelDraft":
      return { ...state, draftStart: null, draftCenter: null, error: null };
    case "undo":
      return { ...state, segments: state.segments.slice(0, -1) };
    case "clear":
      return { ...state, segments: [], home: null, draftStart: null, draftCenter: null, error: null };
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
        draftCenter: null,
        error: null,
      };
  }
}

/**
 * Advances a Line draft: the first click pends, the second commits a
 * canonical Line built by the core.
 */
function lineClick(state: EditorState, uv: Vec2, target: Vec3): EditorState {
  if (state.draftStart === null) return { ...state, draftStart: uv, error: null };
  const start = planePoint(state.plane, state.draftStart.x, state.draftStart.y, state.fixedMm);
  const segment = line({ start, end: target, feed: mmMinToMmS(state.feedMmMin) });
  return { ...state, segments: [...state.segments, segment], draftStart: null, error: null };
}

/**
 * Advances an Arc draft per the definition mode (ADR 0005): radius mode
 * commits on the second click, center mode on the third. A rejected Arc
 * (impossible for the current radius/center) keeps the draft so the
 * operator can click a valid next point, and stores a readable message.
 */
function arcClick(state: EditorState, uv: Vec2, target: Vec3): EditorState {
  if (state.arcMode === "center") return arcCenterClick(state, uv);
  if (state.draftStart === null) return { ...state, draftStart: uv, error: null };
  const start = planePoint(state.plane, state.draftStart.x, state.draftStart.y, state.fixedMm);
  const feed = mmMinToMmS(state.feedMmMin);
  try {
    const segment = arcFromRadius({
      plane: state.plane,
      start,
      end: target,
      radiusMm: state.arcRadiusMm,
      direction: state.arcDirection,
      feed,
    });
    return { ...state, segments: [...state.segments, segment], draftStart: null, error: null };
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    return { ...state, error: arcRejectMessage(e, state.arcRadiusMm, distance(state.draftStart, uv)) };
  }
}

/**
 * Advances a center-mode Arc draft: click 1 pends the start, click 2 the
 * center (a center on the start is rejected — zero radius), click 3 ends
 * the Arc. The end click may land anywhere except the center: it is
 * snapped onto the circle around the center, so the clicked angle is
 * what defines the Arc (the commit then always passes the core's
 * on-circle check).
 */
function arcCenterClick(state: EditorState, uv: Vec2): EditorState {
  if (state.draftStart === null) return { ...state, draftStart: uv, error: null };
  if (state.draftCenter === null) {
    if (distance(state.draftStart, uv) <= CENTER_EPS_MM) {
      return { ...state, error: "Дуга невозможна: центр совпал с началом — кликните рядом с началом дуги." };
    }
    return { ...state, draftCenter: uv, error: null };
  }
  const radiusMm = distance(state.draftStart, state.draftCenter);
  const offset = distance(uv, state.draftCenter);
  if (offset <= CENTER_EPS_MM) {
    return { ...state, error: "Дуга невозможна: конец попал в центр — кликните на окружности дуги." };
  }
  const end2 = vec2(
    state.draftCenter.x + (radiusMm * (uv.x - state.draftCenter.x)) / offset,
    state.draftCenter.y + (radiusMm * (uv.y - state.draftCenter.y)) / offset,
  );
  const at = (p: Vec2): Vec3 => planePoint(state.plane, p.x, p.y, state.fixedMm);
  try {
    const segment = arcFromCenter({
      plane: state.plane,
      start: at(state.draftStart),
      end: at(end2),
      center: at(state.draftCenter),
      direction: state.arcDirection,
      feed: mmMinToMmS(state.feedMmMin),
    });
    return {
      ...state,
      segments: [...state.segments, segment],
      draftStart: null,
      draftCenter: null,
      error: null,
    };
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    return { ...state, error: arcRejectMessage(e, state.arcRadiusMm, radiusMm) };
  }
}

/**
 * A readable Russian rejection for an Arc the core refused, with the
 * numbers that matter. Through the UI only the two radius-mode tags can
 * actually fire (the center-mode end click is snapped onto the circle,
 * and every point is built on one plane's fixed coordinate); anything
 * else falls back to the core's own message.
 */
function arcRejectMessage(error: CoreError, radiusMm: number, chordMm: number): string {
  switch (error.tag) {
    case "ArcRadiusTooSmall":
      return `Дуга невозможна: концы дальше, чем диаметр 2·R = ${(2 * radiusMm).toFixed(1)} мм (расстояние ${chordMm.toFixed(1)} мм), увеличьте радиус.`;
    case "ArcAmbiguousCenter":
      return "Дуга невозможна: концы совпадают — по радиусу центр не определить.";
    default:
      return `Дуга невозможна: ${error.message}`;
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
