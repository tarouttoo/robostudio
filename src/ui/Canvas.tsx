import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type RefObject } from "react";

import { vec2, type Segment, type Vec2, type Vec3, type WorkingPlane } from "../core";
import type {
  PointReachability,
  ReachabilityViolation,
} from "../kinematics/reachability";
import type { DraftPreview } from "./editor";
import { drawScene } from "./canvas/draw";
import type { ReachabilitySampler } from "./canvas/reachability";
import {
  DEFAULT_CAMERA,
  backingSize,
  fitCamera,
  makeCanvasTransform,
  panCameraBy,
  zoomAtCamera,
  type Camera,
  type Viewport,
} from "./canvas/transform";

/** How much one wheel notch (100 px of deltaY) scales the view, ≈1.22×. */
const WHEEL_ZOOM_RATE = 0.002;

/** Props of the drawing canvas. */
export interface CanvasProps {
  /** Working Plane the operator draws on (affects nothing drawn: all points project into the current view). */
  readonly plane: WorkingPlane;
  /** Committed canonical Segments. */
  readonly segments: readonly Segment[];
  /** The Home Point, or null while unset. */
  readonly home: Vec3 | null;
  /** The pending draft descriptor, or null when nothing is pending. */
  readonly draft: DraftPreview | null;
  /** Cursor position in plane millimetres, or null when off-canvas. */
  readonly cursor: Vec2 | null;
  /** The live Reachability map over the Working Plane. */
  readonly reachability: ReachabilitySampler;
  /** Per-Segment Reachability violations, aligned with `segments` by index. */
  readonly violations: readonly (ReachabilityViolation | null)[];
  /** Violation of the pending draft preview, or null when none. */
  readonly draftViolation: ReachabilityViolation | null;
  /** Reachability of the Home Point, or null while unset. */
  readonly homeStatus: PointReachability | null;
  /** Called with plane millimetres when the operator clicks the canvas. */
  readonly onPlaneClick: (uv: Vec2) => void;
  /** Called with plane millimetres on pointer move, or null on leave. */
  readonly onCursorMove: (uv: Vec2 | null) => void;
  /** Called when the operator cancels the pending draft (right-click). */
  readonly onDraftCancel: () => void;
}

/**
 * The drawing canvas: fills its container, re-measures the live
 * viewport on every resize and device-pixel-ratio change, derives the
 * world↔screen transform from the viewport plus the camera (ADR 0007),
 * and repaints the scene. Clicks are unprojected through the same
 * transform and reported in plane millimetres — the component holds no
 * geometry state itself, only the view camera.
 *
 * The camera (issue #44) starts fitted to the whole Reachability zone —
 * like the startup view — and the operator zooms with the wheel
 * (anchored at the cursor) and pans with a middle-button drag; the
 * «Вписать зону» button re-fits the zone on demand. The startup fit is
 * derived from the live viewport during render; the first operator
 * interaction mints the operator's camera, which then survives resizes
 * and Working Plane switches.
 */
