import { describe, expect, it } from "vitest";

import { planeCoords, planePoint, type WorkingPlane } from "../../core";
import { vec2 } from "../../core";
import {
  DEFAULT_PX_PER_MM,
  MAX_PX_PER_MM,
  MIN_PX_PER_MM,
  backingSize,
  fitCamera,
  makeCanvasTransform,
  panCameraBy,
  worldBounds,
  zoomAtCamera,
  type Camera,
  type Viewport,
} from "./transform";

/** Millimetre tolerance for projection round-trips (sub-nanometre). */
const ROUND_TRIP_TOLERANCE_MM = 1e-9;

const VIEWPORT: Viewport = { widthPx: 800, heightPx: 600, devicePixelRatio: 1 };

describe("canvas transform (ADR 0007)", () => {
  it("maps the world origin to the viewport centre", () => {
    const t = makeCanvasTransform(VIEWPORT);
    const center = t.toScreen(vec2(0, 0));
    expect(center.x).toBe(VIEWPORT.widthPx / 2);
    expect(center.y).toBe(VIEWPORT.heightPx / 2);
  });

  it("round-trips world → screen → world within 1e-9 mm", () => {
    const t = makeCanvasTransform(VIEWPORT);
    const points = [
      vec2(0, 0),
      vec2(100, 50),
      vec2(-120.75, 88.25),
      vec2(0.1, -0.1),
      vec2(-350, -280),
      vec2(1234.5, -987.25),
    ];
    for (const p of points) {
      const back = t.toWorld(t.toScreen(p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it("round-trips screen → world → screen within 1e-9 px", () => {
    const t = makeCanvasTransform(VIEWPORT);
    const pixels = [vec2(0, 0), vec2(400, 300), vec2(799.5, 12.25), vec2(31, 599)];
    for (const px of pixels) {
      const back = t.toScreen(t.toWorld(px));
      expect(back.x).toBeCloseTo(px.x, 9);
      expect(back.y).toBeCloseTo(px.y, 9);
    }
  });

  it("is invariant under device pixel ratio changes", () => {
    // The CSS-pixel mapping must not depend on the DPR: the same world
    // point lands on the same CSS pixel on a 1x display and a 3x one.
    const t1 = makeCanvasTransform({ ...VIEWPORT, devicePixelRatio: 1 });
    const t2 = makeCanvasTransform({ ...VIEWPORT, devicePixelRatio: 2 });
    const t3 = makeCanvasTransform({ ...VIEWPORT, devicePixelRatio: 3 });
    const world = [vec2(0, 0), vec2(37.5, -12.25), vec2(-200, 140)];
    for (const p of world) {
      expect(t2.toScreen(p)).toEqual(t1.toScreen(p));
      expect(t3.toScreen(p)).toEqual(t1.toScreen(p));
      expect(t2.toWorld(t1.toScreen(p))).toEqual(t1.toWorld(t1.toScreen(p)));
    }
  });

  it("is a pure function of the live viewport: no state survives a rebuild", () => {
    // Rebuilding the transform from the same viewport gives the same
    // mapping — a resize cannot leave stale constants behind.
    const a = makeCanvasTransform(VIEWPORT);
    const b = makeCanvasTransform(VIEWPORT);
    const world = [vec2(0, 0), vec2(10, -3.5), vec2(-42, 17)];
    for (const p of world) {
      expect(b.toScreen(p)).toEqual(a.toScreen(p));
    }
  });

  it("recomputes the mapping from the resized viewport, keeping geometry isotropic", () => {
    // The prototype's bug: a drawn 100×100 mm square came out as a
    // rectangle after a resize. The mm→px scale is one number, so equal
    // world extents map to equal pixel extents at every viewport size.
    const viewports: Viewport[] = [
      { widthPx: 800, heightPx: 600, devicePixelRatio: 1 },
      { widthPx: 1280, heightPx: 1024, devicePixelRatio: 1 },
      { widthPx: 617, heightPx: 493, devicePixelRatio: 1.25 },
      { widthPx: 3840, heightPx: 2160, devicePixelRatio: 2 },
    ];
    for (const vp of viewports) {
      const t = makeCanvasTransform(vp);
      const left = t.toScreen(vec2(0, 0));
      const right = t.toScreen(vec2(100, 0));
      const top = t.toScreen(vec2(0, 100));
      expect(right.x - left.x).toBeCloseTo(left.y - top.y, 9);
      // The centre follows the live viewport, not a startup constant.
      expect(t.toScreen(vec2(0, 0)).x).toBe(vp.widthPx / 2);
      expect(t.toScreen(vec2(0, 0)).y).toBe(vp.heightPx / 2);
      // And the round-trip still holds after the resize.
      const p = vec2(-63.5, 44.25);
      const back = t.toWorld(t.toScreen(p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it("exposes the world bounds of the viewport", () => {
    const t = makeCanvasTransform(VIEWPORT, { pxPerMm: 4, center: vec2(0, 0) });
    const bounds = worldBounds(t);
    expect(bounds.minU).toBeCloseTo(-100, 9); // 800/2 / 4
    expect(bounds.maxU).toBeCloseTo(100, 9);
    expect(bounds.minV).toBeCloseTo(-75, 9); // 600/2 / 4
    expect(bounds.maxV).toBeCloseTo(75, 9);
  });

  it("scales the backing store with the device pixel ratio, never to zero", () => {
    expect(backingSize({ widthPx: 800, heightPx: 600, devicePixelRatio: 1 })).toEqual({
      width: 800,
      height: 600,
    });
    expect(backingSize({ widthPx: 800, heightPx: 600, devicePixelRatio: 1.5 })).toEqual({
      width: 1200,
      height: 900,
    });
    // A collapsed element still gets a 1×1 backing store, not 0×0.
    expect(backingSize({ widthPx: 0, heightPx: 0, devicePixelRatio: 2 })).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("agrees with world coordinates through the plane projection (cursor readout seam)", () => {
    // The cursor readout shows (u, v) from toWorld; the point it names
    // must be the point under the cursor on every Working Plane:
    // screen px → plane mm → 3D point on the plane → plane coords →
    // screen px, closing the loop.
    const t = makeCanvasTransform(VIEWPORT);
    const planes: WorkingPlane[] = ["XY", "XZ", "YZ"];
    const clicks = [vec2(512, 233), vec2(31.5, 402), vec2(400, 300)];
    for (const plane of planes) {
      for (const click of clicks) {
        const uv = t.toWorld(click);
        const onPlane = planePoint(plane, uv.x, uv.y, 5);
        const coords = planeCoords(plane, onPlane);
        expect(coords.u).toBeCloseTo(uv.x, ROUND_TRIP_TOLERANCE_MM);
        expect(coords.v).toBeCloseTo(uv.y, ROUND_TRIP_TOLERANCE_MM);
        expect(coords.w).toBe(5);
        const back = t.toScreen(vec2(coords.u, coords.v));
        expect(back.x).toBeCloseTo(click.x, 9);
        expect(back.y).toBeCloseTo(click.y, 9);
      }
    }
  });
});

const CAMERA_VIEW: Viewport = { widthPx: 800, heightPx: 600, devicePixelRatio: 1 };

describe("camera: scale and pan offset (issue #44)", () => {
  it("shows the camera centre at the viewport centre", () => {
    const camera: Camera = { pxPerMm: 3, center: vec2(120, -45) };
    const t = makeCanvasTransform(CAMERA_VIEW, camera);
    const centre = t.toScreen(camera.center);
    expect(centre.x).toBeCloseTo(CAMERA_VIEW.widthPx / 2, 9);
    expect(centre.y).toBeCloseTo(CAMERA_VIEW.heightPx / 2, 9);
  });

  it("round-trips world → screen → world through a panned, scaled camera within 1e-9 mm", () => {
    const camera: Camera = { pxPerMm: 2.5, center: vec2(-88.5, 210.25) };
    const t = makeCanvasTransform(CAMERA_VIEW, camera);
    const points = [vec2(0, 0), vec2(300, -120), vec2(-513.75, 44.5), vec2(0.5, -0.5)];
    for (const p of points) {
      const back = t.toWorld(t.toScreen(p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
    expect(t.pxPerMm).toBe(2.5);
  });

  it("keeps the default camera: origin at the viewport centre, 4 px per mm", () => {
    // Callers without a camera see exactly the pre-issue mapping.
    const t = makeCanvasTransform(CAMERA_VIEW);
    expect(t.toScreen(vec2(0, 0))).toEqual(vec2(CAMERA_VIEW.widthPx / 2, CAMERA_VIEW.heightPx / 2));
    expect(t.toWorld(vec2(CAMERA_VIEW.widthPx / 2, CAMERA_VIEW.heightPx / 2))).toEqual(vec2(0, 0));
    expect(t.pxPerMm).toBe(DEFAULT_PX_PER_MM);
  });
});

describe("fitCamera (issue #44)", () => {
  it("fits the whole zone into the viewport, centred on it", () => {
    const zone = { minU: -100, maxU: 300, minV: -50, maxV: 150 }; // 400×200 mm
    const camera = fitCamera(CAMERA_VIEW, zone);
    // The limiting axis is u: 800 px / 400 mm = 2 px/mm (v alone allows 3).
    expect(camera.pxPerMm).toBeCloseTo(2, 9);
    const t = makeCanvasTransform(CAMERA_VIEW, camera);
    const corners = [
      vec2(zone.minU, zone.minV),
      vec2(zone.maxU, zone.minV),
      vec2(zone.minU, zone.maxV),
      vec2(zone.maxU, zone.maxV),
    ];
    for (const corner of corners) {
      const px = t.toScreen(corner);
      expect(px.x).toBeGreaterThanOrEqual(0);
      expect(px.x).toBeLessThanOrEqual(CAMERA_VIEW.widthPx);
      expect(px.y).toBeGreaterThanOrEqual(0);
      expect(px.y).toBeLessThanOrEqual(CAMERA_VIEW.heightPx);
    }
    const centre = t.toScreen(vec2((zone.minU + zone.maxU) / 2, (zone.minV + zone.maxV) / 2));
    expect(centre.x).toBeCloseTo(CAMERA_VIEW.widthPx / 2, 9);
    expect(centre.y).toBeCloseTo(CAMERA_VIEW.heightPx / 2, 9);
  });

  it("clamps the fit scale into the bounded 0.5–20 px/mm range", () => {
    // Wider than the viewport even at the minimum scale.
    const wide = fitCamera(CAMERA_VIEW, { minU: -5000, maxU: 5000, minV: -1, maxV: 1 });
    expect(wide.pxPerMm).toBe(MIN_PX_PER_MM);
    // Far smaller than the viewport at the maximum scale.
    const tiny = fitCamera(CAMERA_VIEW, { minU: -1, maxU: 1, minV: -1, maxV: 1 });
    expect(tiny.pxPerMm).toBe(MAX_PX_PER_MM);
  });

  it("still centres a degenerate (single-point) zone", () => {
    const camera = fitCamera(CAMERA_VIEW, { minU: 40, maxU: 40, minV: -10, maxV: -10 });
    expect(Number.isFinite(camera.pxPerMm)).toBe(true);
    const px = makeCanvasTransform(CAMERA_VIEW, camera).toScreen(vec2(40, -10));
    expect(px.x).toBeCloseTo(CAMERA_VIEW.widthPx / 2, 9);
    expect(px.y).toBeCloseTo(CAMERA_VIEW.heightPx / 2, 9);
  });
});

describe("zoomAtCamera (issue #44)", () => {
  it("keeps the world point under the cursor fixed while zooming", () => {
    const camera: Camera = { pxPerMm: 2, center: vec2(10, -5) };
    const px = vec2(513.5, 202.25);
    const before = makeCanvasTransform(CAMERA_VIEW, camera).toWorld(px);
    const zoomed = zoomAtCamera(camera, CAMERA_VIEW, 4, px);
    expect(zoomed.pxPerMm).toBe(4);
    const after = makeCanvasTransform(CAMERA_VIEW, zoomed).toWorld(px);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("anchors at the cursor even when the scale clamps at the bounds", () => {
    const px = vec2(123, 456);
    const camera: Camera = { pxPerMm: 18, center: vec2(-7.5, 33) };
    const before = makeCanvasTransform(CAMERA_VIEW, camera).toWorld(px);
    const inClamped = zoomAtCamera(camera, CAMERA_VIEW, 100, px);
    expect(inClamped.pxPerMm).toBe(MAX_PX_PER_MM);
    const afterIn = makeCanvasTransform(CAMERA_VIEW, inClamped).toWorld(px);
    expect(afterIn.x).toBeCloseTo(before.x, 9);
    expect(afterIn.y).toBeCloseTo(before.y, 9);

    const outClamped = zoomAtCamera(camera, CAMERA_VIEW, 0.001, px);
    expect(outClamped.pxPerMm).toBe(MIN_PX_PER_MM);
    const afterOut = makeCanvasTransform(CAMERA_VIEW, outClamped).toWorld(px);
    expect(afterOut.x).toBeCloseTo(before.x, 9);
    expect(afterOut.y).toBeCloseTo(before.y, 9);
  });
});

describe("panCameraBy (issue #44)", () => {
  it("moves the view with the pointer: the world point at the start pixel lands at the offset pixel", () => {
    const camera: Camera = { pxPerMm: 2, center: vec2(50, 25) };
    const d = vec2(-137, 42);
    const panned = panCameraBy(camera, d);
    expect(panned.pxPerMm).toBe(camera.pxPerMm); // a pan never rescales
    const worldAtStart = makeCanvasTransform(CAMERA_VIEW, camera).toWorld(vec2(CAMERA_VIEW.widthPx / 2, CAMERA_VIEW.heightPx / 2));
    const where = makeCanvasTransform(CAMERA_VIEW, panned).toScreen(worldAtStart);
    expect(where.x).toBeCloseTo(CAMERA_VIEW.widthPx / 2 + d.x, 9);
    expect(where.y).toBeCloseTo(CAMERA_VIEW.heightPx / 2 + d.y, 9);
  });
});
