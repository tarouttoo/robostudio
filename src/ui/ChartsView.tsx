/**
 * The charts view (Spec #1 user stories 18–20): after a successful
 * generation every chart the headless renderer produced (ADR 0013) is
 * shown to the operator — joint angles, velocities, accelerations, and
 * jerks over time, the reconstructed cartesian path, end-effector
 * velocity and acceleration, and the 3D path view.
 *
 * This module plots nothing of its own: the chart documents arrive as
 * data on the generation outcome — rendered at Generation time by the
 * one headless seam (`renderCharts`, ADR 0013) — and the `ChartsView`
 * component embeds those exact SVG documents under Russian captions —
 * the UI translates titles, not data, per GLOSSARY.md. Regeneration
 * produces a new outcome carrying its own charts, so the shown
 * documents (and only they) are replaced with the new plan's data.
 */

import type { JSX } from "react";

import { type ChartId, type RenderedChart } from "../export";

/**
 * The Russian UI caption of one chart kind, per GLOSSARY.md (Chart,
 * График): the translation of the renderer's English title — never a
 * synonym. The SVG document itself keeps the renderer's own title
 * text; the caption is the operator-facing label.
 */
export function chartTitle(id: ChartId): string {
  switch (id) {
    case "joint-positions":
      return "Углы шарниров по времени";
    case "joint-velocities":
      return "Скорости шарниров по времени";
    case "joint-accelerations":
      return "Ускорения шарниров по времени";
    case "joint-jerks":
      return "Рывки шарниров по времени";
    case "cartesian-path":
      return "Восстановленный декартов путь (вид сверху)";
    case "end-effector-velocity":
      return "Скорость рабочего органа по времени";
    case "end-effector-acceleration":
      return "Ускорение рабочего органа по времени";
    case "path-3d":
      return "Запланированный путь в 3D (изометрия)";
  }
}

/** Props of the charts view: the outcome's documents to show, in run order. */
export interface ChartsViewProps {
  /** One rendered chart per chart kind, off the generation outcome. */
  readonly charts: readonly RenderedChart[];
}

/**
 * The charts panel: one captioned figure per chart kind, the headless
 * renderer's SVG documents embedded as-is (they are standalone,
 * trusted output of our own pure renderer). The panel scrolls; charts
 * wrap to fill the width at their natural document size.
 */
export function ChartsView(props: ChartsViewProps): JSX.Element {
  return (
    <section
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding: "0.5rem 1rem",
        gap: "0.25rem",
      }}
    >
      <h2 style={{ fontSize: "1rem", margin: 0 }}>Графики</h2>
      <div style={{ overflowY: "auto", display: "flex", flexWrap: "wrap", gap: "1rem", alignContent: "flex-start" }}>
        {props.charts.map((chart) => (
          <figure key={chart.id} style={{ margin: 0, display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <figcaption style={{ fontSize: "0.9rem", color: "#333" }}>{chartTitle(chart.id)}</figcaption>
            <div style={{ border: "1px solid #ddd", background: "#fff" }} dangerouslySetInnerHTML={{ __html: chart.svg }} />
          </figure>
        ))}
      </div>
    </section>
  );
}
