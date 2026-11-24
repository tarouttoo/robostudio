import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { arcFromCenter } from "../core/arc";
import { line, trajectory, type Trajectory } from "../core/trajectory";
import { vec3 } from "../core/vec";
import { DEFAULT_MIKO_MINI_CONFIG } from "../kinematics/miko-mini";
import { createRobotRegistry } from "../kinematics/registry";
import type { JointAngles, RobotModel } from "../kinematics/robot-model";
import {
  CONTROL_STEP_MS,
  createPchipPlanner,
  type MotionPlan,
  type MotionRow,
  type PlanSegmentRange,
} from "../motion/planner";
import { runPipeline } from "./pipeline";
import { CHART_IDS, renderCharts, type ChartId, type RenderedChart } from "./charts";

/*
 * Headless charts (spec user stories 18–20): every plot the spec asks
 * for renders from the Motion Plan alone — no UI, no DOM — so CI can
 * verify the plotted output before any chart view exists. The tests
 * here go through the public render seam only: they read the returned
 * SVG documents (their structure, their text, their plotted point
 * counts) the way the future UI and a CI job would, never internals.
 */

/** The default MiKo-mini model from validated configuration. */
function defaultModel(): RobotModel {
  const result = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG]);
  if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);
  const model = result.registry.resolve("miko-mini");
  if (!model) throw new Error("model miko-mini was not resolved");
  return model;
}

/**
 * A Robot Model whose FK is the identity: joint angle i lands at
 * coordinate i, so handcrafted plans have millimetre-exact geometry.
 */
function identityModel(): RobotModel {
  const joints = DEFAULT_MIKO_MINI_CONFIG.joints.map((joint) => ({
    ...joint,
    minRad: -1e6,
    maxRad: 1e6,
  }));
  return {
    id: "identity-test",
    name: "Identity test model",
    joints,
    // Unused by these tests; the interface requires a finite bound.
    workspaceRadiusMm: 1000,
    forwardKinematics: (angles) => [angles[0] as number, angles[1] as number, angles[2] as number],
    chainPoints: (angles) => [
      [0, 0, 0],
      [0, 0, 0],
      [angles[0] as number, 0, 0],
      [angles[1] as number, 0, 0],
      [angles[2] as number, 0, 0],
    ],
    inverseKinematics: (target) => ({ status: "ok", joints: [...target] as JointAngles }),
  };
}

/** A line into the workspace followed by a quarter arc, both reachable. */
const LINE_AND_ARC: Trajectory = trajectory(vec3(80, 0, 60), [
  line({ start: vec3(80, 0, 60), end: vec3(100, 20, 60), feed: 20 }),
  arcFromCenter({
    plane: "XY",
    start: vec3(100, 20, 60),
    end: vec3(80, 40, 60),
    center: vec3(80, 20, 60),
    direction: "CCW",
    feed: 10,
  }),
]);

/** Builds one MotionRow sitting on the control grid. */
function row(tMs: number, q: readonly number[], qd: readonly number[] = [0, 0, 0]): MotionRow {
  return { tMs, segmentIndex: 0, q, qd, qdd: [0, 0, 0], qddd: [0, 0, 0] };
}

/** A single range covering the whole plan (one planned Segment). */
function oneRange(feed: number, startMs: number, endMs: number): readonly PlanSegmentRange[] {
  return [{ segmentIndex: 0, feed, startMs, endMs }];
}

/** A plan whose identity-model pen moves along +X at exactly 20 mm/s. */
const X_AT_20_MM_S: MotionPlan = {
  rows: [0, 1, 2, 3, 4, 5].map((k) => row(k * CONTROL_STEP_MS, [0.02 * k * CONTROL_STEP_MS, 0, 0])),
  ranges: oneRange(20, 0, 100),
  durationMs: 100,
};

/**
 * A plan tracing an L in the identity model's XY plane: 2 mm along +X
 * then 2 mm along +Y — two legs of equal drawn length for the
 * equal-aspect checks (ADR 0007: drawn squares must not turn into
 * rectangles, on screen or in charts).
 */
const L_SHAPED_PLAN: MotionPlan = {
  rows: [
    ...[0, 1, 2, 3, 4, 5].map((k) => row(k * CONTROL_STEP_MS, [0.02 * k * CONTROL_STEP_MS, 0, 0])),
    ...[6, 7, 8, 9, 10, 11].map((k) =>
      row(k * CONTROL_STEP_MS, [2, 0.02 * (k * CONTROL_STEP_MS - 100), 0]),
    ),
  ],
  ranges: oneRange(20, 0, 220),
  durationMs: 220,
};

