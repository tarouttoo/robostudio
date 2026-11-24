import { describe, expect, it } from "vitest";

import { line, resolveCenterFromRadius, vec2, vec3, type Vec2 } from "../../core";
import { DEFAULT_MIKO_MINI_CONFIG } from "../../kinematics/miko-mini";
import { checkSegmentReachability } from "../../kinematics/reachability";
import { createRobotRegistry } from "../../kinematics/registry";
import type { RobotModel } from "../../kinematics/robot-model";
import { arcPreviewPoints, drawScene, VIOLATION_COLOR, type CanvasScene } from "./draw";
import { REACHABILITY_COLORS, createReachabilitySampler } from "./reachability";
import { makeCanvasTransform, type Viewport } from "./transform";

function defaultModel(): RobotModel {
  const result = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG]);
  if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);
  const model = result.registry.resolve("miko-mini");
  if (!model) throw new Error("model miko-mini was not resolved");
  return model;
}

/** One recorded context operation, with the styles current at call time. */
interface RecordedOp {
  readonly op: string;
  readonly args: readonly unknown[];
  readonly fillStyle: string;
  readonly strokeStyle: string;
}

/**
 * A CanvasRenderingContext2D stub that records every operation with the
 * fill/stroke styles in effect — the browser canvas is a system
 * boundary, and the recording is what the assertions read.
 */
