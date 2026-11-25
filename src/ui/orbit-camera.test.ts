import { describe, expect, it } from "vitest";

import { vec3, type Vec3 } from "../core";
import { projectIsometric } from "../export/charts";
import {
  DEFAULT_PITCH_RAD,
  DEFAULT_YAW_RAD,
  MAX_DISTANCE_MM,
  MAX_PITCH_RAD,
  MIN_DISTANCE_MM,
  ROTATE_RADIANS_PER_PIXEL,
  ZOOM_FACTOR_PER_NOTCH,
  ZOOM_NOTCH_DELTA_Y,
  defaultOrbitCamera,
  depthOrbit,
  orbitCamera,
  projectOrbit,
  resetOrbitCamera,
  zoomCamera,
  type MmBounds,
  type OrbitCamera,
  type Viewport,
} from "./orbit-camera";

const VIEWPORT: Viewport = { widthPx: 800, heightPx: 600 };

/** A crafted scene: 100×80 mm footprint, 80 mm tall, centred at (0, 0, 40). */
const BOUNDS: MmBounds = { minX: -50, maxX: 50, minY: -40, maxY: 40, minZ: 0, maxZ: 80 };
const BOUNDS_CENTER = vec3(0, 0, 40);

/** The charts' `projectIsometric` speaks the kinematics tuple dialect; the camera speaks core's object one. */
function asTuple(p: Vec3): readonly [number, number, number] {
  return [p.x, p.y, p.z];
}

/** The eight corners of a box, in a stable order. */
function cornersOf(bounds: MmBounds): readonly Vec3[] {
  const list: Vec3[] = [];
  for (let bits = 0; bits < 8; bits++) {
    list.push(vec3(
      bits & 1 ? bounds.maxX : bounds.minX,
      bits & 2 ? bounds.maxY : bounds.minY,
      bits & 4 ? bounds.maxZ : bounds.minZ,
    ));
  }
  return list;
}

/** The pixel-space extents of the box's projection. */
function projectedExtents(camera: OrbitCamera, bounds: MmBounds): { minX: number; maxX: number; minY: number; maxY: number } {
  const pixels = cornersOf(bounds).map((p) => projectOrbit(camera, p));
  return {
    minX: Math.min(...pixels.map(([x]) => x)),
    maxX: Math.max(...pixels.map(([x]) => x)),
    minY: Math.min(...pixels.map(([, y]) => y)),
    maxY: Math.max(...pixels.map(([, y]) => y)),
  };
}

/** Every number in the record is finite — no NaN/Infinity anywhere. */
function expectFiniteCamera(camera: OrbitCamera): void {
  for (const value of [
    camera.yaw,
    camera.pitch,
    camera.distanceMm,
    camera.scalePxPerMm,
    camera.target.x,
    camera.target.y,
    camera.target.z,
    camera.viewport.widthPx,
    camera.viewport.heightPx,
  ]) {
    expect(Number.isFinite(value)).toBe(true);
  }
}

