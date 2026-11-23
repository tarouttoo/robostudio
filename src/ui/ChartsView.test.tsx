import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { CHART_IDS, type ChartId } from "../export";
import { line } from "../core/trajectory";
import { vec3 } from "../core/vec";
import type { EditorState } from "./editor";
import { initialEditorState } from "./editor";
import { createGenerationSession, type GenerationOutcome, type GenerationSession } from "./generation";
import { MIKO_MINI } from "./robot";
import { ChartsView, chartsOf, chartTitle } from "./ChartsView";

/** A reachable Home Point in the MiKo-mini workspace (as in generation.test.ts). */
const HOME = vec3(80, 0, 60);

/** Editor state holding exactly this drawing: Home Point plus Segments. */
function stateWith(segments: EditorState["segments"], home: EditorState["home"] = HOME): EditorState {
  return { ...initialEditorState, home, segments };
}

/** The session under test: the shipped MiKo-mini model bound once. */
const session: GenerationSession = createGenerationSession(MIKO_MINI);

/** Runs generation, failing the test unless the pipeline succeeded. */
function okOutcome(segments: EditorState["segments"]): Extract<GenerationOutcome, { kind: "ok" }> {
  const outcome = session.run(stateWith(segments));
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome;
}

/** The tick labels of one axis class, parsed from a chart SVG document. */
function tickTexts(svg: string, className: string): readonly string[] {
  return [...svg.matchAll(new RegExp(`<text class="${className}"[^>]*>([^<]*)</text>`, "g"))].map(
    (m) => m[1] as string,
  );
}

describe("charts view: charts of a generation outcome", () => {
  it("renders every chart kind through the headless seam, in run order", () => {
    const charts = chartsOf(okOutcome([line({ start: HOME, end: vec3(100, 0, 60), feed: 20 })]), MIKO_MINI);
    if (charts === null) throw new Error("expected charts for a successful generation");
    expect(charts.map((c) => c.id)).toEqual([...CHART_IDS]);
    for (const chart of charts) {
      expect(chart.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(chart.svg.endsWith("</svg>")).toBe(true);
    }
  });

  it("shows no charts until a generation succeeds", () => {
    expect(chartsOf(null, MIKO_MINI)).toBeNull();
    const failed = session.run(stateWith([line({ start: HOME, end: vec3(300, 0, 60), feed: 20 })]));
    expect(chartsOf(failed, MIKO_MINI)).toBeNull();
    const blocked = session.run({ ...initialEditorState, segments: [line({ start: HOME, end: vec3(100, 0, 60), feed: 20 })] });
    expect(chartsOf(blocked, MIKO_MINI)).toBeNull();
  });

  it("regeneration replaces the charts with the new plan's data", () => {
    const short = chartsOf(okOutcome([line({ start: HOME, end: vec3(100, 0, 60), feed: 20 })]), MIKO_MINI);
    const long = chartsOf(okOutcome([line({ start: HOME, end: vec3(180, 0, 60), feed: 20 })]), MIKO_MINI);
    if (short === null || long === null) throw new Error("expected charts for both generations");
    // Every chart redraws: no document survives the regeneration as-is.
    expect(long.map((c) => c.svg)).not.toEqual(short.map((c) => c.svg));
    // The new data is the new plan's: the time axis labels the longer
    // plan's duration, not the first run's.
    const durationMs = Math.max(...okOutcome([line({ start: HOME, end: vec3(180, 0, 60), feed: 20 })]).result.plan.rows.map((r) => r.tMs));
    const positions = long.find((c) => c.id === "joint-positions");
    if (!positions) throw new Error("expected a joint-positions chart");
    expect(tickTexts(positions.svg, "tick-x")).toContain(String(durationMs));
  });
});

describe("charts view: Russian captions per GLOSSARY", () => {
  it("translates every chart kind title, no synonyms", () => {
    const titles: Record<ChartId, string> = {
      "joint-positions": "Углы шарниров по времени",
      "joint-velocities": "Скорости шарниров по времени",
      "joint-accelerations": "Ускорения шарниров по времени",
      "joint-jerks": "Рывки шарниров по времени",
      "cartesian-path": "Восстановленный декартов путь (вид сверху)",
      "end-effector-velocity": "Скорость рабочего органа по времени",
      "end-effector-acceleration": "Ускорение рабочего органа по времени",
      "path-3d": "Запланированный путь в 3D (изометрия)",
    };
    for (const id of CHART_IDS) {
      expect(chartTitle(id)).toBe(titles[id]);
    }
  });
});

describe("charts view: component", () => {
  it("shows every chart document under its Russian caption", () => {
    const charts = chartsOf(okOutcome([line({ start: HOME, end: vec3(100, 0, 60), feed: 20 })]), MIKO_MINI);
    if (charts === null) throw new Error("expected charts for a successful generation");
    const html = renderToString(<ChartsView charts={charts} />);
    expect(html).toContain("Графики");
    for (const id of CHART_IDS) {
      expect(html).toContain(chartTitle(id));
    }
    // The very documents the headless renderer produced are embedded,
    // one per chart kind — the UI plots nothing itself.
    const svgCount = [...html.matchAll(/<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g)].length;
    expect(svgCount).toBe(CHART_IDS.length);
    expect(html).toContain('<polyline class="series"');
  });
});