function recordingCtx(): { ctx: CanvasRenderingContext2D; ops: readonly RecordedOp[] } {
  const ops: RecordedOp[] = [];
  const current = { fillStyle: "", strokeStyle: "" };
  const record = (op: string, args: readonly unknown[] = []): void => {
    ops.push({ op, args, fillStyle: current.fillStyle, strokeStyle: current.strokeStyle });
  };
  const ctx = {
    get fillStyle() {
      return current.fillStyle;
    },
    set fillStyle(v: string) {
      current.fillStyle = v;
      record("fillStyle", [v]);
    },
    get strokeStyle() {
      return current.strokeStyle;
    },
    set strokeStyle(v: string) {
      current.strokeStyle = v;
      record("strokeStyle", [v]);
    },
    lineWidth: 0,
    setTransform: (...args: unknown[]) => record("setTransform", args),
    fillRect: (...args: unknown[]) => record("fillRect", args),
    beginPath: () => record("beginPath"),
    rect: (...args: unknown[]) => record("rect", args),
    fill: () => record("fill"),
    moveTo: (...args: unknown[]) => record("moveTo", args),
    lineTo: (...args: unknown[]) => record("lineTo", args),
    arc: (...args: unknown[]) => record("arc", args),
    stroke: () => record("stroke"),
    setLineDash: (...args: unknown[]) => record("setLineDash", args),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}

function baseScene(model: RobotModel) {
  return {
    transform: makeCanvasTransform({ widthPx: 200, heightPx: 200, devicePixelRatio: 1 }),
    plane: "XY" as const,
    segments: [],
    home: null,
    draft: null,
    cursor: null,
    reachability: createReachabilitySampler(model, "XY", 500), // blocked everywhere
    violations: [],
    draftViolation: null,
    homeStatus: null,
  };
}

/** The test viewport: 400×300 CSS pixels at DPR 1. */
const viewport: Viewport = { widthPx: 400, heightPx: 300, devicePixelRatio: 1 };

/** A transform over the test viewport, origin near the middle. */
const transform = makeCanvasTransform(viewport);

describe("drawScene", () => {
  const model = defaultModel();

  it("paints the Reachability map over the visible plane, behind the stroked scene", () => {
    const { ctx, ops } = recordingCtx();
    drawScene(ctx, baseScene(model));
    // 200 CSS px at 4 px/mm shows 50 mm; with 5 mm cells that is 10×10 cells.
    const blockedRects = ops.filter(
      (o) => o.op === "rect" && o.fillStyle === REACHABILITY_COLORS.unreachable,
    );
    expect(blockedRects.length).toBe(100);
    for (const r of blockedRects) {
      expect(r.args[2]).toBeGreaterThan(0); // positive width
      expect(r.args[3]).toBeGreaterThan(0); // positive height
    }
    // The map is a background: every map rect is recorded before the first stroke.
    const firstRect = ops.findIndex((o) => o.op === "rect");
    const firstStroke = ops.findIndex((o) => o.op === "stroke");
    expect(firstRect).toBeGreaterThan(-1);
    expect(firstStroke).toBeGreaterThan(firstRect);
  });

  it("flags a violating Segment in red while a reachable Segment keeps its own colour", () => {
    const { ctx, ops } = recordingCtx();
    const okLine = line({ start: vec3(100, 0, 0), end: vec3(150, 0, 0), feed: 20 });
    const violating = line({ start: vec3(250, 0, 0), end: vec3(400, 0, 0), feed: 20 });
    drawScene(ctx, {
      ...baseScene(model),
      segments: [okLine, violating],
      violations: [null, checkSegmentReachability(model, violating)],
    });
    // The reachable Segment keeps its own colour: the stroke belonging
    // to its path (the one starting at its projected start point) is
    // not the flag colour.
    const okStart = baseScene(model).transform.toScreen(vec2(100, 0));
    const pathStart = ops.findIndex(
      (o) => o.op === "moveTo" && o.args[0] === okStart.x && o.args[1] === okStart.y,
    );
    expect(pathStart).toBeGreaterThan(-1);
    const okStroke = ops.find((o, i) => i > pathStart && o.op === "stroke");
    expect(okStroke?.strokeStyle).not.toBe(VIOLATION_COLOR);
    // The violating Segment is stroked in the flag colour.
    expect(ops.some((o) => o.op === "stroke" && o.strokeStyle === VIOLATION_COLOR)).toBe(true);
    // Its endpoints are marked in the flag colour too.
    expect(ops.some((o) => o.op === "fillRect" && o.fillStyle === VIOLATION_COLOR)).toBe(true);
  });

  it("paints an unreachable Home Point in red and a reachable one in the Home colour", () => {
    const { ctx, ops } = recordingCtx();
    drawScene(ctx, { ...baseScene(model), home: vec3(500, 0, 60), homeStatus: "unreachable" });
    expect(ops.some((o) => o.op === "fill" && o.fillStyle === VIOLATION_COLOR)).toBe(true);

    const { ctx: okCtx, ops: okOps } = recordingCtx();
    drawScene(okCtx, { ...baseScene(model), home: vec3(100, 0, 60), homeStatus: "ok" });
    const homeFill = okOps.find((o) => o.op === "fill");
    expect(homeFill?.fillStyle).not.toBe(VIOLATION_COLOR);
  });

  it("flags the pending draft in red while it violates Reachability", () => {
    const { ctx, ops } = recordingCtx();
    drawScene(ctx, {
      ...baseScene(model),
      draft: { kind: "line", start: vec2(150, 0) },
      cursor: vec2(250, 0),
      draftViolation: { status: "unreachable", atMm: vec3(170, 0, 0) },
    });
    // The dashed preview stroke is drawn in the flag colour.
    const dashIndex = ops.findIndex((o) => o.op === "setLineDash" && (o.args[0] as number[]).length > 0);
    expect(dashIndex).toBeGreaterThan(-1);
    const dashedStroke = ops.find((o, i) => i > dashIndex && o.op === "stroke");
    expect(dashedStroke?.strokeStyle).toBe(VIOLATION_COLOR);
  });
});

/** The chord every arc scenario below draws along: (0,0) → (8,0). */
const START = vec2(0, 0);
const END = vec2(8, 0);

/** The CCW minor-arc center for the chord: 90° left of it. */
const CCW_CENTER = resolveCenterFromRadius(START, END, 10, "CCW")!;
/** The CW minor-arc center: mirrored below the chord. */
const CW_CENTER = resolveCenterFromRadius(START, END, 10, "CW")!;

/** Midpoint sample of a preview, for shape assertions. */
function midPoint(points: readonly Vec2[]): Vec2 {
  return points[Math.floor(points.length / 2)]!;
}

describe("arc preview points", () => {
  it("spans the draft exactly: first point is the start, last the on-circle end of the cursor ray", () => {
    const points = arcPreviewPoints({
      center: CCW_CENTER,
      radiusMm: 10,
      start: START,
      cursor: END,
      direction: "CCW",
    });
    expect(points[0]).toEqual(START);
    const last = points[points.length - 1]!;
    // The cursor defines the angle; the end sits on the circle.
    expect(last.x).toBeCloseTo(END.x, 12);
    expect(last.y).toBeCloseTo(END.y, 12);
  });

  it("keeps every sample on the circle", () => {
    const points = arcPreviewPoints({
      center: CCW_CENTER,
      radiusMm: 10,
      start: START,
      cursor: vec2(14, 3),
      direction: "CCW",
    });
    for (const p of points) {
      expect(Math.hypot(p.x - CCW_CENTER.x, p.y - CCW_CENTER.y)).toBeCloseTo(10, 9);
    }
  });

  it("bends CW and CCW previews to opposite sides: direction is visible before the click", () => {
    const ccw = arcPreviewPoints({ center: CCW_CENTER, radiusMm: 10, start: START, cursor: END, direction: "CCW" });
    const cw = arcPreviewPoints({ center: CW_CENTER, radiusMm: 10, start: START, cursor: END, direction: "CW" });
    const ccwMid = midPoint(ccw);
    const cwMid = midPoint(cw);
    // The CCW center lies above the chord, its arc bulges below it; CW mirrors.
    expect(ccwMid.y).toBeLessThan(0);
    expect(cwMid.y).toBeGreaterThan(0);
  });

  it("follows a moved cursor: the preview sweep tracks the cursor angle", () => {
    const near = arcPreviewPoints({ center: CCW_CENTER, radiusMm: 10, start: START, cursor: END, direction: "CCW" });
    const far = arcPreviewPoints({
      center: CCW_CENTER,
      radiusMm: 10,
      start: START,
      cursor: vec2(CCW_CENTER.x, CCW_CENTER.y - 10),
      direction: "CCW",
    });
    // The second cursor sits at the circle's bottom: a larger CCW sweep.
    expect(far.length).toBeGreaterThan(0);
    expect(midPoint(far)).not.toEqual(midPoint(near));
  });
});

describe("drawScene with arc drafts", () => {
  // A pointermove always precedes a pointerdown, so right after the
  // first Arc click the cursor is exactly on the fresh draft start —
  // the scene painted then must not depend on a center being resolvable.
  const sceneWith = (cursor: Vec2): Omit<CanvasScene, "transform"> => ({
    plane: "XY",
    segments: [],
    home: null,
    draft: { kind: "arcRadius", start: START, radiusMm: 10, direction: "CCW" },
    cursor,
    reachability: createReachabilitySampler(defaultModel(), "XY", 500),
    violations: [],
    draftViolation: null,
    homeStatus: null,
  });

  it("tolerates a cursor on the draft start: no center is resolvable yet, so no preview", () => {
    expect(() => drawScene(stubCtx(), { ...sceneWith(START), transform })).not.toThrow();
  });

  it("tolerates a settled draft: a resolvable center paints the preview", () => {
    expect(() => drawScene(stubCtx(), { ...sceneWith(END), transform })).not.toThrow();
  });
});

/**
 * A do-nothing 2D context stub. The canvas API is a system boundary
 * (node test environment, no real canvas); drawScene only strokes, so
 * recording nothing is enough to exercise its control flow.
 */
function stubCtx(): CanvasRenderingContext2D {
  const noop = (): void => {};
  return {
    setTransform: noop,
    fillRect: noop,
    beginPath: noop,
    rect: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    stroke: noop,
    fill: noop,
    setLineDash: noop,
  } as unknown as CanvasRenderingContext2D;
}
