import { describe, expect, it } from "vitest";

import { arcFromCenter } from "../core/arc";
import { line, trajectory, type Trajectory } from "../core/trajectory";
import { vec3 } from "../core/vec";
import { DEFAULT_MIKO_MINI_CONFIG } from "../kinematics/miko-mini";
import { createRobotRegistry } from "../kinematics/registry";
import type { RobotModel } from "../kinematics/robot-model";
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

/** A one-row plan: the degenerate case every chart must survive. */
const ONE_ROW_PLAN: MotionPlan = {
  rows: [row(0, [0.1, 0.2, 0.3])],
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

  it("never emits NaN, Infinity, or undefined, even for a one-row plan", () => {
    const plans = [plan, X_AT_20_MM_S, ONE_ROW_PLAN];
    for (const p of plans) {
      for (const chart of renderCharts(p, model)) {
        expect(chart.svg).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });

  it("is a pure function of the plan and model", () => {
    expect(renderCharts(plan, model)).toEqual(renderCharts(plan, model));
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