export function Canvas(props: CanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewport = useElementViewport(containerRef);
  const [operatorCamera, setOperatorCamera] = useState<Camera | null>(null);
  const [panning, setPanning] = useState(false);

  /** The camera that fits the current Reachability zone into `vp`. */
  const fitToZone = (vp: Viewport): Camera => {
    const zone = props.reachability.zoneBounds();
    return zone !== null ? fitCamera(vp, zone) : DEFAULT_CAMERA;
  };

  // The startup camera, derived during render (no effect, no cascading
  // renders): the current zone fitted into the live viewport. Until the
  // operator takes over, a resize or plane switch re-fits, so the whole
  // zone stays visible.
  const startupCamera = useMemo(
    () => (viewport !== null ? fitToZone(viewport) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fitToZone closes over the live sampler, listed here
    [viewport, props.reachability],
  );
  const camera = operatorCamera ?? startupCamera;

  // The transform derives only from the viewport and the camera, so
  // memoizing on the two keeps its identity stable across unrelated
  // renders — the paint effect below then fires only on a real change.
  const transform = useMemo(
    () => (viewport && camera ? makeCanvasTransform(viewport, camera) : null),
    [viewport, camera],
  );

  // Repaint whenever the transform or any scene input changes.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !transform) return;
    drawScene(ctx, {
      transform,
      plane: props.plane,
      segments: props.segments,
      home: props.home,
      draft: props.draft,
      cursor: props.cursor,
      reachability: props.reachability,
      violations: props.violations,
      draftViolation: props.draftViolation,
      homeStatus: props.homeStatus,
    });
  }, [
    transform,
    props.plane,
    props.segments,
    props.home,
    props.draft,
    props.cursor,
    props.reachability,
    props.violations,
    props.draftViolation,
    props.homeStatus,
  ]);

  // Wheel zoom, anchored at the cursor. React's root wheel listener is
  // passive, so a native non-passive listener is subscribed here — the
  // only way preventDefault (no page zoom/scroll) actually works.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewport === null || camera === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = vec2(e.clientX - rect.left, e.clientY - rect.top);
      const nextPxPerMm = camera.pxPerMm * Math.exp(-e.deltaY * WHEEL_ZOOM_RATE);
      setOperatorCamera(zoomAtCamera(camera, viewport, nextPxPerMm, px));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [viewport, camera]);

  // A middle-button drag pans: the drag start's camera moved by the
  // pointer travel, so the world point under the pointer follows it.
  const panRef = useRef<{ startPx: Vec2; camera: Camera } | null>(null);

  /** The pointer position in canvas CSS pixels. */
  const screenPxOf = (e: React.PointerEvent<HTMLCanvasElement>): Vec2 => {
    const rect = e.currentTarget.getBoundingClientRect();
    return vec2(e.clientX - rect.left, e.clientY - rect.top);
  };

  /** Unprojects a pointer event to plane millimetres. */
  const planePointOf = (e: React.PointerEvent<HTMLCanvasElement>): Vec2 | null => {
    if (!transform) return null;
    return transform.toWorld(screenPxOf(e));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button === 1 && camera !== null) {
      e.preventDefault(); // no middle-click autoscroll while panning
      panRef.current = { startPx: screenPxOf(e), camera };
      setPanning(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const uv = planePointOf(e);
    if (uv !== null) props.onPlaneClick(uv);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const pan = panRef.current;
    if (pan !== null && camera !== null) {
      const px = screenPxOf(e);
      setOperatorCamera(panCameraBy(pan.camera, vec2(px.x - pan.startPx.x, px.y - pan.startPx.y)));
    }
    props.onCursorMove(planePointOf(e));
  };

  const endPan = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 1) return;
    panRef.current = null;
    setPanning(false);
  };

  const backing = viewport ? backingSize(viewport) : { width: 300, height: 150 };

  return (
    <div ref={containerRef} style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        width={backing.width}
        height={backing.height}
        style={{ display: "block", width: "100%", height: "100%", cursor: panning ? "grabbing" : "crosshair", touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onPointerLeave={() => props.onCursorMove(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onDraftCancel();
        }}
      />
      <button
        type="button"
        title="Показать всю зону достижимости, как при запуске"
        disabled={viewport === null || camera === null}
        onClick={() => {
          if (viewport !== null) setOperatorCamera(fitToZone(viewport));
        }}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          padding: "0.25rem 0.6rem",
          border: "1px solid #bbb",
          borderRadius: 4,
          background: "#fff",
          color: "#333",
          fontSize: "0.8rem",
        }}
      >
        Вписать зону
      </button>
    </div>
  );
}

/**
 * Measures the canvas container into a {@link Viewport} on every resize
 * and device-pixel-ratio change. The live measurement is what keeps the
 * transform reactive (ADR 0007): no size is captured at startup.
 * Returns null until the first measurement.
 */
function useElementViewport(ref: RefObject<HTMLDivElement | null>): Viewport | null {
  const [viewport, setViewport] = useState<Viewport | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      const next: Viewport = {
        widthPx: rect.width,
        heightPx: rect.height,
        devicePixelRatio: window.devicePixelRatio,
      };
      setViewport((prev) => (prev && sameViewport(prev, next) ? prev : next));
    };
    // Coalesce burst resize notifications into one paint-aligned update.
    let raf = 0;
    const schedule = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    measure();
    // The device pixel ratio changes without a resize (zoom, monitor
    // move): subscribe to the current ratio's media query, and resubscribe
    // whenever it fires because the ratio itself changed.
    let mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onResolutionChange = (): void => {
      measure();
      mql.removeEventListener("change", onResolutionChange);
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener("change", onResolutionChange);
    };
    mql.addEventListener("change", onResolutionChange);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      mql.removeEventListener("change", onResolutionChange);
    };
  }, [ref]);
  return viewport;
}

/** True when both viewports agree on every field (identity for React state). */
function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.widthPx === b.widthPx && a.heightPx === b.heightPx && a.devicePixelRatio === b.devicePixelRatio;
}
