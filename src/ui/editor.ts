/**
 * The drawing editor's application state: the Working Plane with its
 * fixed coordinate, the Feed, the Motion Type of the next Move, the
 * active tool, the Home Point, and the canonical Segments in draw
 * order. A plain reducer over immutable records — drawn geometry enters
 * the state as canonical Segments built by the core (`point`), never as
 * screen coordinates. Drawing places one continuous chain: every click
 * of the Point tool adds a Point whose Move starts where the previous
 * Segment ended (the first at the Home Point), travelling by the
 * selected Motion Type — LIN (по прямой) by default, PTP (в точку) when
 * the toggle says so (ADR 0017) — and the Arc tool joins the same
 * chain: an Arc always starts where the previous Segment ended (the
 * first at the Home Point), so the radius definition takes one click
 * (the Arc's end, with the radius from the numeric field) and the
 * center definition two (center, then end); CW/CCW and the canonical
 * Arc definition are unchanged (ADR 0005). The chain start is derived,
 * never stored: editing the Home Point or undoing a Segment re-derives
 * where the next Move or Arc begins. Committed Moves stay editable:
 * the reducer rewrites one Move's Motion Type or Feed, the way the
 * drawing itself is never touched by an edit. The toolbar Feed field is
 * modal (the CNC F-word): it sets the Feed of Segments drawn after the
 * change, and the explicit apply-to-all action rewrites every drawn
 * Segment's Feed at once.
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
  planeAxes,
  planeCoords,
  planePoint,
  point,
  segmentEnds,
  vec2,
  vec3,
  type ArcDirection,
  type MotionType,
  type Segment,
  type Vec2,
  type Vec3,
  type WorkingPlane,
} from "../core";
import type { ProjectContent } from "../project";
import { DEFAULT_MIKO_MINI_HOME_MM } from "../kinematics/miko-mini";

/** Arc travel direction, re-exported for the UI that configures it. */
export type { ArcDirection };

/** How a Move travels (GLOSSARY.md: Motion Type), re-exported for the UI. */
export type { MotionType };

/** The active drawing tool: Point (one click per chained Point), Arc (chained), or Home Point (one click). */
export type EditorTool = "point" | "arc" | "home";

/** How an Arc is defined: radius R (one click — the end) or explicit center (two clicks, ADR 0005). */
export type ArcMode = "radius" | "center";

/** Default Arc radius shown in the UI, in millimetres. */
export const DEFAULT_ARC_RADIUS_MM = 10;

/** A click closer than this to the draft start cannot be an Arc center, in mm. */
const CENTER_EPS_MM = 1e-6;

/** Readable rejection for an Arc with no chain start (no Home Point, nothing drawn). */
const NO_CHAIN_START_MESSAGE =
  "Дуга невозможна: нет начала — дуга начинается в конце цепочки или в исходной точке; задайте исходную точку.";

/** The editor's application state. */
export interface EditorState {
  /** Working Plane the operator draws on. */
  readonly plane: WorkingPlane;
  /** The plane's fixed third coordinate, in millimetres. */
  readonly fixedMm: number;
  /** Feed shown in the UI, in mm/min. */
  readonly feedMmMin: number;
  /** Motion Type the next committed Point Move travels by (ADR 0017). */
  readonly motionType: MotionType;
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
  /** Pending Arc center in plane millimetres (center mode, after the first click), or null. */
  readonly draftCenter: Vec2 | null;
  /** Readable rejection message of the last failed draw, or null when the last action succeeded. */
  readonly error: string | null;
}

/** Default Feed shown in the UI: 1200 mm/min = 20 mm/s. */
export const DEFAULT_FEED_MM_MIN = 1200;

/**
 * The Home Point (Исходная точка) the editor starts with and Clear
 * restores: the MiKo-mini's measured default [213, 0, 305] mm (ADR 0015),
 * Reachable under the default Robot Model. The Home Point tool still
 * re-places it by click.
 */
export const DEFAULT_HOME_POINT = vec3(
  DEFAULT_MIKO_MINI_HOME_MM[0],
  DEFAULT_MIKO_MINI_HOME_MM[1],
  DEFAULT_MIKO_MINI_HOME_MM[2],
);

/** The initial editor state: XY plane at fixed 0, chained Point tool, Motion Type LIN, default Home Point. */
export const initialEditorState: EditorState = {
  plane: "XY",
  fixedMm: 0,
  feedMmMin: DEFAULT_FEED_MM_MIN,
  tool: "point",
  motionType: "LIN",
  arcMode: "radius",
  arcDirection: "CCW",
  arcRadiusMm: DEFAULT_ARC_RADIUS_MM,
  home: DEFAULT_HOME_POINT,
  segments: [],
  draftCenter: null,
  error: null,
};

