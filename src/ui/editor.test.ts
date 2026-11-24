import { describe, expect, it } from "vitest";

import { planeCoords } from "../core";
import { point as corePoint, vec2, vec3 } from "../core";
import { checkPointReachability } from "../kinematics/reachability";
import { type ProjectContent } from "../project";
import {
  DEFAULT_ARC_RADIUS_MM,
  DEFAULT_FEED_MM_MIN,
  DEFAULT_HOME_POINT,
  draftPreviewOf,
  editorReducer,
  initialEditorState,
  mmMinToMmS,
  mmSToMmMin,
  projectContentOf,
  type EditorState,
} from "./editor";
import { MIKO_MINI } from "./robot";

/** Clicks the canvas at plane coordinates (u, v). */
function click(state: EditorState, u: number, v: number): EditorState {
  return editorReducer(state, { type: "canvasClick", u, v });
}

/** Places a chained Point with one click (the initial tool is the Point tool). */
function placePoint(state: EditorState, u: number, v: number): EditorState {
  return click(state, u, v);
}

/** Draws an Arc (radius mode, R = 10 mm) with two clicks, returning the resulting state. */
function drawArc(state: EditorState, u1: number, v1: number, u2: number, v2: number): EditorState {
  return click(click({ ...state, tool: "arc", arcRadiusMm: 10 }, u1, v1), u2, v2);
}

