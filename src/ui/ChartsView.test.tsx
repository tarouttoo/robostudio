import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { CHART_IDS, type ChartId } from "../export";
import { line } from "../core/trajectory";
import { vec3 } from "../core/vec";
import type { EditorState } from "./editor";
import { initialEditorState } from "./editor";
import { createGenerationSession, type GenerationOutcome, type GenerationSession } from "./generation";
import { MIKO_MINI } from "./robot";
import { ChartsView, chartTitle } from "./ChartsView";

/** A reachable Home Point in the MiKo-mini workspace (as in generation.test.ts). */
const HOME = vec3(80, 0, 60);

/** Editor state holding exactly this drawing: Home Point plus Segments. */
function stateWith(segments: EditorState["segments"], home: EditorState["home"] = HOME): EditorState {
  return { ...initialEditorState, home, segments };
}

/** The session under test: the shipped MiKo-mini model bound once. */
const session: GenerationSession = createGenerationSession(MIKO_MINI);

/**
 * Runs generation, failing the test unless the pipeline succeeded; the
 * returned outcome carries the chart documents the view embeds.
 */
function okOutcome(segments: EditorState["segments"]): Extract<GenerationOutcome, { kind: "ok" }> {
  const outcome = session.run(stateWith(segments));
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome;
}

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
  it("shows every chart of the last generation under its Russian caption", () => {
    // The documents come straight off the generation outcome — rendered
    // at Generation time, the view plots nothing itself.
    const outcome = okOutcome([line({ start: HOME, end: vec3(100, 0, 60), feed: 20 })]);
    const html = renderToString(<ChartsView charts={outcome.charts} />);
    expect(html).toContain("Графики");
    for (const id of CHART_IDS) {
      expect(html).toContain(chartTitle(id));
    }
    // The very documents the outcome carries are embedded, one per
    // chart kind — the UI plots nothing itself.
    const svgCount = [...html.matchAll(/<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g)].length;
    expect(svgCount).toBe(CHART_IDS.length);
    expect(html).toContain('<polyline class="series"');
  });
});
