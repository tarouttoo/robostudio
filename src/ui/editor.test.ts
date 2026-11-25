import { describe, expect, it } from "vitest";

import { planeCoords } from "../core";
import { point as corePoint, vec2, vec3 } from "../core";
import { discretizeTrajectory } from "../core/discretize";
import { trajectory } from "../core/trajectory";
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

/** Places the Home Point with one click (the Home Point tool). */
function placeHome(state: EditorState, u: number, v: number): EditorState {
  return click({ ...state, tool: "home" }, u, v);
}

/**
 * Draws a chained radius-mode Arc (R = 10 mm) with one click — the
 * Arc's end; the Arc starts where the chain stands.
 */
function drawArc(state: EditorState, u: number, v: number): EditorState {
  return click({ ...state, tool: "arc", arcRadiusMm: 10 }, u, v);
}

describe("editor state", () => {
  it("starts on the XY plane at fixed 0 with a default feed, the default Motion Type LIN, the default Home Point, the chained Point tool, and no Segments", () => {
    expect(initialEditorState).toEqual({
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
    expect(state.draftCenter).toBeNull();
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

  it("cancels a pending Arc center when the Working Plane changes", () => {
    let state = placeHome(initialEditorState, 0, 0);
    state = click({ ...state, tool: "arc", arcMode: "center" }, 5, 5);
    expect(state.draftCenter).toEqual(vec2(5, 5));
    const switched = editorReducer(state, { type: "setPlane", plane: "YZ" });
    expect(switched.plane).toBe("YZ");
    expect(switched.draftCenter).toBeNull();
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
    // A pending Arc center is dropped by the clear too.
    state = click({ ...state, tool: "arc", arcMode: "center" }, 9, 9);
    const cleared = editorReducer(state, { type: "clear" });
    expect(cleared.segments).toEqual([]);
    expect(cleared.home).toEqual(DEFAULT_HOME_POINT);
    expect(cleared.draftCenter).toBeNull();
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
    const drafting = click({ ...initialEditorState, tool: "arc", arcMode: "center" }, 5, 5);
    const toHome = editorReducer(drafting, { type: "setTool", tool: "home" });
    expect(toHome.draftCenter).toBeNull();
  });

  it("Point tool commits a Point Segment with one click: a Move to the target without drawn geometry", () => {
    let state = editorReducer(initialEditorState, { type: "setTool", tool: "point" });
    state = click(state, 3.25, -1.5);
    expect(state.segments).toHaveLength(1);
    const seg = state.segments[0]!;
    expect(seg.kind).toBe("point");
    if (seg.kind !== "point") return;
    expect(seg.target).toEqual({ x: 3.25, y: -1.5, z: 0 });
    expect(seg.feed).toBe(mmMinToMmS(DEFAULT_FEED_MM_MIN));
    // The default Motion Type is LIN: the Move follows the drawn line.
    expect(seg.motionType).toBe("LIN");
    // A Point has no draft: the next click places the next Point in the chain.
    expect(state.draftCenter).toBeNull();
  });

  it("commits PTP Moves while the Motion Type toggle is PTP, and keeps editing the next Move", () => {
    const ptp = editorReducer(initialEditorState, { type: "setMotionType", motionType: "PTP" });
    const placed = click(ptp, 5, 6);
    const seg = placed.segments[0]!;
    expect(seg.kind === "point" && seg.motionType).toBe("PTP");
    // The toggle stays for the next Move.
    const second = click(placed, 7, 8);
    expect(second.segments[1]!.kind === "point" && second.segments[1]!.motionType).toBe("PTP");
    // Switching back to LIN: only future Moves change.
    const back = editorReducer(second, { type: "setMotionType", motionType: "LIN" });
    expect(back.segments[0]!.kind === "point" && back.segments[0]!.motionType).toBe("PTP");
    const third = click(back, 9, 10);
    expect(third.segments[2]!.kind === "point" && third.segments[2]!.motionType).toBe("LIN");
  });

  it("edits a committed Move's Motion Type in place, like its Feed", () => {
    const lin = click(initialEditorState, 1, 2);
    const ptp = click({ ...lin, motionType: "PTP" }, 3, 4);
    const edited = editorReducer(ptp, { type: "setSegmentMotionType", index: 0, motionType: "PTP" });
    const first = edited.segments[0]!;
    expect(first.kind === "point" && first.motionType).toBe("PTP");
    if (first.kind !== "point") return;
    // Geometry and target stay untouched; the second Move is unaffected.
    expect(first.target).toEqual({ x: 1, y: 2, z: 0 });
    expect(edited.segments[1]!.kind === "point" && edited.segments[1]!.motionType).toBe("PTP");
    const back = editorReducer(edited, { type: "setSegmentMotionType", index: 0, motionType: "LIN" });
    expect(back.segments[0]!.kind === "point" && back.segments[0]!.motionType).toBe("LIN");
  });

  it("ignores a Motion Type edit for an unknown Segment index", () => {
    const state = placePoint(initialEditorState, 0, 0);
    expect(editorReducer(state, { type: "setSegmentMotionType", index: 5, motionType: "PTP" })).toBe(state);
    expect(editorReducer(state, { type: "setSegmentMotionType", index: -1, motionType: "PTP" })).toBe(state);
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

  it("commits a canonical Arc with one click in radius mode, starting at the Home Point", () => {
    // The Home Point on the plane: the first Arc starts exactly there.
    const homed = placeHome(initialEditorState, 0, 0);
    const done = click({ ...homed, tool: "arc", arcRadiusMm: 10 }, 8, 0);
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
    // One-click commits hold no draft.
    expect(done.draftCenter).toBeNull();
    expect(done.error).toBeNull();
  });

  it("chains an Arc to the previous Segment's end: the Arc starts where the Move arrived", () => {
    const moved = placePoint(initialEditorState, 10, 5);
    const done = drawArc(moved, 18, 5);
    expect(done.segments).toHaveLength(2);
    const seg = done.segments[1]!;
    expect(seg.kind).toBe("arc");
    if (seg.kind !== "arc") return;
    // The start is the Move's target, bit for bit — not a stored click.
    expect(seg.start).toEqual({ x: 10, y: 5, z: 0 });
    expect(seg.end).toEqual({ x: 18, y: 5, z: 0 });
    expect(seg.radiusMm).toBe(10);
  });

  it("CW and CCW resolve distinct chained arcs from the same end click", () => {
    const homed = placeHome(initialEditorState, 0, 0);
    const ccw = click({ ...homed, tool: "arc", arcRadiusMm: 10, arcDirection: "CCW" }, 8, 0);
    const cw = click({ ...homed, tool: "arc", arcRadiusMm: 10, arcDirection: "CW" }, 8, 0);
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

  it("rejects an end farther from the chain end than 2·R at draw time with a readable message", () => {
    const homed = placeHome(initialEditorState, 0, 0);
    const rejected = click({ ...homed, tool: "arc", arcRadiusMm: 10 }, 50, 0);
    expect(rejected.segments).toHaveLength(0);
    // The radius-mode Arc holds no draft: the operator just clicks again.
    expect(rejected.draftCenter).toBeNull();
    expect(rejected.error).toContain("невозможна");
    expect(rejected.error).toContain("радиус");
  });

  it("rejects an end click on the chain end (no unique center from R)", () => {
    const homed = placeHome(initialEditorState, 3, 4);
    const rejected = click({ ...homed, tool: "arc", arcRadiusMm: 10 }, 3, 4);
    expect(rejected.segments).toHaveLength(0);
    expect(rejected.error).toContain("невозможна");
  });

  it("clears the rejection once a valid retry commits", () => {
    const homed = placeHome(initialEditorState, 0, 0);
    const rejected = click({ ...homed, tool: "arc", arcRadiusMm: 10 }, 50, 0);
    const retried = click(rejected, 8, 0);
    expect(retried.segments).toHaveLength(1);
    expect(retried.error).toBeNull();
    expect(retried.draftCenter).toBeNull();
  });

  it("applies radius and direction changes live to the next commit", () => {
    const homed = placeHome(initialEditorState, 0, 0);
    let state: EditorState = { ...homed, tool: "arc" };
    state = editorReducer(state, { type: "setArcRadiusMm", raw: "25" });
    state = editorReducer(state, { type: "setArcDirection", direction: "CW" });
    const done = click(state, 10, 0);
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

  it("cancelDraft clears the rejection (the radius-mode Arc holds no draft)", () => {
    const homed = placeHome(initialEditorState, 0, 0);
    const rejected = click({ ...homed, tool: "arc", arcRadiusMm: 10 }, 50, 0);
    const cancelled = editorReducer(rejected, { type: "cancelDraft" });
    expect(cancelled.error).toBeNull();
    expect(cancelled.draftCenter).toBeNull();
  });

  it("center mode: two clicks commit an Arc — the center, then the end snapped onto the circle", () => {
    const homed = placeHome(initialEditorState, 0, 0);
    let state: EditorState = { ...homed, tool: "arc", arcMode: "center" };
    state = click(state, 10, 0); // the center, 10 mm from the chain end
    expect(state.segments).toHaveLength(0);
    expect(state.draftCenter).toEqual(vec2(10, 0));
    state = click(state, 19, 7); // off-circle on purpose: snapped onto the circle
    expect(state.segments).toHaveLength(1);
    const seg = state.segments[0]!;
    expect(seg.kind).toBe("arc");
    if (seg.kind !== "arc") return;
    expect(seg.center).toEqual({ x: 10, y: 0, z: 0 });
    expect(seg.radiusMm).toBe(10);
    expect(seg.direction).toBe("CCW");
    // The Arc starts at the Home Point; the end lands exactly on the circle.
    expect(seg.start).toEqual({ x: 0, y: 0, z: 0 });
    const end = planeCoords("XY", seg.end);
    expect(Math.hypot(end.u - 10, end.v)).toBeCloseTo(10, 12);
    expect(state.draftCenter).toBeNull();
    expect(state.error).toBeNull();
  });

  it("center mode: CW and CCW sweep opposite ways from the same clicks", () => {
    const draw = (direction: "CW" | "CCW"): EditorState => {
      const homed = placeHome(initialEditorState, 0, 0);
      let state: EditorState = {
        ...homed,
        tool: "arc",
        arcMode: "center",
        arcDirection: direction,
      };
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

  it("center mode: rejects a center click on the chain end with a readable message", () => {
    const homed = placeHome(initialEditorState, 3, 4);
    const rejected = click({ ...homed, tool: "arc", arcMode: "center" }, 3, 4);
    expect(rejected.segments).toHaveLength(0);
    expect(rejected.draftCenter).toBeNull();
    expect(rejected.error).toContain("невозможна");
    expect(rejected.error).toContain("центр");
    // A side click after the rejection still pends the center.
    const recovered = click(rejected, 13, 4);
    expect(recovered.error).toBeNull();
    expect(recovered.draftCenter).toEqual(vec2(13, 4));
  });

  it("center mode: an end click on the center is rejected, keeping the pending center", () => {
    const homed = placeHome(initialEditorState, 0, 0);
    let state: EditorState = { ...homed, tool: "arc", arcMode: "center" };
    state = click(state, 10, 0);
    const rejected = click(state, 10, 0);
    expect(rejected.segments).toHaveLength(0);
    expect(rejected.draftCenter).toEqual(vec2(10, 0));
    expect(rejected.error).toContain("невозможна");
  });

  it("switching the Arc mode drops a pending center", () => {
    let state = placeHome(initialEditorState, 0, 0);
    state = click({ ...state, tool: "arc", arcMode: "center" }, 5, 2);
    const switched = editorReducer(state, { type: "setArcMode", mode: "radius" });
    expect(switched.arcMode).toBe("radius");
    expect(switched.draftCenter).toBeNull();
    expect(switched.error).toBeNull();
  });

  it("rejects an Arc whose chain start lies off the current plane, with a readable message", () => {
    // The default Home Point [213, 0, 305] is off the XY plane at fixed 0:
    // an Arc lies entirely in its Working Plane, so the draw is refused.
    const rejected = click({ ...initialEditorState, tool: "arc", arcRadiusMm: 10 }, 221, 0);
    expect(rejected.segments).toHaveLength(0);
    expect(rejected.error).toContain("невозможна");
    expect(rejected.error).toContain("плоскости");
  });

  it("rejects an Arc with no chain start: no Home Point and nothing drawn", () => {
    const rejected = click({ ...initialEditorState, home: null, tool: "arc" }, 10, 10);
    expect(rejected.segments).toHaveLength(0);
    expect(rejected.error).toContain("невозможна");
  });

  it("undoes across chained Arcs and Moves: one Move or Arc per Отменить", () => {
    const moved = placePoint(initialEditorState, 0, 0);
    const drawn = drawArc(moved, 8, 0);
    const undoneArc = editorReducer(drawn, { type: "undo" });
    expect(undoneArc.segments).toHaveLength(1);
    expect(undoneArc.segments[0]!.kind).toBe("point");
    const undoneMove = editorReducer(undoneArc, { type: "undo" });
    expect(undoneMove.segments).toHaveLength(0);
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

  it("numeric entry drives the chained Arc: one entry commits a radius-mode Arc from the Home Point", () => {
    const homed = placeHome(initialEditorState, 0, 0);
    const done = editorReducer({ ...homed, tool: "arc", arcRadiusMm: 10 }, { type: "numericEntry", u: 8, v: 0 });
    expect(done.segments).toHaveLength(1);
    const seg = done.segments[0]!;
    expect(seg.kind).toBe("arc");
    if (seg.kind !== "arc") return;
    expect(seg.start).toEqual({ x: 0, y: 0, z: 0 });
    expect(seg.end).toEqual({ x: 8, y: 0, z: 0 });
  });

  it("numeric entry drives the chained Arc: two entries commit a center-mode Arc", () => {
    const homed = placeHome(initialEditorState, 0, 0);
    let state = editorReducer(
      { ...homed, tool: "arc", arcMode: "center" },
      { type: "numericEntry", u: 10, v: 0 },
    );
    expect(state.draftCenter).toEqual(vec2(10, 0));
    state = editorReducer(state, { type: "numericEntry", u: 19, v: 7 });
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0]!.kind).toBe("arc");
    expect(state.draftCenter).toBeNull();
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
    const drawn = drawArc(placePoint(initialEditorState, 0, 0), 8, 0);
    const edited = editorReducer(drawn, { type: "setSegmentFeedMmMin", index: 1, raw: "600" });
    const seg = edited.segments[1]!;
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
    // The Point tool previews the pending Move, carrying its Motion
    // Type, from the chain end — the Home Point before the first
    // Segment — to the cursor. The default is LIN.
    expect(draftPreviewOf(initialEditorState)).toEqual({ kind: "move", motionType: "LIN", start: vec2(213, 0) });
    // After placed Points the preview chains from the last target.
    const chained = placePoint(placePoint(initialEditorState, 0, 0), 10, 4);
    expect(draftPreviewOf(chained)).toEqual({ kind: "move", motionType: "LIN", start: vec2(10, 4) });
    // A PTP toggle shows in the preview.
    const ptp = editorReducer(chained, { type: "setMotionType", motionType: "PTP" });
    expect(draftPreviewOf(ptp)).toEqual({ kind: "move", motionType: "PTP", start: vec2(10, 4) });
    // No Home Point and nothing drawn: no Move to preview.
    expect(draftPreviewOf({ ...initialEditorState, home: null })).toBeNull();
    // The chained Arc previews from the chain end with no click needed:
    // radius and direction ride along, so the pending Arc follows the
    // cursor before any click at all.
    const arcDraft = { ...chained, tool: "arc" as const, arcRadiusMm: 14, arcDirection: "CW" as const };
    expect(draftPreviewOf(arcDraft)).toEqual({
      kind: "arcRadius",
      start: vec2(10, 4),
      radiusMm: 14,
      direction: "CW",
    });
    // A center-mode draft: center null before the first click, set after it.
    let centerDraft: EditorState = { ...arcDraft, arcMode: "center" };
    expect(draftPreviewOf(centerDraft)).toEqual({ kind: "arcCenter", start: vec2(10, 4), center: null, direction: "CW" });
    centerDraft = click(centerDraft, 6, 1);
    expect(draftPreviewOf(centerDraft)).toEqual({ kind: "arcCenter", start: vec2(10, 4), center: vec2(6, 1), direction: "CW" });
    // No chain start (no Home Point, nothing drawn): no Arc to preview.
    expect(draftPreviewOf({ ...arcDraft, home: null, segments: [] })).toBeNull();
    // The Home Point tool holds no draft.
    const homeState = editorReducer({ ...initialEditorState, tool: "home" }, { type: "canvasClick", u: 5, v: 5 });
    expect(draftPreviewOf(homeState)).toBeNull();
  });

  it("chains the Move preview to an Arc's end: Points continue where the Arc finished", () => {
    const drawn = drawArc(placePoint(initialEditorState, 0, 0), 8, 0);
    expect(drawn.segments).toHaveLength(2);
    // Back to the Point tool: the pending Move starts at the Arc's end,
    // not at the Home Point.
    const chaining = editorReducer(drawn, { type: "setTool", tool: "point" });
    const preview = draftPreviewOf(chaining);
    expect(preview).not.toBeNull();
    if (preview === null || preview.kind !== "move") return;
    expect(preview.start).toEqual(vec2(8, 0));
  });

  it("cancelDraft drops a pending Arc center without committing a Segment", () => {
    let state = placeHome(initialEditorState, 0, 0);
    state = click({ ...state, tool: "arc", arcMode: "center" }, 5, 5);
    const cancelled = editorReducer(state, { type: "cancelDraft" });
    expect(cancelled.draftCenter).toBeNull();
    expect(cancelled.segments).toHaveLength(0);
  });

  it("a chained Move → Arc → Move drawing discretizes continuously: no duplicate samples at the joins", () => {
    const homed = placeHome(initialEditorState, 0, 0);
    let state: EditorState = { ...homed, tool: "point" };
    state = click(state, 0, 0); // Move onto the chain start
    state = click({ ...state, tool: "arc", arcRadiusMm: 10 }, 8, 0); // chained Arc
    state = click({ ...state, tool: "point" }, 16, 0); // chained Move
    if (state.home === null) throw new Error("test drew without a Home Point");
    const path = discretizeTrajectory(trajectory(state.home, [...state.segments]));
    expect(path.samples.length).toBeGreaterThan(3);
    // No two consecutive samples share a position: joins are merged.
    for (let i = 1; i < path.samples.length; i++) {
      const prev = path.samples[i - 1]!;
      const cur = path.samples[i]!;
      expect(cur.position).not.toEqual(prev.position);
      // The cumulative path length never stalls and never falls.
      expect(cur.pathLengthMm).toBeGreaterThanOrEqual(prev.pathLengthMm);
    }
    // Every Segment of the chain carries samples: Move, Arc, Move.
    expect(new Set(path.samples.map((s) => s.segmentIndex))).toEqual(new Set([0, 1, 2]));
    // Total pen travel: Move (0,0), arc of R 10, Move to (16, 0).
    const chord = Math.hypot(16 - 0, 0);
    expect(path.totalLengthMm).toBeGreaterThan(chord);
  });

  it("accepts a new feed in mm/min and draws with it (converted to mm/s)", () => {
    const state = editorReducer(initialEditorState, { type: "setFeedMmMin", raw: "600" });
    expect(state.feedMmMin).toBe(600);
    const drawn = placePoint(state, 10, 0);
    const seg = drawn.segments[0]!;
    expect(seg.kind === "point" && seg.feed).toBe(10);
  });

  it("draws at the old feed after drawing: the toolbar field is modal, it does not rewrite drawn Segments", () => {
    // Issue #60's report: the field changed after drawing must not be
    // mistaken for a live speed control — only new Segments pick it up.
    const drawn = placePoint(initialEditorState, 10, 0);
    const retuned = editorReducer(drawn, { type: "setFeedMmMin", raw: "600" });
    const seg = retuned.segments[0]!;
    expect(retuned.feedMmMin).toBe(600);
    expect(seg.kind === "point" && seg.feed).toBe(mmMinToMmS(DEFAULT_FEED_MM_MIN));
  });

  it("apply-to-all rewrites every drawn Segment's Feed — individually edited ones included — and keeps the geometry", () => {
    let state: EditorState = { ...placeHome(initialEditorState, 0, 0), tool: "point" };
    state = placePoint(state, 10, 0);
    state = placePoint(state, 10, 10);
    // One Segment is tuned individually to 600 mm/min = 10 mm/s.
    const tuned = editorReducer(state, { type: "setSegmentFeedMmMin", index: 1, raw: "600" });
    const retuned = editorReducer(tuned, { type: "setFeedMmMin", raw: "1800" });
    const applied = editorReducer(retuned, { type: "applyFeedToAllSegments" });
    expect(applied.feedMmMin).toBe(1800);
    expect(applied.segments).toHaveLength(2);
    for (const seg of applied.segments) {
      expect(seg.feed).toBe(30); // 1800 mm/min = 30 mm/s
    }
    // The geometry is untouched: same targets in draw order.
    const [first, second] = applied.segments;
    expect(first?.kind === "point" && first.target).toEqual(vec3(10, 0, 0));
    expect(second?.kind === "point" && second.target).toEqual(vec3(10, 10, 0));
  });

  it("apply-to-all on an empty drawing is a no-op", () => {
    const applied = editorReducer(initialEditorState, { type: "applyFeedToAllSegments" });
    expect(applied.segments).toHaveLength(0);
    expect(applied.feedMmMin).toBe(initialEditorState.feedMmMin);
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
      segments: [corePoint({ target: vec3(10, 4, 0), feed: 10, motionType: "LIN" })],
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
    let drafted = placeHome(initialEditorState, 0, 0);
    drafted = click({ ...drafted, tool: "arc", arcMode: "center" }, 99, 99);
    const restored = editorReducer(drafted, { type: "loadProject", content: content() });
    expect(restored.plane).toBe("XZ");
    expect(restored.fixedMm).toBe(4);
    expect(restored.feedMmMin).toBe(600);
    expect(restored.home).toEqual(vec3(1, 4, 2));
    expect(restored.segments).toEqual(content().segments);
    expect(restored.draftCenter).toBeNull();
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

  it("loadProject restores each Move's Motion Type", () => {
    const restored = editorReducer(initialEditorState, {
      type: "loadProject",
      content: {
        view: { plane: "XY", fixedMm: 0, feedMmMin: 1200 },
        home: vec3(0, 0, 0),
        segments: [
          corePoint({ target: vec3(10, 0, 0), feed: 10, motionType: "LIN" }),
          corePoint({ target: vec3(20, 0, 0), feed: 10, motionType: "PTP" }),
        ],
      },
    });
    expect(restored.segments.map((s) => (s.kind === "point" ? s.motionType : null))).toEqual([
      "LIN",
      "PTP",
    ]);
  });
});
