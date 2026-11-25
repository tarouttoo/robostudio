# Ticket #65 — ADR + GLOSSARY for the Preview Scene and two cameras

Docs-only ticket; requires #61–#64 implemented. `npm run typecheck` &&
`npm test` must still pass (they will — no code changes).

## ADR

- `docs/adr/` currently ends at `0022` — the next free number is **0023**,
  file `docs/adr/0023-preview-scene-two-cameras.md` (verify before
  writing; another ticket may have landed).
- Follow the house ADR style (title as a claim sentence, sections like
  the existing ones — see `0018-motion-preview-gif-exporter.md` for the
  closest template: context, decisions, consequences).

Must record explicitly:

1. **The Preview Scene seam** — one headless millimetre-space scene
   document (`buildPreviewScene`, `src/export/preview-scene.ts`)
   assembled at Generation time by pure functions from Trajectory +
   Motion Plan + Robot Model, carried on the Generation outcome
   (`PipelineResult.previewScene` → `GenerationOutcome.ok.previewScene`),
   consumed by both renderers. **Supersedes ADR 0018's pixel-frame
   seam** (the outcome used to carry projected pixel frames).
2. **The two-camera split** — the GIF renders the scene through the
   fixed charts' isometric camera (ADR 0013, `projectIsometric`); the
   dialog renders the same scene through the interactive hand-rolled
   Orbit Camera (`src/ui/orbit-camera.ts`). New contract: «the dialog and
   the GIF render the same Preview Scene through two cameras» —
   **supersedes ADR 0018's exact-pixels dialog contract**. The Orbit
   Camera's default view equals the isometric convention, so «Вписать»
   restores the GIF's view.
3. **The raster relaxation** — ADR 0018's "pure integer pixel math"
   statement relaxes to deterministic float math (AA stroking) with
   pinned golden bytes; ADR 0006's golden re-pin discipline stands (the
   #62 re-pin was one such deliberate change).
4. **What remains true from ADR 0018** (state it, don't silently
   contradict): the self-contained pure GIF 89a encoder (`src/export/
   gif.ts`), pacing (one even delay over the real duration, 20 ms
   floor), the 300-frame budget, the `RobotModel.chainPoints` skeleton
   seam, no text in the frames (ADR 0013's font argument), the export
   layer's DOM/canvas/three.js ban (ADR 0012/0013).
5. **Cross-references**: ADR 0004 (dependency stance — hand-rolled Orbit
   Camera, no three.js), ADR 0007 (camera discipline, equal-aspect fit),
   ADR 0012/0013 (headless export layer), ADR 0016/0017 (PTP arrival-
   only semantics — why PTP geometry is dashed and the TCP trace exists),
   ADR 0018 (superseded parts + what stands).

## GLOSSARY.md (repo root)

- Add exactly two term pairs (English + Russian, no synonyms):
  - **Preview Scene (Сцена предпросмотра)** — the headless millimetre
    scene document assembled at Generation time; both the Motion Preview
    GIF and the playback dialog render it.
  - **Orbit Camera (Орбитальная камера)** — the hand-rolled interactive
    camera of the playback dialog: drag rotates (yaw/pitch), the wheel
    zooms, «Вписать»/double-click resets to the default isometric fit.
- Update **Motion Preview (Предпросмотр движения)**: the GIF renders the
  Preview Scene through the fixed isometric camera at 800×600 with
  panes/grid, time-gradient Trajectory, anti-aliased strokes; the
  playback dialog renders the same scene through the Orbit Camera
  (instead of painting the GIF's pixels); ADR pointer becomes 0023
  alongside 0018 (for what still stands).
- Do not let other entries drift; keep the existing formatting
  (bold term, em dash, ADR cross-refs, alphabetical/section placement as
  the file has it — Motion Preview sits in the domain section).

## Acceptance checks

- The ADR names what it supersedes and what it keeps; no silent
  contradiction of any other ADR (domain-doc conflict rule — see
  `docs/agents/domain.md`).
- GLOSSARY gains exactly the two new pairs; other entries untouched
  (diff review: only the Motion Preview entry plus two insertions).
- `npm run typecheck` && `npm test` pass (nothing else changes).