/** Actions the editor reducer understands. */
export type EditorAction =
  | { readonly type: "setPlane"; readonly plane: WorkingPlane }
  | { readonly type: "setFixedMm"; readonly raw: string }
  | { readonly type: "setFeedMmMin"; readonly raw: string }
  | { readonly type: "setMotionType"; readonly motionType: MotionType }
  | { readonly type: "setTool"; readonly tool: EditorTool }
  | { readonly type: "setArcMode"; readonly mode: ArcMode }
  | { readonly type: "setArcDirection"; readonly direction: ArcDirection }
  | { readonly type: "setArcRadiusMm"; readonly raw: string }
  | { readonly type: "canvasClick"; readonly u: number; readonly v: number }
  | { readonly type: "numericEntry"; readonly u: number; readonly v: number }
  | { readonly type: "setSegmentFeedMmMin"; readonly index: number; readonly raw: string }
  | { readonly type: "setSegmentMotionType"; readonly index: number; readonly motionType: MotionType }
  | { readonly type: "applyFeedToAllSegments" }
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
 * The pending draft as the canvas view needs it: the pending Point
 * Move the Point tool previews (carrying its Motion Type), and which
 * Arc clicks are done with which parameters. A pure projection of the
 * editor state — the canvas holds
 * no geometry state itself (ADR 0007). Null when the active tool holds
 * no draft.
 */
export type DraftPreview =
  /** The pending Move: drawn by its Motion Type from the chain end. */
  | { readonly kind: "move"; readonly motionType: MotionType; readonly start: Vec2 }
  | {
      /** The pending Arc in the radius definition: R from the numeric field. */
      readonly kind: "arcRadius";
      readonly start: Vec2;
      readonly radiusMm: number;
      readonly direction: ArcDirection;
    }
  | {
      /** The pending Arc in the center definition: `center` after the first click. */
      readonly kind: "arcCenter";
      readonly start: Vec2;
      readonly center: Vec2 | null;
      readonly direction: ArcDirection;
    };

/**
 * The pen position before the next Segment: the last committed
 * Segment's end, or the Home Point before the first. Null while the
 * Home Point is unset and nothing is drawn — a chained Move or Arc
 * then has no start to travel from.
 */
function chainEndOf(state: EditorState): Vec3 | null {
  const last = state.segments.at(-1);
  if (last !== undefined) return segmentEnds(last).end;
  return state.home;
}

/** The chain end as the next Segment's start: its 3D point and its plane (u, v) projection. */
interface ChainStart {
  readonly start: Vec3;
  readonly uv: Vec2;
}

/**
 * The Arc's start derived from the chain: the 3D chain end with its
 * plane (u, v) projection. Null with no chain start (no Home Point,
 * nothing drawn).
 */
function chainStartOf(state: EditorState): ChainStart | null {
  const pen = chainEndOf(state);
  if (pen === null) return null;
  const coords = planeCoords(state.plane, pen);
  return { start: pen, uv: vec2(coords.u, coords.v) };
}

/** Projects the editor state onto the draft descriptor the canvas draws. */
export function draftPreviewOf(state: EditorState): DraftPreview | null {
  if (state.tool === "point") {
    // The pending Move: from the chain end (previous Segment's end,
    // the Home Point first) to the cursor.
    const chain = chainStartOf(state);
    if (chain === null) return null;
    return { kind: "move", motionType: state.motionType, start: chain.uv };
  }
  if (state.tool === "arc") {
    // The pending Arc always previews from the chain end — no click is
    // needed to start it: in radius mode R and direction ride along,
    // in center mode the pending center (null before the first click).
    const chain = chainStartOf(state);
    if (chain === null) return null;
    return state.arcMode === "radius"
      ? {
          kind: "arcRadius",
          start: chain.uv,
          radiusMm: state.arcRadiusMm,
          direction: state.arcDirection,
        }
      : {
          kind: "arcCenter",
          start: chain.uv,
          center: state.draftCenter,
          direction: state.arcDirection,
        };
  }
  // The Home Point tool commits immediately — no draft.
  return null;
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
      // a pending Arc center is cancelled.
      return { ...state, plane: action.plane, draftCenter: null, error: null };
    case "setFixedMm":
      return { ...state, fixedMm: parseNumberOr(action.raw, state.fixedMm) };
    case "setFeedMmMin":
      return {
        ...state,
        feedMmMin: parsePositiveNumberOr(action.raw, state.feedMmMin),
      };
    case "setMotionType":
      // Applies to Moves committed from now on; drawn Segments are
      // edited one by one in the segment list instead.
      return { ...state, motionType: action.motionType };
    case "setTool":
      return { ...state, tool: action.tool, draftCenter: null, error: null };
    case "setArcMode":
      // The chain end is always the Arc's start; only a pending center
      // belongs to the other definition mode and is dropped.
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
      if (state.tool === "arc") return arcClick(state, uv, target);
      // The Point tool: every click commits one more Point in the chain,
      // a Move to the target without drawn geometry, travelling by the
      // selected Motion Type.
      const segment = point({
        target,
        feed: mmMinToMmS(state.feedMmMin),
        motionType: state.motionType,
      });
      return { ...state, segments: [...state.segments, segment], error: null };
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
    case "setSegmentMotionType": {
      // A Move's Motion Type is editable after drawing, the way its Feed
      // is: the edit rewrites that one field of that one Point Segment.
      const segment = state.segments[action.index];
      if (segment === undefined || segment.kind !== "point") return state;
      return {
        ...state,
        segments: state.segments.map((s, i) =>
          i === action.index && s.kind === "point" ? { ...s, motionType: action.motionType } : s,
        ),
      };
    }
    case "applyFeedToAllSegments": {
      // The explicit global apply rewrites every drawn Segment's Feed —
      // individually edited ones included: the button's scope is
      // explicit (issue #60), and the geometry is untouched.
      return {
        ...state,
        segments: state.segments.map((s) => ({ ...s, feed: mmMinToMmS(state.feedMmMin) })),
      };
    }
    case "cancelDraft":
      return { ...state, draftCenter: null, error: null };
    case "undo":
      return { ...state, segments: state.segments.slice(0, -1) };
    case "clear":
      // Clear wipes the drawing but restores the default Home Point: a
      // fresh canvas always starts from the MiKo-mini's [213, 0, 305].
      return {
        ...state,
        segments: [],
        home: DEFAULT_HOME_POINT,
        draftCenter: null,
        error: null,
      };
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
        draftCenter: null,
        error: null,
      };
  }
}

