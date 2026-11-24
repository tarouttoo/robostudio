# MiKo-mini geometry from the prototype's measurements

The default Robot Model carries the numbers measured on the real
MiKo-mini prototype, replacing the placeholder dimensions the rewrite
started with:

- **Shoulder column:** 160 mm (was 60 mm).
- **Links:** two planar links of **159.8045 mm** each (was 90 + 90 mm).
- **Tool offset:** a **53 mm** horizontal offset at the tool centre point
  (TCP). Forward kinematics add it to the radial term
  (`r = L1·cos(q2) + L2·cos(q2+q3) + 53`); inverse kinematics subtract it
  from the radial term before the planar two-link solve, so both solve
  the same points on the shoulder-up branch.
- **Joint limits:** [−π, π] for all three joints (was asymmetric).
- **Dynamic limits:** velocity [1.2, 0.8, 0.9] rad/s, acceleration
  [2.8, 3.0, 2.5] rad/s², jerk [9.0, 8.0, 8.0] rad/s³.
- **Default Home Point:** [213, 0, 305] mm — the editor starts there,
  Clear restores it, and the Home Point tool re-places it by click.

## Measured constants are never rounded

159.8045 mm came from measurement. Rounding it (to 160, or to 3 decimal
places) changes the solved joint angles and therefore the exported CSV
bytes the real robot consumes. The constants are pinned in configuration
and in tests exactly as measured; any "cleanup" that rounds them is a
regression, not a refactor.

## Consequences

- The MiKo-shaped generic-chain cross-check pairs against the toolless
  analytic variant: a URDF-like chain carries rigid link offsets only and
  cannot express a radial (q1-following) tool offset in three joints.
- With symmetric [−π, π] limits, the shoulder-up analytic solver still
  returns the shoulder-up branch only; points whose shoulder-up fold
  exceeds +π are classified `angle-limit` even though a mirror pose fits.
  Reachability classification (live and in the pipeline) uses exactly
  this behaviour.
- The golden CSV fixtures (ADR 0006) were re-baselined in the same change
  that landed this geometry: the exported joint angles for the fixture
  Trajectory changed as a matter of course, and the diff was reviewed as
  the expected consequence of the geometry change.