/**
 * A plan that moves at 20 mm/s for 60 ms, then at 10 mm/s — the
 * velocity step of 10 mm/s across one 20 ms row gap pins the plotted
 * acceleration magnitude (|Δv|/Δt = 500 mm/s²).
 */
const TWO_PHASE_PLAN: MotionPlan = {
  rows: [
    [0, 20, 40, 60].map((t) => row(t, [0.02 * t, 0, 0])),
    [80, 100].map((t) => row(t, [1.2 + 0.01 * (t - 60), 0, 0])),
  ].flat(),
  ranges: oneRange(20, 0, 100),
  durationMs: 100,
};

/** The 100×100 mm square the golden geometry tests guard (ADR 0007). */
const SQUARE: Trajectory = trajectory(vec3(60, -50, 60), [
  line({ start: vec3(60, -50, 60), end: vec3(160, -50, 60), feed: 20 }),
  line({ start: vec3(160, -50, 60), end: vec3(160, 50, 60), feed: 20 }),
  line({ start: vec3(160, 50, 60), end: vec3(60, 50, 60), feed: 20 }),
  line({ start: vec3(60, 50, 60), end: vec3(60, -50, 60), feed: 20 }),
]);

/** A one-row plan: the degenerate case every chart must survive. */
const ONE_ROW_PLAN: MotionPlan = {
  rows: [row(0, [0.1, 0.2, 0.3])],
  ranges: oneRange(20, 0, CONTROL_STEP_MS),
  durationMs: 0,
};

/**
 * A zero-row plan: undefined input per the renderer's docs — charts
 * must render degenerate-but-harmless, never NaN/Infinity.
 */
const EMPTY_PLAN: MotionPlan = {
  rows: [],
  ranges: oneRange(20, 0, CONTROL_STEP_MS),
  durationMs: 0,
};

/** Picks one rendered chart by its stable id. */
function chartById(charts: readonly RenderedChart[], id: ChartId): RenderedChart {
  const chart = charts.find((c) => c.id === id);
  if (!chart) throw new Error(`no chart with id "${id}" rendered`);
  return chart;
}

/** Text contents of every element carrying the given class, in document order. */
function texts(svg: string, className: string): readonly string[] {
  return [...svg.matchAll(new RegExp(`<text class="${className}"[^>]*>([^<]*)</text>`, "g"))].map(
    (m) => m[1] as string,
  );
}

/** The plotted series of a chart, parsed from the SVG document. */
function series(svg: string): readonly {
  name: string;
  points: readonly (readonly [number, number])[];
}[] {
  return [...svg.matchAll(/<polyline class="series" data-series="([^"]+)" points="([^"]+)"/g)].map(
    (m) => ({
      name: m[1] as string,
      points: (m[2] as string)
        .split(" ")
        .map((pair) => {
          const [x, y] = (pair as string).split(",");
          return [Number(x), Number(y)] as const;
        }),
    }),
  );
}

/** The number format of tick and extent labels in chart SVGs — the output contract. */
function fmt(v: number): string {
  return v === 0 ? "0" : String(Number(v.toPrecision(6)));
}

/** min/max of one joint's value across the plan rows. */
function extent(values: readonly number[]): readonly [number, number] {
  return [Math.min(...values), Math.max(...values)];
}

/** Total polyline length of the first `count` plotted points. */
function drawnLength(points: readonly (readonly [number, number])[], count: number): number {
  let total = 0;
  for (let i = 1; i < count; i++) {
    const [x0, y0] = points[i - 1] as readonly [number, number];
    const [x1, y1] = points[i] as readonly [number, number];
    total += Math.hypot(x1 - x0, y1 - y0);
  }
  return total;
}