/**
 * Advances a chained Arc per the definition mode (ADR 0005): the Arc's
 * start is always the chain end (the previous Segment's end, the Home
 * Point first) — radius mode commits on the single click (the Arc's
 * end, with R from the numeric field), center mode on the second
 * (center, then end). A rejected Arc (impossible for the current
 * radius/center, or a chain start off the Working Plane) stores a
 * readable message; a pending center-mode center is kept so the
 * operator can click a valid next point (the radius-mode Arc holds no
 * draft — the chain start is derived, so the operator just clicks
 * again).
 */
function arcClick(state: EditorState, uv: Vec2, target: Vec3): EditorState {
  const chain = chainStartOf(state);
  if (chain === null) return { ...state, error: NO_CHAIN_START_MESSAGE };
  if (state.arcMode === "center") return arcCenterClick(state, uv, chain);
  // Radius mode: one click — the Arc's end; the start is the chain end.
  try {
    const segment = arcFromRadius({
      plane: state.plane,
      start: chain.start,
      end: target,
      radiusMm: state.arcRadiusMm,
      direction: state.arcDirection,
      feed: mmMinToMmS(state.feedMmMin),
    });
    return { ...state, segments: [...state.segments, segment], error: null };
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    return { ...state, error: arcRejectMessage(e, state.arcRadiusMm, distance(chain.uv, uv)) };
  }
}

/**
 * Advances a center-mode Arc draft: click 1 pends the center (a center
 * on the chain end is rejected — zero radius), click 2 ends the Arc.
 * The end click may land anywhere except the center: it is snapped onto
 * the circle around the center, so the clicked angle is what defines
 * the Arc (the commit then always passes the core's on-circle check).
 */
function arcCenterClick(state: EditorState, uv: Vec2, chain: ChainStart): EditorState {
  if (state.draftCenter === null) {
    if (distance(chain.uv, uv) <= CENTER_EPS_MM) {
      return { ...state, error: "Дуга невозможна: центр совпал с началом — кликните рядом с началом дуги." };
    }
    return { ...state, draftCenter: uv, error: null };
  }
  const radiusMm = distance(chain.uv, state.draftCenter);
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
      start: chain.start,
      end: at(end2),
      center: at(state.draftCenter),
      direction: state.arcDirection,
      feed: mmMinToMmS(state.feedMmMin),
    });
    return {
      ...state,
      segments: [...state.segments, segment],
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
 * numbers that matter. Through the UI the radius-mode tags and the
 * off-plane chain start can actually fire (the center-mode end click is
 * snapped onto the circle, and every point is built on one plane's
 * fixed coordinate); anything else falls back to the core's own
 * message.
 */
function arcRejectMessage(error: CoreError, radiusMm: number, chordMm: number): string {
  switch (error.tag) {
    case "ArcRadiusTooSmall":
      return `Дуга невозможна: концы дальше, чем диаметр 2·R = ${(2 * radiusMm).toFixed(1)} мм (расстояние ${chordMm.toFixed(1)} мм), увеличьте радиус.`;
    case "ArcAmbiguousCenter":
      return "Дуга невозможна: концы совпадают — по радиусу центр не определить.";
    case "ArcOffPlane":
      return "Дуга невозможна: начало цепочки лежит вне текущей рабочей плоскости — дуга всегда целиком в рабочей плоскости; верните плоскость или задайте новую исходную точку.";
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
