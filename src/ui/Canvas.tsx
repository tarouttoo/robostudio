import { useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from "react";

import { vec2, type Segment, type Vec2, type Vec3, type WorkingPlane } from "../core";
import { drawScene } from "./canvas/draw";
import {
  backingSize,
  makeCanvasTransform,
  type CanvasTransform,
  type Viewport,
} from "./canvas/transform";

/** Props of the drawing canvas. */
export interface CanvasProps {
  /** Working Plane the operator draws on (affects nothing drawn: all points project into the current view). */
  readonly plane: WorkingPlane;
  /** Committed canonical Segments. */
  readonly segments: readonly Segment[];
  /** The Home Point, or null while unset. */
  readonly home: Vec3 | null;
  /** Pending Line start in plane millimetres, or null. */
  readonly draftStart: Vec2 | null;
  /** Cursor position in plane millimetres, or null when off-canvas. */
  readonly cursor: Vec2 | null;
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
 * world↔screen transform from it (ADR 0007), and repaints the scene.
 * Clicks are unprojected through the same transform and reported in
 * plane millimetres — the component holds no geometry state itself.
 */
export function Canvas(props: CanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewport = useElementViewport(containerRef);
  const transform: CanvasTransform | null = viewport ? makeCanvasTransform(viewport) : null;

  // Repaint whenever the transform or any scene input changes.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !transform) return;
    drawScene(ctx, {
      transform,
      plane: props.plane,
      segments: props.segments,
      home: props.home,
      draftStart: props.draftStart,
      cursor: props.cursor,
    });
  }, [transform, props.plane, props.segments, props.home, props.draftStart, props.cursor]);

  /** Unprojects a pointer event to plane millimetres. */
  const planePointOf = (e: React.PointerEvent<HTMLCanvasElement>): Vec2 | null => {
    if (!transform) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    return transform.toWorld(vec2(e.clientX - rect.left, e.clientY - rect.top));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return;
    const uv = planePointOf(e);
    if (uv !== null) props.onPlaneClick(uv);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    props.onCursorMove(planePointOf(e));
  };

  const backing = viewport ? backingSize(viewport) : { width: 300, height: 150 };

  return (
    <div ref={containerRef} style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        width={backing.width}
        height={backing.height}
        style={{ display: "block", width: "100%", height: "100%", cursor: "crosshair", touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => props.onCursorMove(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onDraftCancel();
        }}
      />
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