describe("chart seam", () => {
  const model = defaultModel();
  const plan = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createPchipPlanner(model) }).plan;

  it("renders every chart kind from the spec, in a stable order", () => {
    expect(CHART_IDS).toEqual([
      "joint-positions",
      "joint-velocities",
      "joint-accelerations",
      "joint-jerks",
      "cartesian-path",
      "end-effector-velocity",
      "end-effector-acceleration",
      "path-3d",
    ]);
    const charts = renderCharts(plan, model);
    expect(charts.map((c) => c.id)).toEqual([...CHART_IDS]);
    for (const chart of charts) {
      expect(chart.title.length).toBeGreaterThan(0);
      expect(chart.svg.length).toBeGreaterThan(0);
    }
  });

  it("renders standalone SVG documents", () => {
    for (const chart of renderCharts(plan, model)) {
      expect(chart.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(chart.svg.endsWith("</svg>")).toBe(true);
      expect(chart.svg).toMatch(/width="\d+" height="\d+"/);
      expect(chart.svg).toMatch(/viewBox="0 0 \d+ \d+"/);
    }
  });

  it("never emits NaN, Infinity, or undefined, even for one-row and zero-row plans", () => {
    const plans = [plan, X_AT_20_MM_S, ONE_ROW_PLAN, EMPTY_PLAN];
    for (const p of plans) {
      for (const chart of renderCharts(p, model)) {
        expect(chart.svg).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });

  it("labels every tick in plain decimal — no exponent noise, no repeated label on an axis", () => {
    const plans = [plan, X_AT_20_MM_S, TWO_PHASE_PLAN, ONE_ROW_PLAN, EMPTY_PLAN];
    for (const p of plans) {
      for (const chart of renderCharts(p, model)) {
        for (const cls of ["tick-x", "tick-y"]) {
          const labels = texts(chart.svg, cls);
          for (const t of labels) {
            expect(t).toMatch(/^-?\d+(\.\d+)?$/);
          }
          expect(new Set(labels).size).toBe(labels.length);
        }
      }
    }
  });

  it("plots exactly-constant motion as exactly constant: speed 20 mm/s, acceleration 0", () => {
    const model = identityModel();
    const speed = chartById(renderCharts(X_AT_20_MM_S, model), "end-effector-velocity").svg;
    expect(texts(speed, "tick-y")).toContain("20");
    // Finite differencing of exactly-collinear positions must not
    // plot a nonsense 10⁻¹²-scale acceleration axis.
    const accel = chartById(renderCharts(X_AT_20_MM_S, model), "end-effector-acceleration").svg;
    expect(texts(accel, "tick-y")).toContain("0");
  });

  it("is a pure function of the plan and model", () => {
    expect(renderCharts(plan, model)).toEqual(renderCharts(plan, model));
  });

  it("writes to files headless: every rendered document lands on disk as valid SVG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "charts-"));
    try {
      for (const chart of renderCharts(plan, model)) {
        await writeFile(join(dir, `${chart.id}.svg`), chart.svg, "utf8");
      }
      const names = await readdir(dir);
      expect(names).toHaveLength(CHART_IDS.length);
      const first = await readFile(join(dir, "joint-positions.svg"), "utf8");
      expect(first.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("joint charts", () => {
  const model = defaultModel();
  const plan = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createPchipPlanner(model) }).plan;

  /** id, title, the row field plotted, and the y-axis title with its unit. */
  const JOINT_CHARTS: readonly {
    id: ChartId;
    title: string;
    field: "q" | "qd" | "qdd" | "qddd";
    yTitle: string;
  }[] = [
    { id: "joint-positions", title: "Joint angles over time", field: "q", yTitle: "q, rad" },
    { id: "joint-velocities", title: "Joint velocities over time", field: "qd", yTitle: "qd, rad/s" },
    { id: "joint-accelerations", title: "Joint accelerations over time", field: "qdd", yTitle: "qdd, rad/s²" },
    { id: "joint-jerks", title: "Joint jerks over time", field: "qddd", yTitle: "qddd, rad/s³" },
  ];

  for (const spec of JOINT_CHARTS) {
    it(`renders ${spec.id}: ${spec.title}, axes in ms and ${spec.yTitle.split(", ")[1]}`, () => {
      const svg = chartById(renderCharts(plan, model), spec.id).svg;

      // The chart names itself, and its axes carry the plan's units.
      expect(texts(svg, "chart-title")).toEqual([spec.title]);
      expect(texts(svg, "axis-title-x")).toEqual(["t, ms"]);
      expect(texts(svg, "axis-title-y")).toEqual([spec.yTitle]);

      // One series per model joint, one plotted point per plan row.
      const drawn = series(svg);
      expect(drawn.map((s) => s.name)).toEqual(model.joints.map((j) => j.name));
      for (const s of drawn) {
        expect(s.points).toHaveLength(plan.rows.length);
        // Time runs left to right: the plotted x strictly increases.
        for (let i = 1; i < s.points.length; i++) {
          const pxPrev = s.points[i - 1]![0];
          const px = s.points[i]![0];
          expect(px).toBeGreaterThan(pxPrev);
        }
      }
      // The legend names the joints.
      expect(texts(svg, "legend-label")).toEqual(model.joints.map((j) => j.name));

      // The time axis spans the plan: 0 to the last row.
      const xTicks = texts(svg, "tick-x");
      expect(xTicks).toContain("0");
      expect(xTicks).toContain(fmt(plan.durationMs));
      // Every tick label is a finite number.
      for (const t of [...xTicks, ...texts(svg, "tick-y")]) {
        expect(Number.isFinite(Number(t))).toBe(true);
      }

      // The value axis spans the data: its extent endpoints are labeled.
      const values = plan.rows.flatMap((r) => [...r[spec.field]]);
      const [min, max] = extent(values);
      const yTicks = texts(svg, "tick-y");
      expect(yTicks).toContain(fmt(min));
      expect(yTicks).toContain(fmt(max));
    });
  }
});

describe("cartesian path chart", () => {
  const model = defaultModel();
  const plan = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createPchipPlanner(model) }).plan;

  it("reconstructs the pen path through FK, one point per row, in mm", () => {
    const svg = chartById(renderCharts(plan, model), "cartesian-path").svg;

    expect(texts(svg, "chart-title")).toEqual(["Reconstructed cartesian path (top view)"]);
    expect(texts(svg, "axis-title-x")).toEqual(["x, mm"]);
    expect(texts(svg, "axis-title-y")).toEqual(["y, mm"]);
    const drawn = series(svg);
    expect(drawn.map((s) => s.name)).toEqual(["path"]);
    expect(drawn[0]!.points).toHaveLength(plan.rows.length);
    // The plotted geometry stays inside the plot frame.
    for (const [px, py] of drawn[0]!.points) {
      expect(px).toBeGreaterThanOrEqual(64);
      expect(px).toBeLessThanOrEqual(616);
      expect(py).toBeGreaterThanOrEqual(48);
      expect(py).toBeLessThanOrEqual(354);
    }
  });

  it("draws the axes with equal scale: equal millimetres, equal pixels", () => {
    const svg = chartById(renderCharts(L_SHAPED_PLAN, identityModel()), "cartesian-path").svg;
    const points = series(svg)[0]!.points;
    // Two legs of 2 mm each: their drawn lengths must agree.
    const legX = drawnLength(points, 6);
    const legY = drawnLength(points.slice(5), 6);
    expect(Math.abs(legY - legX) / legX).toBeLessThan(0.01);
  });

  it("draws the golden square as a square, not a rectangle (ADR 0007)", () => {
    const square = runPipeline({ trajectory: SQUARE, model, planner: createPchipPlanner(model) });
    const points = series(chartById(renderCharts(square.plan, model), "cartesian-path").svg)[0]!.points;
    const px = points.map(([x]) => x);
    const py = points.map(([, y]) => y);
    const widthPx = Math.max(...px) - Math.min(...px);
    const heightPx = Math.max(...py) - Math.min(...py);
    // Reconstruction error is bounded by 0.5 mm on a 100 mm side (0.5%);
    // 1.5% leaves room for grid rounding without hiding distortion.
    expect(Math.abs(widthPx - heightPx) / Math.min(widthPx, heightPx)).toBeLessThan(0.015);
  });
});

describe("end-effector charts", () => {
  it("plots the pen speed over time in mm/s, matching the traverse rate", () => {
    const svg = chartById(renderCharts(X_AT_20_MM_S, identityModel()), "end-effector-velocity").svg;

    expect(texts(svg, "chart-title")).toEqual(["End-effector speed over time"]);
    expect(texts(svg, "axis-title-x")).toEqual(["t, ms"]);
    expect(texts(svg, "axis-title-y")).toEqual(["v, mm/s"]);
    const drawn = series(svg);
    expect(drawn.map((s) => s.name)).toEqual(["speed"]);
    expect(drawn[0]!.points).toHaveLength(X_AT_20_MM_S.rows.length);
    // Constant 20 mm/s motion: the value axis must expose that rate.
    expect(texts(svg, "tick-y")).toContain("20");
  });

  it("plots the pen acceleration over time in mm/s², spiking at velocity steps", () => {
    const svg = chartById(renderCharts(TWO_PHASE_PLAN, identityModel()), "end-effector-acceleration").svg;

    expect(texts(svg, "chart-title")).toEqual(["End-effector acceleration over time"]);
    expect(texts(svg, "axis-title-y")).toEqual(["a, mm/s²"]);
    expect(series(svg)[0]!.points).toHaveLength(TWO_PHASE_PLAN.rows.length);
    // The 20→10 mm/s step across one 20 ms row gap is |Δv|/Δt = 500 mm/s².
    const yTicks = texts(svg, "tick-y");
    expect(yTicks).toContain("0");
    expect(yTicks).toContain("500");
  });
});

describe("3D path view", () => {
  /** A plan tracing three 2 mm legs: +X, then +Y, then +Z (identity model). */
  const XYZ_PLAN: MotionPlan = {
    rows: [
      ...[0, 1, 2, 3, 4, 5].map((k) => row(k * CONTROL_STEP_MS, [0.02 * k * CONTROL_STEP_MS, 0, 0])),
      ...[6, 7, 8, 9, 10, 11].map((k) =>
        row(k * CONTROL_STEP_MS, [2, 0.02 * (k * CONTROL_STEP_MS - 120), 0]),
      ),
      ...[12, 13, 14, 15, 16, 17].map((k) =>
        row(k * CONTROL_STEP_MS, [2, 2, 0.02 * (k * CONTROL_STEP_MS - 240)]),
      ),
    ],
    ranges: oneRange(20, 0, 340),
    durationMs: 340,
  };

  it("projects the planned path isometrically with equal-aspect axes", () => {
    const model = identityModel();
    const svg = chartById(renderCharts(XYZ_PLAN, model), "path-3d").svg;

    expect(texts(svg, "chart-title")).toEqual(["Planned path in 3D (isometric)"]);
    const drawn = series(svg);
    expect(drawn.map((s) => s.name)).toEqual(["path-3d"]);
    expect(drawn[0]!.points).toHaveLength(XYZ_PLAN.rows.length);
    // Isometric projection with equal aspect: a 2 mm leg along each of
    // X, Y, Z draws with the same pixel length.
    const points = drawn[0]!.points;
    const legX = drawnLength(points, 6);
    // The Y and Z legs start one row after the previous leg's last row
    // (the plan holds the corner), so each slice spans 6 segments.
    const legY = drawnLength(points.slice(5), 7);
    const legZ = drawnLength(points.slice(11), 7);
    expect(Math.abs(legY - legX) / legX).toBeLessThan(0.01);
    expect(Math.abs(legZ - legX) / legX).toBeLessThan(0.01);
  });

  it("annotates the axes and states the units", () => {
    const model = defaultModel();
    const plan = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createPchipPlanner(model) }).plan;
    const svg = chartById(renderCharts(plan, model), "path-3d").svg;

    // The bounding wireframe grounds the motion in space.
    expect(svg).toMatch(/class="axes-box"/);
    // Each world axis is labeled at its box edge.
    const labels = texts(svg, "axis-label-3d");
    for (const axis of ["X", "Y", "Z"]) expect(labels).toContain(axis);
    // Units live in the caption: the projection mixes axes, so there
    // are no per-screen-axis tick labels to carry them.
    expect(texts(svg, "axis-caption").join(" ")).toContain("mm");
    expect(texts(svg, "axis-caption").join(" ")).toContain("equal-aspect");
  });

  it("keeps the bounding-box wireframe inside the plot frame", () => {
    const model = defaultModel();
    const plan = runPipeline({ trajectory: LINE_AND_ARC, model, planner: createPchipPlanner(model) }).plan;
    const svg = chartById(renderCharts(plan, model), "path-3d").svg;
    const d = svg.match(/<path class="axes-box" d="([^"]+)"/)![1] as string;
    const coords = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    expect(coords.length).toBeGreaterThan(0);
    for (let i = 0; i + 1 < coords.length; i += 2) {
      expect(coords[i] as number).toBeGreaterThanOrEqual(64); // MARGIN.left
      expect(coords[i] as number).toBeLessThanOrEqual(616); // MARGIN.left + PLOT_W
      expect(coords[i + 1] as number).toBeGreaterThanOrEqual(48); // MARGIN.top
      expect(coords[i + 1] as number).toBeLessThanOrEqual(354); // MARGIN.top + PLOT_H
    }
  });
});
