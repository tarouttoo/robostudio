import { describe, expect, it } from "vitest";

import { planeCoords } from "../core";
import { vec2 } from "../core";
import {
  DEFAULT_FEED_MM_MIN,
  editorReducer,
  initialEditorState,
  mmMinToMmS,
  mmSToMmMin,
  type EditorState,
} from "./editor";

/** Clicks the canvas at plane coordinates (u, v). */
function click(state: EditorState, u: number, v: number): EditorState {
  return editorReducer(state, { type: "canvasClick", u, v });
}

/** Draws a Line with two clicks, returning the resulting state. */
function drawLine(state: EditorState, u1: number, v1: number, u2: number, v2: number): EditorState {
  return click(click(state, u1, v1), u2, v2);
}

describe("editor state", () => {
  it("starts on the XY plane at fixed 0 with a default feed and no geometry", () => {
    expect(initialEditorState).toEqual({
      plane: "XY",
      fixedMm: 0,
      feedMmMin: DEFAULT_FEED_MM_MIN,
      tool: "line",
      home: null,
      segments: [],
      draftStart: null,
    });
  });

  it("commits a canonical Line Segment after two clicks, on the plane", () => {
    const state = drawLine({ ...initialEditorState, fixedMm: 2 }, 10, 5, -3.5, 40);
    expect(state.segments).toHaveLength(1);
    const seg = state.segments[0]!;
    expect(seg.kind).toBe("line");
    if (seg.kind !== "line") return;
    expect(seg.start).toEqual({ x: 10, y: 5, z: 2 });
    expect(seg.end).toEqual({ x: -3.5, y: 40, z: 2 });
    expect(seg.feed).toBe(mmMinToMmS(DEFAULT_FEED_MM_MIN));
    // The draft is consumed by the commit.
    expect(state.draftStart).toBeNull();
  });

  it("keeps the draft pending after the first click", () => {
    const state = click(initialEditorState, 10, 20);
    expect(state.segments).toHaveLength(0);
    expect(state.draftStart).toEqual(vec2(10, 20));
  });

  it("stacks Segments in draw order", () => {
    let state = drawLine(initialEditorState, 0, 0, 10, 0);
    state = drawLine(state, 10, 0, 10, 10);
    expect(state.segments).toHaveLength(2);
    expect(state.segments[0]!.kind === "line" && state.segments[0]!.start.x).toBe(0);
    expect(state.segments[1]!.kind === "line" && state.segments[1]!.end.y).toBe(10);
  });

  for (const plane of ["XY", "XZ", "YZ"] as const) {
    it(`draws on the ${plane} plane: plane switching updates which coordinate is fixed`, () => {
      // Draw on XY at z = 2, switch planes keeping the same fixed value,
      // and draw again: the new Line is fixed on the new plane's w axis.
      const onXY = drawLine({ ...initialEditorState, plane: "XY", fixedMm: 2 }, 0, 0, 10, 20);
      const switched = editorReducer(onXY, { type: "setPlane", plane });
      const onNew = drawLine(switched, 1, 2, 3, 4);
      const seg = onNew.segments[1]!;
      expect(seg.kind).toBe("line");
      if (seg.kind !== "line") return;
      const w = planeCoords(plane, seg.start).w;
      const expectedAxis = { XY: "z", XZ: "y", YZ: "x" }[plane];
      expect(planeCoords(plane, seg.end).w).toBe(2);
      expect(seg.start[expectedAxis as "x" | "y" | "z"]).toBe(2);
      expect(seg.end[expectedAxis as "x" | "y" | "z"]).toBe(2);
      expect(w).toBe(2);
    });
  }

  it("cancels the draft when the Working Plane changes", () => {
    const drafting = click(initialEditorState, 5, 5);
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
    let state = drawLine(initialEditorState, 0, 0, 10, 0);
    state = drawLine(state, 10, 0, 10, 10);
    const undone = editorReducer(state, { type: "undo" });
    expect(undone.segments).toHaveLength(1);
    expect(undone.segments[0]!.kind === "line" && undone.segments[0]!.end).toEqual({ x: 10, y: 0, z: 0 });
    const undoneTwice = editorReducer(undone, { type: "undo" });
    expect(undoneTwice.segments).toHaveLength(0);
    // Undo on an empty canvas is a no-op, not an error.
    const undoneThrice = editorReducer(undoneTwice, { type: "undo" });
    expect(undoneThrice.segments).toHaveLength(0);
  });

  it("undo does not remove the Home Point", () => {
    let state = editorReducer(initialEditorState, { type: "setTool", tool: "home" });
    state = click(state, 1, 2);
    state = drawLine({ ...state, tool: "line" }, 0, 0, 5, 5);
    const undone = editorReducer(state, { type: "undo" });
    expect(undone.segments).toHaveLength(0);
    expect(undone.home).toEqual({ x: 1, y: 2, z: 0 });
  });

  it("clear empties the canvas: Segments, Home Point, and draft", () => {
    let state = editorReducer(initialEditorState, { type: "setTool", tool: "home" });
    state = click(state, 1, 2);
    state = { ...drawLine({ ...state, tool: "line" }, 0, 0, 5, 5), draftStart: vec2(9, 9) };
    const cleared = editorReducer(state, { type: "clear" });
    expect(cleared.segments).toEqual([]);
    expect(cleared.home).toBeNull();
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
    const drafting = click(initialEditorState, 5, 5);
    const toHome = editorReducer(drafting, { type: "setTool", tool: "home" });
    expect(toHome.draftStart).toBeNull();
  });

  it("cancelDraft drops a pending draft without committing a Segment", () => {
    const drafting = click(initialEditorState, 5, 5);
    const cancelled = editorReducer(drafting, { type: "cancelDraft" });
    expect(cancelled.draftStart).toBeNull();
    expect(cancelled.segments).toHaveLength(0);
  });

  it("accepts a new feed in mm/min and draws with it (converted to mm/s)", () => {
    const state = editorReducer(initialEditorState, { type: "setFeedMmMin", raw: "600" });
    expect(state.feedMmMin).toBe(600);
    const drawn = drawLine(state, 0, 0, 10, 0);
    expect(drawn.segments[0]!.kind === "line" && drawn.segments[0]!.feed).toBe(10);
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
    let state = drawLine(initialEditorState, 0, 0, 10, 0);
    state = editorReducer(state, { type: "setFeedMmMin", raw: "300" });
    state = drawLine(state, 10, 0, 10, 10);
    const feeds = state.segments.map((s) => (s.kind === "line" ? s.feed : Number.NaN));
    expect(feeds).toEqual([mmMinToMmS(DEFAULT_FEED_MM_MIN), 5]);
  });

  it("is a pure function: the same action yields the same state", () => {
    const a = drawLine(initialEditorState, 1, 2, 3, 4);
    const b = drawLine(initialEditorState, 1, 2, 3, 4);
    expect(b).toEqual(a);
    expect(initialEditorState.segments).toHaveLength(0);
  });
});
