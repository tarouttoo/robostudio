# Charts render headless as SVG in the export layer

The spec's plots — joint angles, velocities, accelerations, and jerks
over time; the reconstructed cartesian path; end-effector velocity and
acceleration; the 3D path view — are rendered by one pure function in
the export layer: `renderCharts(plan, model)` → one standalone SVG
document per chart kind, addressed by stable chart ids (`CHART_IDS`),
in the plan's internal units (ms, rad, mm, mm/s). It lives in `export`
for the same reason the pipeline does (ADR 0012): it is another
named-output producer whose inputs are the Motion Plan and the Robot
Model, and the UI reaches it as an ordinary `export` import. No new
layer, no new dependency.

## SVG, not PNG

The ticket says "SVG/PNG"; only SVG ships. Charts need text (axis
titles, ticks, legends), and rasterizing text without a font stack
means either a native dependency (against the double-click install on
Windows/Arch and the dependency-free math core's spirit) or a
hand-rolled software rasterizer with bitmap fonts — more code than the
charts themselves, for a worse result. SVG is text, so it is
byte-verifiable in CI exactly like the CSV exporters (the test-pinned
output contract: document shell, series elements, tick and extent
labeling); it renders crisply at any zoom; and the Electron UI
displays it directly, so the later charts-view ticket shows the very
documents CI verified, with no duplicate plotting logic. If a PNG
export is ever genuinely needed, it becomes a rasterization step over
these SVG documents, not a second renderer.

## Equal aspect is not optional on path charts

The prototype's founding bug was anisotropic scaling (ADR 0007): a
drawn square came out a rectangle. A chart whose axes autoscale
independently reproduces exactly that bug in chart form, so the
cartesian path chart and the 3D path view draw both axes at one
uniform mm→px scale (the limiting axis fills the plot area; the other
is centered), and the 3D view uses an isometric projection whose three
unit axes project to the same length. Tests pin this behaviorally:
equal-millimetre legs draw to equal pixel lengths, and the golden
square's drawn bounding box stays square through the real pipeline.

## Consequences

- `src/export/index.ts` exports the seam; chart ids are stable
  identifiers the UI keys on (like `PipelineStage`).
- The SVG output structure is a pinned contract (the discipline of
  ADR 0006's bytes): the document shell, `<polyline class="series"
  data-series="…">` per series, and tick labeling — time axes label 0
  and the plan duration, value axes label their data extent endpoints.
  Changing the structure is a deliberate test update.
- Chart titles are English; the UI layer translates per GLOSSARY.md.
- Chart data is not unit-converted at render time: the axes carry the
  plan's internal units (ms, rad, mm, mm/s), and the mm/min UI
  conversion stays where it already is.