describe("editor state", () => {
  it("starts on the XY plane at fixed 0 with a default feed, the default Home Point, the chained Point tool, and no Segments", () => {
    expect(initialEditorState).toEqual({
      plane: "XY",
      fixedMm: 0,
      feedMmMin: DEFAULT_FEED_MM_MIN,
      tool: "point",
      arcMode: "radius",
      arcDirection: "CCW",
      arcRadiusMm: DEFAULT_ARC_RADIUS_MM,
      home: DEFAULT_HOME_POINT,
      segments: [],
      draftStart: null,
      draftCenter: null,
      error: null,
    });
  });

  it("defaults the Home Point to the MiKo-mini's [213, 0, 305] (ADR 0015)", () => {
    expect(DEFAULT_HOME_POINT).toEqual(vec3(213, 0, 305));
  });

  it("opens with a default Home Point that is Reachable under the MiKo-mini model", () => {
    expect(initialEditorState.home).not.toBeNull();
    const home = initialEditorState.home as { x: number; y: number; z: number };
    expect(checkPointReachability(MIKO_MINI, [home.x, home.y, home.z])).toBe("ok");
  });

  it("places a chain of Points: every click appends one Point Segment, on the plane", () => {
    const state = placePoint(placePoint({ ...initialEditorState, fixedMm: 2 }, 10, 5), -3.5, 40);
    expect(state.segments).toHaveLength(2);
    const first = state.segments[0]!;
    const second = state.segments[1]!;
    expect(first.kind).toBe("point");
    expect(second.kind).toBe("point");
    if (first.kind !== "point" || second.kind !== "point") return;
    expect(first.target).toEqual({ x: 10, y: 5, z: 2 });
    expect(second.target).toEqual({ x: -3.5, y: 40, z: 2 });
    expect(first.feed).toBe(mmMinToMmS(DEFAULT_FEED_MM_MIN));
    expect(second.feed).toBe(mmMinToMmS(DEFAULT_FEED_MM_MIN));
    // One-click commits hold no draft.
    expect(state.draftStart).toBeNull();
  });

  it("keeps an Arc draft pending after the first click", () => {
    const state = click({ ...initialEditorState, tool: "arc" }, 10, 20);
    expect(state.segments).toHaveLength(0);
    expect(state.draftStart).toEqual(vec2(10, 20));
  });

  it("stacks Segments in draw order", () => {
    let state = placePoint(initialEditorState, 0, 0);
    state = placePoint(state, 10, 10);
    expect(state.segments).toHaveLength(2);
    const first = state.segments[0]!;
    const second = state.segments[1]!;
    expect(first.kind === "point" && first.target).toEqual({ x: 0, y: 0, z: 0 });
    expect(second.kind === "point" && second.target).toEqual({ x: 10, y: 10, z: 0 });
  });

  for (const plane of ["XY", "XZ", "YZ"] as const) {
    it(`draws on the ${plane} plane: plane switching updates which coordinate is fixed`, () => {
      // Draw on XY at z = 2, switch planes keeping the same fixed value,
      // and place again: the new Point is fixed on the new plane's w axis.
      const onXY = placePoint({ ...initialEditorState, plane: "XY", fixedMm: 2 }, 5, 9);
      const switched = editorReducer(onXY, { type: "setPlane", plane });
      const onNew = placePoint(switched, 1, 2);
      const seg = onNew.segments[1]!;
      expect(seg.kind).toBe("point");
      if (seg.kind !== "point") return;
      const expectedAxis = { XY: "z", XZ: "y", YZ: "x" }[plane];
      expect(planeCoords(plane, seg.target).w).toBe(2);
      expect(seg.target[expectedAxis as "x" | "y" | "z"]).toBe(2);
    });
  }

  it("cancels the draft when the Working Plane changes", () => {
    const drafting = click({ ...initialEditorState, tool: "arc" }, 5, 5);
    const switched = editorReducer(drafting, { type: "setPlane", plane: "YZ" });
    expect(switched.plane).toBe("YZ");
    expect(switched.draftStart).toBeNull();
  });

  it("ignores non-finite click coordinates", () => {
    const state = click(initialEditorState, Number.NaN, 5);
    expect(state).toEqual(initialEditorState);
    const state2 = click(initialEditorState, 5, Number.POSITIVE_INFINITY);
    expect(state2).toEqual(initialEditorState);
  });

  it("undo removes the last Segment and keeps earlier ones", () => {
    let state = placePoint(initialEditorState, 0, 0);
    state = placePoint(state, 10, 10);
    const undone = editorReducer(state, { type: "undo" });
    expect(undone.segments).toHaveLength(1);
    const kept = undone.segments[0]!;
    expect(kept.kind === "point" && kept.target).toEqual({ x: 0, y: 0, z: 0 });
    const undoneTwice = editorReducer(undone, { type: "undo" });
    expect(undoneTwice.segments).toHaveLength(0);
    // Undo on an empty canvas is a no-op, not an error.
    const undoneThrice = editorReducer(undoneTwice, { type: "undo" });
    expect(undoneThrice.segments).toHaveLength(0);
  });

  it("undo does not remove the Home Point", () => {
    let state = editorReducer(initialEditorState, { type: "setTool", tool: "home" });
    state = click(state, 1, 2);
    state = placePoint({ ...state, tool: "point" }, 0, 0);
    const undone = editorReducer(state, { type: "undo" });
    expect(undone.segments).toHaveLength(0);
    expect(undone.home).toEqual({ x: 1, y: 2, z: 0 });
  });

  it("clear empties the canvas: Segments and draft, restoring the default Home Point", () => {
    let state = editorReducer(initialEditorState, { type: "setTool", tool: "home" });
    state = click(state, 1, 2);
    state = placePoint({ ...state, tool: "point" }, 0, 0);
    // A pending Arc draft is dropped by the clear too.
    state = click({ ...state, tool: "arc" }, 9, 9);
    const cleared = editorReducer(state, { type: "clear" });
    expect(cleared.segments).toEqual([]);
    expect(cleared.home).toEqual(DEFAULT_HOME_POINT);
    expect(cleared.draftStart).toBeNull();
    // Plane, fixed coordinate, feed, and tool survive the clear.
    expect(cleared.plane).toBe(state.plane);
    expect(cleared.feedMmMin).toBe(state.feedMmMin);
  });

  it("sets the Home Point with one click in home mode, leaving Segments alone", () => {
    let state = editorReducer(initialEditorState, { type: "setTool", tool: "home" });
    state = click(state, -7.5, 12);
    expect(state.home).toEqual({ x: -7.5, y: 12, z: 0 });
    expect(state.segments).toHaveLength(0);
    // The Home Point moves on a later click, it does not accumulate.
    state = click(state, 3, 4);
    expect(state.home).toEqual({ x: 3, y: 4, z: 0 });
  });

  it("sets the Home Point on the current plane's fixed coordinate", () => {
    let state = editorReducer({ ...initialEditorState, plane: "XZ", fixedMm: -4 }, { type: "setTool", tool: "home" });
    state = click(state, 6, 8);
    expect(state.home).toEqual({ x: 6, y: -4, z: 8 });
  });

  it("switching tools cancels a pending draft", () => {
    const drafting = click({ ...initialEditorState, tool: "arc" }, 5, 5);
    const toHome = editorReducer(drafting, { type: "setTool", tool: "home" });
    expect(toHome.draftStart).toBeNull();
  });

  it("Point tool commits a Point Segment with one click: a PTP Move to the target without drawn geometry", () => {
    let state = editorReducer(initialEditorState, { type: "setTool", tool: "point" });
    state = click(state, 3.25, -1.5);
    expect(state.segments).toHaveLength(1);
    const seg = state.segments[0]!;
    expect(seg.kind).toBe("point");
    if (seg.kind !== "point") return;
    expect(seg.target).toEqual({ x: 3.25, y: -1.5, z: 0 });
    expect(seg.feed).toBe(mmMinToMmS(DEFAULT_FEED_MM_MIN));
    // A Point has no draft: the next click places the next Point in the chain.
    expect(state.draftStart).toBeNull();
  });

  it("Point tool places the target on the current plane's fixed coordinate", () => {
    let state = editorReducer({ ...initialEditorState, plane: "XZ", fixedMm: -4 }, { type: "setTool", tool: "point" });
    state = click(state, 6, 8);
    const seg = state.segments[0]!;
    expect(seg.kind).toBe("point");
    if (seg.kind !== "point") return;
    expect(seg.target).toEqual({ x: 6, y: -4, z: 8 });
  });

  it("defaults the Arc tool to radius mode, CCW, radius 10 mm", () => {
    expect(initialEditorState.arcMode).toBe("radius");
    expect(initialEditorState.arcDirection).toBe("CCW");
    expect(initialEditorState.arcRadiusMm).toBe(DEFAULT_ARC_RADIUS_MM);
    expect(initialEditorState.draftCenter).toBeNull();
    expect(initialEditorState.error).toBeNull();
  });

  it("commits a canonical Arc after two clicks in radius mode", () => {
    const state = editorReducer(
      { ...initialEditorState, tool: "arc", arcRadiusMm: 10 },
      { type: "canvasClick", u: 0, v: 0 },
    );
    const done = click(state, 8, 0);
    expect(done.segments).toHaveLength(1);
    const seg = done.segments[0]!;
    expect(seg.kind).toBe("arc");
    if (seg.kind !== "arc") return;
    expect(seg.plane).toBe("XY");
    expect(seg.start).toEqual({ x: 0, y: 0, z: 0 });
    expect(seg.end).toEqual({ x: 8, y: 0, z: 0 });
    expect(seg.radiusMm).toBe(10);
    // CCW resolves the center 90° left of the chord: above it, in XY.
    expect(seg.center).toEqual({ x: 4, y: Math.sqrt(10 * 10 - 4 * 4), z: 0 });
    expect(seg.sweepRad).toBeGreaterThan(0);
    expect(seg.sweepRad).toBeLessThan(Math.PI);
    expect(seg.feed).toBe(mmMinToMmS(DEFAULT_FEED_MM_MIN));
    expect(done.draftStart).toBeNull();
    expect(done.error).toBeNull();
  });

  it("CW and CCW resolve distinct arcs from the same clicks", () => {
    const clicks = { type: "canvasClick", u: 0, v: 0 } as const;
    const ccw = click(editorReducer({ ...initialEditorState, tool: "arc", arcDirection: "CCW" }, clicks), 8, 0);
    const cw = click(editorReducer({ ...initialEditorState, tool: "arc", arcDirection: "CW" }, clicks), 8, 0);
    const ccwSeg = ccw.segments[0]!;
    const cwSeg = cw.segments[0]!;
    expect(ccwSeg.kind).toBe("arc");
    expect(cwSeg.kind).toBe("arc");
    if (ccwSeg.kind !== "arc" || cwSeg.kind !== "arc") return;
    // The centers sit on opposite sides of the chord; the sweeps oppose.
    expect(cwSeg.center.y).toBe(-ccwSeg.center.y);
    expect(cwSeg.sweepRad).toBeLessThan(0);
    expect(ccwSeg.sweepRad).toBeGreaterThan(0);
  });

  it("rejects endpoints farther apart than 2·R at draw time with a readable message, keeping the draft start", () => {
    const drafting = click({ ...initialEditorState, tool: "arc", arcRadiusMm: 10 }, 0, 0);
    const rejected = click(drafting, 50, 0);
    expect(rejected.segments).toHaveLength(0);
    // The draft start stays so the operator can click a valid end.
    expect(rejected.draftStart).toEqual(vec2(0, 0));
    expect(rejected.error).toContain("невозможна");
    expect(rejected.error).toContain("радиус");
  });

  it("rejects coincident endpoint clicks (no unique center from R)", () => {
    const drafting = click({ ...initialEditorState, tool: "arc", arcRadiusMm: 10 }, 3, 4);
    const rejected = click(drafting, 3, 4);
    expect(rejected.segments).toHaveLength(0);
    expect(rejected.error).toContain("невозможна");
  });

  it("clears the rejection once a valid retry commits", () => {
    const drafting = click({ ...initialEditorState, tool: "arc", arcRadiusMm: 10 }, 0, 0);
    const rejected = click(drafting, 50, 0);
    const retried = click(rejected, 8, 0);
    expect(retried.segments).toHaveLength(1);
    expect(retried.error).toBeNull();
    expect(retried.draftStart).toBeNull();
  });

  it("applies radius and direction changes live to the next commit", () => {
    let state = editorReducer(initialEditorState, { type: "setTool", tool: "arc" });
    state = editorReducer(state, { type: "setArcRadiusMm", raw: "25" });
    state = editorReducer(state, { type: "setArcDirection", direction: "CW" });
    const drafting = click(state, 0, 0);
    const done = click(drafting, 10, 0);
    const seg = done.segments[0]!;
    expect(seg.kind).toBe("arc");
    if (seg.kind !== "arc") return;
    expect(seg.radiusMm).toBe(25);
    expect(seg.direction).toBe("CW");
    expect(seg.center).toEqual({ x: 5, y: -Math.sqrt(25 * 25 - 5 * 5), z: 0 });
  });

  it("keeps the previous radius on invalid input", () => {
    let state = editorReducer(initialEditorState, { type: "setArcRadiusMm", raw: "7.5" });
    for (const raw of ["", "abc", "0", "-2", "NaN"]) {
      state = editorReducer(state, { type: "setArcRadiusMm", raw });
      expect(state.arcRadiusMm).toBe(7.5);
    }
  });

  it("cancelling the draft clears the rejection", () => {
    const drafting = click({ ...initialEditorState, tool: "arc", arcRadiusMm: 10 }, 0, 0);
    const rejected = click(drafting, 50, 0);
    const cancelled = editorReducer(rejected, { type: "cancelDraft" });
    expect(cancelled.error).toBeNull();
    expect(cancelled.draftStart).toBeNull();
  });

  it("center mode: three clicks commit an Arc with the clicked center and the end snapped onto the circle", () => {
    let state = editorReducer({ ...initialEditorState, tool: "arc", arcMode: "center" }, { type: "canvasClick", u: 0, v: 0 });
    state = click(state, 10, 0); // the center, 10 mm from the start
    expect(state.draftStart).toEqual(vec2(0, 0));
    expect(state.draftCenter).toEqual(vec2(10, 0));
    state = click(state, 19, 7); // off-circle on purpose: snapped onto the circle
    expect(state.segments).toHaveLength(1);
    const seg = state.segments[0]!;
    expect(seg.kind).toBe("arc");
    if (seg.kind !== "arc") return;
    expect(seg.center).toEqual({ x: 10, y: 0, z: 0 });
    expect(seg.radiusMm).toBe(10);
    expect(seg.direction).toBe("CCW");
    // The end lands exactly on the circle around the center.
    const end = planeCoords("XY", seg.end);
    expect(Math.hypot(end.u - 10, end.v)).toBeCloseTo(10, 12);
    expect(state.draftStart).toBeNull();
    expect(state.draftCenter).toBeNull();
    expect(state.error).toBeNull();
  });

  it("center mode: CW and CCW sweep opposite ways from the same clicks", () => {
    const draw = (direction: "CW" | "CCW"): EditorState => {
      let state = editorReducer(
        { ...initialEditorState, tool: "arc", arcMode: "center", arcDirection: direction },
        { type: "canvasClick", u: 0, v: 0 },
      );
      state = click(state, 10, 0);
      return click(state, 16, 8);
    };
    const ccw = draw("CCW").segments[0]!;
    const cw = draw("CW").segments[0]!;
    expect(ccw.kind).toBe("arc");
    expect(cw.kind).toBe("arc");
    if (ccw.kind !== "arc" || cw.kind !== "arc") return;
    expect(ccw.sweepRad).toBeGreaterThan(0);
    expect(cw.sweepRad).toBeLessThan(0);
  });

  it("center mode: rejects a center click on the start with a readable message", () => {
    let state = editorReducer({ ...initialEditorState, tool: "arc", arcMode: "center" }, { type: "canvasClick", u: 3, v: 4 });
    state = click(state, 3, 4);
    expect(state.segments).toHaveLength(0);
    expect(state.draftCenter).toBeNull();
    expect(state.draftStart).toEqual(vec2(3, 4));
    expect(state.error).toContain("невозможна");
    expect(state.error).toContain("центр");
    // A side click after the rejection still pends the center.
    const recovered = click(state, 13, 4);
    expect(recovered.error).toBeNull();
    expect(recovered.draftCenter).toEqual(vec2(13, 4));
  });

  it("center mode: an end click on the center is rejected, keeping start and center", () => {
    let state = editorReducer({ ...initialEditorState, tool: "arc", arcMode: "center" }, { type: "canvasClick", u: 0, v: 0 });
    state = click(state, 10, 0);
    const rejected = click(state, 10, 0);
    expect(rejected.segments).toHaveLength(0);
    expect(rejected.draftStart).toEqual(vec2(0, 0));
    expect(rejected.draftCenter).toEqual(vec2(10, 0));
    expect(rejected.error).toContain("невозможна");
  });

  it("switching the Arc mode keeps the pending start and drops a pending center", () => {
    let state = editorReducer({ ...initialEditorState, tool: "arc", arcMode: "center" }, { type: "canvasClick", u: 1, v: 2 });
    state = click(state, 5, 2);
    const switched = editorReducer(state, { type: "setArcMode", mode: "radius" });
    expect(switched.arcMode).toBe("radius");
    expect(switched.draftStart).toEqual(vec2(1, 2));
    expect(switched.draftCenter).toBeNull();
    expect(switched.error).toBeNull();
  });

  it("numeric entry commits exactly like a click, landing the typed coordinates exactly", () => {
    const done = editorReducer(initialEditorState, { type: "numericEntry", u: 0.123456789, v: -45.5 });
    const seg = done.segments[0]!;
    expect(seg.kind).toBe("point");
    if (seg.kind !== "point") return;
    expect(seg.target).toEqual({ x: 0.123456789, y: -45.5, z: 0 });
  });

  it("numeric entry sets the Home Point exactly in home mode", () => {
    let state = editorReducer(initialEditorState, { type: "setTool", tool: "home" });
    state = editorReducer(state, { type: "numericEntry", u: -7.25, v: 8.125 });
    expect(state.home).toEqual({ x: -7.25, y: 8.125, z: 0 });
  });

  it("numeric entry commits a Point Segment in point mode", () => {
    let state = editorReducer(initialEditorState, { type: "setTool", tool: "point" });
    state = editorReducer(state, { type: "numericEntry", u: 4.5, v: 6.5 });
    const seg = state.segments[0]!;
    expect(seg.kind).toBe("point");
    if (seg.kind !== "point") return;
    expect(seg.target).toEqual({ x: 4.5, y: 6.5, z: 0 });
  });

  it("numeric entry ignores non-finite coordinates", () => {
    const state = editorReducer(initialEditorState, { type: "numericEntry", u: Number.NaN, v: 5 });
    expect(state).toEqual(initialEditorState);
  });

  it("numeric entry drives the Arc draft: two entries commit a radius-mode Arc", () => {
    let state = editorReducer({ ...initialEditorState, tool: "arc", arcRadiusMm: 10 }, { type: "numericEntry", u: 0, v: 0 });
    state = editorReducer(state, { type: "numericEntry", u: 8, v: 0 });
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0]!.kind).toBe("arc");
  });

  it("edits one Segment's Feed in mm/min without touching the others", () => {
    let state = placePoint(initialEditorState, 0, 0);
    state = placePoint(state, 20, 0);
    state = placePoint(state, 30, 0);
    const edited = editorReducer(state, { type: "setSegmentFeedMmMin", index: 1, raw: "300" });
    const feeds = edited.segments.map((s) => mmSToMmMin(s.feed));
    expect(feeds).toEqual([mmSToMmMin(mmMinToMmS(DEFAULT_FEED_MM_MIN)), 300, mmSToMmMin(mmMinToMmS(DEFAULT_FEED_MM_MIN))]);
  });

  it("edits the Feed of an Arc Segment in place", () => {
    let state = editorReducer({ ...initialEditorState, tool: "arc" }, { type: "canvasClick", u: 0, v: 0 });
    state = click(state, 8, 0);
    const edited = editorReducer(state, { type: "setSegmentFeedMmMin", index: 0, raw: "600" });
    const seg = edited.segments[0]!;
    expect(seg.kind).toBe("arc");
    if (seg.kind !== "arc") return;
    expect(seg.feed).toBe(10); // 600 mm/min = 10 mm/s
    // Geometry is untouched by a feed edit.
    expect(seg.radiusMm).toBe(10);
    expect(seg.start).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("keeps a Segment's Feed on invalid input", () => {
    const state = placePoint(initialEditorState, 0, 0);
    for (const raw of ["", "abc", "0", "-5", "NaN"]) {
      const edited = editorReducer(state, { type: "setSegmentFeedMmMin", index: 0, raw });
      expect(edited.segments[0]!.feed).toBe(state.segments[0]!.feed);
    }
  });

  it("ignores a Feed edit for an unknown Segment index", () => {
    const state = placePoint(initialEditorState, 0, 0);
    expect(editorReducer(state, { type: "setSegmentFeedMmMin", index: 5, raw: "300" })).toBe(state);
    expect(editorReducer(state, { type: "setSegmentFeedMmMin", index: -1, raw: "300" })).toBe(state);
  });

  it("draftPreviewOf describes the pending draft for the canvas view", () => {
    // The Point tool previews the pending Move: dashed from the chain
    // end, the Home Point before the first Segment, to the cursor.
    expect(draftPreviewOf(initialEditorState)).toEqual({ kind: "ptp", start: vec2(213, 0) });
    // After placed Points the preview chains from the last target.
    const chained = placePoint(placePoint(initialEditorState, 0, 0), 10, 4);
    expect(draftPreviewOf(chained)).toEqual({ kind: "ptp", start: vec2(10, 4) });
    // No Home Point and nothing drawn: no Move to preview.
    expect(draftPreviewOf({ ...initialEditorState, home: null })).toBeNull();
    // A pending radius-mode Arc draft carries radius and direction.
    const arcDraft = click({ ...initialEditorState, tool: "arc", arcRadiusMm: 14, arcDirection: "CW" }, 3, 4);
    expect(draftPreviewOf(arcDraft)).toEqual({
      kind: "arcRadius",
      start: vec2(3, 4),
      radiusMm: 14,
      direction: "CW",
    });
    // A pending center-mode draft: center null after click 1, set after click 2.
    let centerDraft = click({ ...initialEditorState, tool: "arc", arcMode: "center", arcDirection: "CW" }, 1, 1);
    expect(draftPreviewOf(centerDraft)).toEqual({ kind: "arcCenter", start: vec2(1, 1), center: null, direction: "CW" });
    centerDraft = click(centerDraft, 6, 1);
    expect(draftPreviewOf(centerDraft)).toEqual({ kind: "arcCenter", start: vec2(1, 1), center: vec2(6, 1), direction: "CW" });
    // The Home Point tool holds no draft.
    const homeState = editorReducer({ ...initialEditorState, tool: "home" }, { type: "canvasClick", u: 5, v: 5 });
    expect(draftPreviewOf(homeState)).toBeNull();
  });

  it("chains the Move preview to an Arc's end: Points continue where the Arc finished", () => {
    const drawn = drawArc(initialEditorState, 0, 0, 8, 0);
    expect(drawn.segments).toHaveLength(1);
    // Back to the Point tool: the pending Move starts at the Arc's end,
    // not at the Home Point.
    const chaining = editorReducer(drawn, { type: "setTool", tool: "point" });
    const preview = draftPreviewOf(chaining);
    expect(preview).not.toBeNull();
    if (preview === null || preview.kind !== "ptp") return;
    expect(preview.start).toEqual(vec2(8, 0));
  });

  it("cancelDraft drops a pending draft without committing a Segment", () => {
    const drafting = click({ ...initialEditorState, tool: "arc" }, 5, 5);
    const cancelled = editorReducer(drafting, { type: "cancelDraft" });
    expect(cancelled.draftStart).toBeNull();
    expect(cancelled.segments).toHaveLength(0);
  });

  it("accepts a new feed in mm/min and draws with it (converted to mm/s)", () => {
    const state = editorReducer(initialEditorState, { type: "setFeedMmMin", raw: "600" });
    expect(state.feedMmMin).toBe(600);
    const drawn = placePoint(state, 10, 0);
    const seg = drawn.segments[0]!;
    expect(seg.kind === "point" && seg.feed).toBe(10);
  });

  it("rejects invalid feed inputs: empty, NaN, zero, negative", () => {
    for (const raw of ["", "  ", "abc", "0", "-5", "NaN"]) {
      const state = editorReducer(initialEditorState, { type: "setFeedMmMin", raw });
      expect(state.feedMmMin).toBe(DEFAULT_FEED_MM_MIN);
    }
  });

  it("accepts a new fixed coordinate, including zero and negatives", () => {
    const state = editorReducer(initialEditorState, { type: "setFixedMm", raw: "-2.5" });
    expect(state.fixedMm).toBe(-2.5);
    const zero = editorReducer(initialEditorState, { type: "setFixedMm", raw: "0" });
    expect(zero.fixedMm).toBe(0);
  });

  it("rejects invalid fixed-coordinate inputs", () => {
    for (const raw of ["", "abc", "Infinity"]) {
      const state = editorReducer(initialEditorState, { type: "setFixedMm", raw });
      expect(state.fixedMm).toBe(0);
    }
  });

  it("converts between the UI unit (mm/min) and the internal unit (mm/s)", () => {
    expect(mmMinToMmS(1200)).toBe(20);
    expect(mmSToMmMin(20)).toBe(1200);
    expect(mmSToMmMin(mmMinToMmS(90))).toBe(90);
  });

  it("stores the feed of every Segment so each carries its own Feed", () => {
    let state = placePoint(initialEditorState, 0, 0);
    state = editorReducer(state, { type: "setFeedMmMin", raw: "300" });
    state = placePoint(state, 10, 10);
    const feeds = state.segments.map((s) => (s.kind === "point" ? s.feed : Number.NaN));
    expect(feeds).toEqual([mmMinToMmS(DEFAULT_FEED_MM_MIN), 5]);
  });

  it("is a pure function: the same action yields the same state", () => {
    const a = placePoint(initialEditorState, 1, 2);
    const b = placePoint(initialEditorState, 1, 2);
    expect(b).toEqual(a);
    expect(initialEditorState.segments).toHaveLength(0);
  });
});

