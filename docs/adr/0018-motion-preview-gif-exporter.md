# The Motion Preview GIF is rendered and encoded headless, without dependencies

The Motion Preview (the animated isometric preview of a generated
Motion Plan) ships as a GIF file: `renderMotionPreviewGif` samples at
most 300 rows of the plan, projects each sampled moment isometrically,
and encodes the frames as `robot_motion.gif` that rides on the
pipeline result next to the Robot CSV and RViz CSV. This ADR records
the three non-obvious choices behind it.

## A raster format, despite ADR 0013's SVG stance

ADR 0013 chose SVG over PNG for the charts because charts need text
and rasterizing text without a font stack is a bad trade. The Motion
Preview is a different artifact: an *animation* of a robot moving. No
text is drawn (the frames are geometry only — skeleton, trajectory,
markers), so the font argument does not apply, and the deliverable is
a file an operator can open, share, and embed in a report or chat: an
animated GIF is the only widely-playable animated image format that a
dependency-free encoder can produce (APNG and animated WebP encoders
are heavier, and the ticket pins GIF anyway). The frames still come
from deterministic pure functions pinned by golden geometry tests —
the ADR 0013 discipline holds; only the last step, raster + bytes,
differs, and for the same reason the CSV bytes are pinned: the output
is byte-verifiable in CI.

## The GIF encoder is ours, not an npm package

The repo's dependency stance (ADR 0004's spirit: the math core has
zero runtime dependencies; every shipped byte is test-pinned) extends
to the exporter: `gif.ts` is a self-contained GIF 89a encoder — one
global 256-entry color table, NETSCAPE2.0 infinite loop, per-frame
graphic control extensions, GIF-variant LZW (LSB-first code packing,
9→12-bit growth, dictionary clear at 4096 entries, hashed
open-addressing dictionary). GIF is a small, stable, fully specified
format; the encoder is ~200 lines whose correctness is pinned by
round-trip tests decoding the produced bytes with an independent
test-side decoder (structure, delays, and exact pixel indices under
dictionary pressure). Adding `gifenc`-style dependency for that would
buy nothing the tests don't already pin.

## The skeleton seam: `RobotModel.chainPoints`

Drawing "the robot" per frame needs the chain's pivot positions, not
just the TCP that `forwardKinematics` returns. Rather than a
MiKo-mini-specific hack in the export layer, the `RobotModel` seam
(ADR 0008) grows one method: `chainPoints(angles)` → the fixed base
point, one point per joint pivot in actuation order, and the end-
effector (equal to FK's result) — `joints.length + 2` points. This is
kinematic-chain description, exactly what the GLOSSARY says a Robot
Model carries; MiKo-mini implements it from the measured chain (ADR
0015), the generic chain walks its forward transform, and a future
robot is one more implementation, not renderer surgery.

## Pacing and determinism

Frames sample the plan's rows (one per row, capped at 300 by even row
spacing), and each frame carries one even delay — the plan's real
duration divided across the frames at the GIF's 1/100 s granularity,
floored at 20 ms (where players clamp anyway). Everything is pure
integer pixel math over a fixed 256-color palette: identical pipeline
input yields byte-identical GIF output, and the golden tests pin a
frozen scene's projected pixels (hand-verified against the projection
and fit formulas) alongside the existing invariant tests.

## Consequences

- `src/export/gif.ts` exports `encodeGif`; `src/export/motion-preview.ts`
  exports the renderer seam (`renderMotionPreviewFrames`,
  `renderMotionPreviewGif`, the frame budget, and the palette/color
  contract). The pipeline result carries `motionGif` bytes; the app
  writes them as `robot_motion.gif` next to the CSVs under the same
  staging discipline.
- Changing the projection, the fit, the palette, or the draw order is
  a deliberate golden-test update, like any byte-format change (ADR
  0006).
- The export layer imports only `core`, `kinematics`, and `motion` —
  no canvas/DOM/three.js anywhere in the export path; the layer test
  is the guard.
