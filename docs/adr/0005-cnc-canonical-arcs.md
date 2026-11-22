# CNC-canonical arcs

Arcs are stored and drawn in CNC-canonical form: Working Plane + start +
end + direction (CW/CCW) + radius **R** or explicit center. There is no
"arc through three points" tool. The prototype used three-point arcs; the
operator community this app targets works to CNC standards where arcs are
G02/G03 with R or center offsets, and the Pilz industrial planner's CIRC
command supports the same two definitions — so canonical storage matches
how both the standards and the planners speak.

The canonical form is also the contract for future G-code import/export:
the drawing tools compile into it and the exporters read from it, so
adding file-based CNC exchange later touches no math.

## Considered options

- **Keep only the three-point arc** (prototype behavior) — rejected:
  non-standard, requires resolving a circle from clicks (error-prone), and
  diverges from the vocabulary the operators already have.
- **Three-point as an auxiliary tool compiling to canonical** — rejected
  for v1: two tools teaching two mental models; revisit only if operators
  ask.

## Consequences

- The drawing UX needs an explicit direction (CW/CCW) and either a radius
  or a center click per arc; validation can reject impossible arcs
  (start/end too far for R) immediately at draw time.
- All arc geometry (center from R, validity, discretization) is derived in
  one place from the canonical form.