describe("defaultOrbitCamera (the reset view = the GIF's fixed isometric camera)", () => {
  it("fits the bounds inside the viewport at one uniform scale: the limiting axis fills, the other centers", () => {
    const camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    const e = projectedExtents(camera, BOUNDS);
    // Equal aspect (ADR 0007): one scale for both axes, so the limiting
    // dimension fills the viewport exactly and the other fits inside.
    const fillX = e.maxX - e.minX;
    const fillY = e.maxY - e.minY;
    expect(Math.min(fillX, fillY)).toBeGreaterThan(0);
    expect(fillX).toBeLessThanOrEqual(VIEWPORT.widthPx + 1e-6);
    expect(fillY).toBeLessThanOrEqual(VIEWPORT.heightPx + 1e-6);
    expect(Math.abs(fillY - VIEWPORT.heightPx)).toBeLessThan(1e-6); // height is limiting here
    // The non-limiting axis is centered, not stretched.
    expect((e.minX + e.maxX) / 2).toBeCloseTo(VIEWPORT.widthPx / 2, 6);
    expect((e.minY + e.maxY) / 2).toBeCloseTo(VIEWPORT.heightPx / 2, 6);
    // Every corner is on screen.
    for (const [x, y] of cornersOf(BOUNDS).map((p) => projectOrbit(camera, p))) {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(VIEWPORT.widthPx + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(VIEWPORT.heightPx + 1e-6);
    }
  });

  it("lands the bounds center at the viewport center", () => {
    const camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    const [cx, cy] = projectOrbit(camera, BOUNDS_CENTER);
    expect(cx).toBeCloseTo(VIEWPORT.widthPx / 2, 9);
    expect(cy).toBeCloseTo(VIEWPORT.heightPx / 2, 9);
  });

  it("projects with one mm→px scale on every axis: equal mm legs draw equal px", () => {
    // ADR 0007's anti-distortion discipline in 3D: the projection is one
    // number times an isometric-length-preserving basis, so equal world
    // legs stay equal on screen (a cube draws as a cube).
    const camera = defaultOrbitCamera({ minX: -50, maxX: 50, minY: -50, maxY: 50, minZ: -50, maxZ: 50 }, VIEWPORT);
    const origin = projectOrbit(camera, vec3(0, 0, 0));
    const legPx = (p: Vec3): number => {
      const [x, y] = projectOrbit(camera, p);
      return Math.hypot(x - origin[0], y - origin[1]);
    };
    const [legX, legY, legZ] = [legPx(vec3(10, 0, 0)), legPx(vec3(0, 10, 0)), legPx(vec3(0, 0, 10))] as const;
    expect(legX).toBeCloseTo(legY, 9);
    expect(legY).toBeCloseTo(legZ, 9);
  });

  it("reproduces the charts' isometric convention: the projection is projectIsometric up to one positive scale", () => {
    // The default view must be the GIF's fixed camera (ADR 0013): X/Y
    // recede along the ±30° ground axes, Z vertical — the convention
    // projectIsometric pins. Orthographic along the classic isometric
    // direction (1, 1, −1)/√3 scales that projection by √(2/3), so the
    // pixel offsets must be proportional to it.
    const camera = defaultOrbitCamera({ minX: -50, maxX: 50, minY: -50, maxY: 50, minZ: -50, maxZ: 50 }, VIEWPORT);
    expect(camera.yaw).toBe(DEFAULT_YAW_RAD);
    expect(camera.pitch).toBe(DEFAULT_PITCH_RAD);
    const s = camera.scalePxPerMm / Math.sqrt(1.5);
    const center = projectOrbit(camera, vec3(0, 0, 0));
    const points = [
      vec3(1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, 0, 1),
      vec3(30, -20, 15),
      vec3(-45, 10, -5),
      vec3(12.5, 33.5, -7.25),
    ];
    for (const p of points) {
      const [x, y] = projectOrbit(camera, p);
      const [right, up] = projectIsometric(asTuple(p));
      expect(x - center[0]).toBeCloseTo(s * right, 6);
      expect(center[1] - y).toBeCloseTo(s * up, 6);
    }
    // The ground axes recede at exactly ±30° from the horizontal.
    const xAxis = projectOrbit(camera, vec3(1, 0, 0));
    expect(Math.atan2(center[1] - xAxis[1], xAxis[0] - center[0])).toBeCloseTo(Math.PI / 6, 9);
    const yAxis = projectOrbit(camera, vec3(0, 1, 0));
    expect(Math.atan2(center[1] - yAxis[1], yAxis[0] - center[0])).toBeCloseTo(Math.PI - Math.PI / 6, 9);
  });

  it("pads degenerate bounds: a single-point scene stays finite and centred", () => {
    const camera = defaultOrbitCamera({ minX: 213, maxX: 213, minY: -10, maxY: -10, minZ: 25, maxZ: 25 }, VIEWPORT);
    expectFiniteCamera(camera);
    const [cx, cy] = projectOrbit(camera, vec3(213, -10, 25));
    expect(cx).toBeCloseTo(VIEWPORT.widthPx / 2, 9);
    expect(cy).toBeCloseTo(VIEWPORT.heightPx / 2, 9);
    expect(camera.scalePxPerMm).toBeGreaterThan(0);
  });

  it("clamps the default dolly distance into the bounded range for extreme scenes", () => {
    // Far larger than the viewport's interest: the distance clamps, the
    // fit scale stays finite.
    const huge = defaultOrbitCamera({ minX: -1e6, maxX: 1e6, minY: -1e6, maxY: 1e6, minZ: 0, maxZ: 1e6 }, VIEWPORT);
    expectFiniteCamera(huge);
    expect(huge.distanceMm).toBe(MAX_DISTANCE_MM);
    // Far smaller than the minimum dolly: the distance still clamps.
    const tiny = defaultOrbitCamera({ minX: 0.01, maxX: 0.02, minY: 0.01, maxY: 0.02, minZ: 0.01, maxZ: 0.02 }, VIEWPORT);
    expect(tiny.distanceMm).toBe(MIN_DISTANCE_MM);
    expectFiniteCamera(tiny);
  });
});

describe("orbitCamera (pointer drag → yaw/pitch)", () => {
  it("turns yaw monotonically with a horizontal drag, unbounded", () => {
    const camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    // Grab feel: dragging right turns the scene so its front follows the
    // cursor — the yaw of the view direction decreases.
    let current = camera;
    let previousYaw = camera.yaw;
    for (let i = 0; i < 20; i++) {
      current = orbitCamera(current, 25, 0);
      expect(current.yaw).toBeLessThan(previousYaw);
      expect(current.pitch).toBe(camera.pitch);
      previousYaw = current.yaw;
    }
    // The documented drag rate: ROTATE_RADIANS_PER_PIXEL per CSS pixel.
    expect(orbitCamera(camera, 100, 0).yaw).toBeCloseTo(camera.yaw - 100 * ROTATE_RADIANS_PER_PIXEL, 12);
    // And the other way: dragging left increases it.
    let back = orbitCamera(current, -25, 0);
    expect(back.yaw).toBeGreaterThan(current.yaw);
    // Yaw never wraps or clamps — full free spin around Z.
    const spun = orbitCamera(camera, -100000, 0);
    expect(Number.isFinite(spun.yaw)).toBe(true);
    expect(spun.yaw).toBeGreaterThan(camera.yaw + 100);
  });

  it("tilts pitch with a vertical drag and clamps before the poles", () => {
    const camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    // Grab feel: dragging down raises the camera — the scene tips its top
    // toward the operator. Monotonic until the clamp.
    let current = camera;
    let previousPitch = camera.pitch;
    while (current.pitch < MAX_PITCH_RAD) {
      current = orbitCamera(current, 0, 25);
      expect(current.pitch).toBeGreaterThan(previousPitch);
      previousPitch = current.pitch;
    }
    expect(current.pitch).toBe(MAX_PITCH_RAD);
    // The clamp holds: more of the same drag stops changing the camera.
    const clampedHigh = orbitCamera(current, 0, 10000);
    expect(clampedHigh).toEqual(current);
    // Dragging back the other way un-clamps normally.
    expect(orbitCamera(clampedHigh, 0, -25).pitch).toBeLessThan(MAX_PITCH_RAD);
    // And at the lower pole.
    let low = camera;
    for (let i = 0; i < 40; i++) low = orbitCamera(low, 0, -25);
    expect(low.pitch).toBe(-MAX_PITCH_RAD);
    const clampedLow = orbitCamera(low, 0, -10000);
    expect(clampedLow).toEqual(low);
  });

  it("never mutates the given camera record", () => {
    const camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    const snapshot = { ...camera, target: { ...camera.target }, viewport: { ...camera.viewport } };
    orbitCamera(camera, 40, -30);
    zoomCamera(camera, -120);
    resetOrbitCamera(camera, BOUNDS);
    expect(camera).toEqual(snapshot);
  });

  it("keeps a point's depth order stable for fixed angles across zoom and scale", () => {
    // Painter's-algorithm discipline (ADR 0007's invariants in CI): with
    // yaw/pitch fixed, the depth sort must not depend on the camera's
    // dolly distance or scale.
    const camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    const orbited = orbitCamera(camera, 130, -40);
    const near = vec3(BOUNDS_CENTER.x - 10, BOUNDS_CENTER.y - 10, BOUNDS_CENTER.z + 10); // toward the camera octant
    const far = vec3(BOUNDS_CENTER.x + 10, BOUNDS_CENTER.y + 10, BOUNDS_CENTER.z - 10);
    expect(depthOrbit(orbited, near)).toBeLessThan(depthOrbit(orbited, far));
    const difference = depthOrbit(orbited, far) - depthOrbit(orbited, near);
    for (const zoomed of [zoomCamera(orbited, -350), zoomCamera(orbited, 350)]) {
      expect(depthOrbit(zoomed, near)).toBeLessThan(depthOrbit(zoomed, far));
      expect(depthOrbit(zoomed, far) - depthOrbit(zoomed, near)).toBeCloseTo(difference, 9);
    }
  });
});

describe("zoomCamera (wheel → dolly)", () => {
  it("dollies in on wheel-up and out on wheel-down, monotonically", () => {
    const camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    // Wheel up (negative deltaY) moves the camera toward the target and
    // magnifies the orthographic view by the same ratio.
    let current = camera;
    let previousDistance = camera.distanceMm;
    for (let i = 0; i < 10; i++) {
      current = zoomCamera(current, -100);
      expect(current.distanceMm).toBeLessThan(previousDistance);
      expect(current.distanceMm).toBeGreaterThanOrEqual(MIN_DISTANCE_MM);
      expect(current.scalePxPerMm).toBeGreaterThan(camera.scalePxPerMm);
      previousDistance = current.distanceMm;
    }
    // One notch scales the dolly by exactly the documented factor.
    expect(zoomCamera(camera, ZOOM_NOTCH_DELTA_Y).distanceMm)
      .toBeCloseTo(camera.distanceMm * ZOOM_FACTOR_PER_NOTCH, 12);
    // Wheel down dollies back out.
    let out = zoomCamera(current, 100);
    expect(out.distanceMm).toBeGreaterThan(current.distanceMm);
    expect(out.distanceMm).toBeLessThanOrEqual(MAX_DISTANCE_MM);
  });

  it("keeps the dolly↔scale product: dollying in magnifies exactly by the distance ratio", () => {
    const camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    const product = camera.scalePxPerMm * camera.distanceMm;
    const zoomed = zoomCamera(zoomCamera(camera, -240), 60);
    expect(zoomed.scalePxPerMm * zoomed.distanceMm).toBeCloseTo(product, 6);
    expect(zoomed.scalePxPerMm / camera.scalePxPerMm).toBeCloseTo(camera.distanceMm / zoomed.distanceMm, 9);
  });

  it("clamps the dolly at both ends: repeated wheels stop changing the camera", () => {
    const camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    let inmost = camera;
    for (let i = 0; i < 60; i++) inmost = zoomCamera(inmost, -100);
    expect(inmost.distanceMm).toBe(MIN_DISTANCE_MM);
    expect(zoomCamera(inmost, -100)).toEqual(inmost);
    let outmost = camera;
    for (let i = 0; i < 80; i++) outmost = zoomCamera(outmost, 100);
    expect(outmost.distanceMm).toBe(MAX_DISTANCE_MM);
    expect(zoomCamera(outmost, 100)).toEqual(outmost);
    // And zooming back out of the clamp resumes normally.
    expect(zoomCamera(inmost, 100).distanceMm).toBeGreaterThan(MIN_DISTANCE_MM);
  });
});

describe("resetOrbitCamera («Вписать» / double-click)", () => {
  it("restores the default isometric fit exactly, equal to a fresh default camera", () => {
    const fresh = defaultOrbitCamera(BOUNDS, VIEWPORT);
    const explored = zoomCamera(orbitCamera(zoomCamera(orbitCamera(fresh, 95, -60), -180), -300, 20), 420);
    expect(explored).not.toEqual(fresh);
    expect(resetOrbitCamera(explored, BOUNDS)).toEqual(fresh);
  });

  it("resets into the camera's own viewport", () => {
    const smallView: Viewport = { widthPx: 640, heightPx: 480 };
    const explored = orbitCamera(defaultOrbitCamera(BOUNDS, smallView), 50, 50);
    expect(resetOrbitCamera(explored, BOUNDS)).toEqual(defaultOrbitCamera(BOUNDS, smallView));
  });
});

describe("projectOrbit (mm → CSS px, y growing down)", () => {
  it("grows screen y downward: up in the world is up on screen", () => {
    const camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    const center = projectOrbit(camera, BOUNDS_CENTER);
    expect(projectOrbit(camera, vec3(0, 0, BOUNDS.maxZ))[1]).toBeLessThan(center[1]);
    expect(projectOrbit(camera, vec3(0, 0, BOUNDS.minZ))[1]).toBeGreaterThan(center[1]);
  });

  it("keeps the target at the viewport center under any orientation and zoom", () => {
    let camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    for (const [dx, dy, wheel] of [[45, -30, 0], [-200, 90, 0], [0, 0, -250], [0, 0, 400]] as const) {
      camera = zoomCamera(orbitCamera(camera, dx, dy), wheel);
      const [cx, cy] = projectOrbit(camera, BOUNDS_CENTER);
      expect(cx).toBeCloseTo(VIEWPORT.widthPx / 2, 9);
      expect(cy).toBeCloseTo(VIEWPORT.heightPx / 2, 9);
    }
  });
});

describe("depthOrbit (view-space depth for painter's-algorithm sorting)", () => {
  it("grows with distance from the camera: larger is farther", () => {
    const camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
    // The default camera sits in the (−, −, +) octant relative to the
    // target, so a point toward that octant is nearer than its mirror.
    const near = vec3(-10, -10, BOUNDS_CENTER.z + 10);
    const far = vec3(10, 10, BOUNDS_CENTER.z - 10);
    expect(depthOrbit(camera, near)).toBeLessThan(depthOrbit(camera, BOUNDS_CENTER));
    expect(depthOrbit(camera, BOUNDS_CENTER)).toBeLessThan(depthOrbit(camera, far));
    // Depths stay positive in front of the camera, where the scene lives.
    expect(depthOrbit(camera, near)).toBeGreaterThan(0);
  });
});

describe("degenerate scenes stay finite through interaction", () => {
  it("a single-point scene: orbit and zoom sweeps produce finite projections and depths", () => {
    let camera = defaultOrbitCamera({ minX: 213, maxX: 213, minY: 0, maxY: 0, minZ: 305, maxZ: 305 }, VIEWPORT);
    const samples = [
      vec3(213, 0, 305),
      vec3(100, -50, 10),
      vec3(400, 200, 600),
      vec3(-1000, 1000, 0),
    ];
    for (const step of [[30, 0, 0], [0, 30, 0], [-30, 0, -500], [0, -30, 500]] as const) {
      camera = zoomCamera(orbitCamera(camera, step[0], step[1]), step[2]);
      expectFiniteCamera(camera);
      for (const p of samples) {
        const [x, y] = projectOrbit(camera, p);
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
        expect(Number.isFinite(depthOrbit(camera, p))).toBe(true);
      }
    }
  });

  it("a flat scene (one zero extent): the fit pads it and every projection stays finite", () => {
    const camera = defaultOrbitCamera({ minX: -100, maxX: 100, minY: -80, maxY: 80, minZ: 42, maxZ: 42 }, VIEWPORT);
    expectFiniteCamera(camera);
    const e = projectedExtents(camera, { minX: -100, maxX: 100, minY: -80, maxY: 80, minZ: 42, maxZ: 42 });
    expect(e.maxX - e.minX).toBeLessThanOrEqual(VIEWPORT.widthPx + 1e-6);
    expect(e.maxY - e.minY).toBeLessThanOrEqual(VIEWPORT.heightPx + 1e-6);
    for (const p of cornersOf({ minX: -100, maxX: 100, minY: -80, maxY: 80, minZ: 42, maxZ: 42 })) {
      const [x, y] = projectOrbit(camera, p);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});

describe("determinism (pure functions of explicit inputs)", () => {
  it("two identical call sequences produce identical records and projections", () => {
    const run = (): OrbitCamera[] => {
      let camera = defaultOrbitCamera(BOUNDS, VIEWPORT);
      const history = [camera];
      for (const [dx, dy, wheel] of [[60, -20, 0], [0, 55, 0], [-40, 0, -200], [120, -80, 350], [0, 0, -120]] as const) {
        camera = zoomCamera(orbitCamera(camera, dx, dy), wheel);
        history.push(camera);
      }
      return history;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    for (let i = 0; i < a.length; i++) {
      const camera = a[i] as OrbitCamera;
      expect(projectOrbit(camera, BOUNDS_CENTER)).toEqual(projectOrbit(b[i] as OrbitCamera, BOUNDS_CENTER));
      expect(projectOrbit(camera, vec3(37.5, -12.25, 88))).toEqual(projectOrbit(b[i] as OrbitCamera, vec3(37.5, -12.25, 88)));
      expect(depthOrbit(camera, vec3(37.5, -12.25, 88))).toBe(depthOrbit(b[i] as OrbitCamera, vec3(37.5, -12.25, 88)));
    }
  });
});