describe("Project File content", () => {
  /** Builds a content with one Point, as the serializer would store it. */
  function content(): ProjectContent {
    return {
      view: { plane: "XZ", fixedMm: 4, feedMmMin: 600 },
      home: vec3(1, 4, 2),
      segments: [corePoint({ target: vec3(10, 4, 0), feed: 10 })],
    };
  }

  it("collects the drawing state from the editor: view settings, Home Point, Segments", () => {
    let state = editorReducer(
      { ...initialEditorState, plane: "XZ" as const, fixedMm: 4, feedMmMin: 600 },
      { type: "setTool", tool: "home" },
    );
    state = click(state, 1, 2);
    state = editorReducer(state, { type: "setTool", tool: "point" });
    state = placePoint(state, 10, 0);
    expect(projectContentOf(state)).toEqual(content());
  });

  it("loadProject restores the full drawing state and clears any pending draft", () => {
    const drafted = click(initialEditorState, 99, 99);
    const restored = editorReducer(drafted, { type: "loadProject", content: content() });
    expect(restored.plane).toBe("XZ");
    expect(restored.fixedMm).toBe(4);
    expect(restored.feedMmMin).toBe(600);
    expect(restored.home).toEqual(vec3(1, 4, 2));
    expect(restored.segments).toEqual(content().segments);
    expect(restored.draftStart).toBeNull();
  });

  it("loadProject replaces previous geometry and allows an unset Home Point", () => {
    const drawn = placePoint(placePoint(placePoint(initialEditorState, 0, 0), 5, 5), 10, 10);
    const restored = editorReducer(drawn, {
      type: "loadProject",
      content: { view: { plane: "XY", fixedMm: 0, feedMmMin: 1200 }, home: null, segments: [] },
    });
    expect(restored.segments).toEqual([]);
    expect(restored.home).toBeNull();
  });
});
