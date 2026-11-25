/**
 * The Motion Preview playback dialog (Spec user story 27): the operator
 * watches the last successful Generation's motion without leaving the
 * app. The dialog renders the outcome's Preview Scene (ADR 0018) — the
 * same millimetre document the exported GIF renders — through the
 * Orbit Camera (`orbit-camera.ts`): pointer drag orbits (yaw/pitch),
 * the wheel dollies, «Вписать» and a double-click reset to the default
 * isometric fit of the whole scene. Every animation frame (and every
 * camera move) repaints the whole scene onto the 2D canvas: the
 * primitives are sorted far-to-near by the camera's depth (painter's
 * algorithm, stable on ties) and stroked anti-aliased — the GIF's
 * raster and palette are not involved here; one scene, two cameras,
 * never two diverging renderings.
 *
 * Visual semantics match the GIF's in spirit (ADR 0018): the Trajectory
 * is colored along the scene's per-sample plan times through a fixed
 * viridis-like gradient ramp (the time schedule read along the path),
 * the travelled part is highlighted thicker in its distinct color over
 * the gradient, PTP Move geometry stays dashed (only arrival is
 * guaranteed, ADR 0016), the robot skeleton strokes thicker, and the
 * TCP marker, the PTP trace runs up to the current moment, and the
 * Home Point marker are drawn every frame — the Home Point stays
 * locatable from any camera angle. No text anywhere in the render.
 *
 * Playback spans the Motion Plan's real duration (user story 28):
 * wall-clock time selects the sampled moment whose time has arrived
 * (the pacing of {@link frameIndexAt}), so preview timing matches what
 * the robot will do. The operator pauses/resumes («Пуск»/«Пауза») and
 * scrubs across the duration with the time slider; the readout shows
 * the current moment and the plan duration in seconds. Camera state
 * and plan time are independent: orbiting or zooming never restarts
 * playback.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import type { PreviewScene, PreviewSceneBounds } from "../export";
import { vec3, type Vec3 } from "../core";
import {
  defaultOrbitCamera,
  depthOrbit,
  orbitCamera,
  projectOrbit,
  zoomCamera,
  type MmBounds,
  type OrbitCamera,
  type Viewport,
} from "./orbit-camera";
import { frameIndexAt } from "./preview-playback";

/** Props of the playback dialog: the Generation's scene and its real duration. */
export interface MotionPreviewDialogProps {
  /** The Preview Scene of the last successful Generation (the outcome's document). */
  readonly scene: PreviewScene;
  /** The Motion Plan's real duration, in milliseconds — the scrub's full span. */
  readonly durationMs: number;
  /** Called when the operator closes the dialog. */
  readonly onClose: () => void;
}

/** The viewport's CSS-pixel size (the canvas the camera renders through). */
const VIEW_WIDTH_PX = 720;
const VIEW_HEIGHT_PX = 540;

/**
 * The dialog's stroke colors, one per scene meaning — the GIF palette's
 * hues (robot, travelled, TCP, PTP trace, Home) read through the
 * canvas's anti-aliased strokes instead of the GIF's fixed pixels.
 */
const COLORS = {
  robot: "#333333",
  travelled: "#1f77b4",
  tcp: "#d62728",
  ptpTrace: "#ff7f0e",
  home: "#2ca02c",
} as const;

/**
 * The Trajectory's time-gradient ramp: fixed viridis-like stops, dark
 * blue-green to yellow — the GIF renderer's time ramp in spirit (the
 * scene's schedule colored along the path), not its exact pixels. A
 * sample's plan time, normalized over the plan's real duration, picks
 * the interpolated stop.
 */
const RAMP: readonly (readonly [number, number, number])[] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

/** PTP dash pattern, in CSS pixels (on, off). */
const DASH_PX: readonly number[] = [4, 3];

/** Stroke widths, in CSS pixels: gradient, highlight, skeleton, trace. */
const WIDTH_PX = { gradient: 1.5, travelled: 3, robot: 3, ptpTrace: 1.5 } as const;

/** Marker radii, in CSS pixels. */
const RADIUS_PX = { tcp: 3.5, home: 4.5 } as const;

/** Formats milliseconds as seconds for the readout: two decimals, plain decimal. */
function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

/** The scene's bounds record as the camera's box shape. */
function mmBounds(bounds: PreviewSceneBounds): MmBounds {
  return {
    minX: bounds.min[0],
    maxX: bounds.max[0],
    minY: bounds.min[1],
    maxY: bounds.max[1],
    minZ: bounds.min[2],
    maxZ: bounds.max[2],
  };
}

/** The scene's millimetre tuple point as the camera math's point record. */
function asPoint(p: readonly [number, number, number]): Vec3 {
  return vec3(p[0], p[1], p[2]);
}

/** Interpolates the ramp at a normalized time (clamped into [0, 1]). */
function rampColor(u: number): string {
  const scaled = Math.min(1, Math.max(0, u)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(scaled));
  const a = RAMP[i] as readonly [number, number, number];
  const b = RAMP[i + 1] as readonly [number, number, number];
  const f = scaled - i;
  const mix = (x: number, y: number): number => Math.round(x + (y - x) * f);
  return `rgb(${mix(a[0], b[0])}, ${mix(a[1], b[1])}, ${mix(a[2], b[2])})`;
}

/**
 * One drawable primitive, already projected into CSS pixels: a stroked
 * polyline or a filled marker disc. `depth` is the mean view depth of
 * its points — the painter's-algorithm sort key (larger = farther).
 */
interface Painted {
  readonly points: readonly (readonly [number, number])[];
  readonly color: string;
  readonly widthPx: number;
  readonly dashed: boolean;
  /** Filled disc radius at `points[0]`; 0 for a stroked polyline. */
  readonly dotRadiusPx: number;
  readonly depth: number;
}

/**
 * Paints the whole scene at `timeMs` through `camera`: the projected
 * Trajectory gradient, the travelled highlight up to the current
 * moment, the PTP trace runs up to it, the robot skeleton with its TCP
 * marker, and the Home Point — sorted far-to-near, farthest first.
 * Pure over its inputs; every animation frame and camera move repaints
 * from scratch.
 */
function drawScene(
  context: CanvasRenderingContext2D,
  scene: PreviewScene,
  camera: OrbitCamera,
  timeMs: number,
  durationMs: number,
): void {
  const { widthPx, heightPx } = camera.viewport;
  context.clearRect(0, 0, widthPx, heightPx);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, widthPx, heightPx);
  context.lineCap = "round";
  context.lineJoin = "round";

  const momentIndex = frameIndexAt(scene.moments, timeMs);
  const moment = scene.moments[momentIndex];
  if (moment === undefined) return;

  const painted: Painted[] = [];
  const pushStroke = (mm: readonly (readonly [number, number, number])[], color: string, widthPx: number, dashed: boolean): void => {
    if (mm.length < 2) return;
    const points = mm.map((p) => projectOrbit(camera, asPoint(p)));
    let depth = 0;
    for (const p of mm) depth += depthOrbit(camera, asPoint(p));
    painted.push({ points, color, widthPx, dashed, dotRadiusPx: 0, depth: depth / mm.length });
  };
  const pushDot = (mm: readonly [number, number, number], color: string, dotRadiusPx: number): void => {
    painted.push({
      points: [projectOrbit(camera, asPoint(mm))],
      color,
      widthPx: 0,
      dashed: false,
      dotRadiusPx,
      depth: depthOrbit(camera, asPoint(mm)),
    });
  };

  // The Trajectory, colored along the scene's per-sample plan times:
  // one gradient-colored stroke per sample pair (PTP geometry dashed).
  const spanMs = durationMs > 0 ? durationMs : 1;
  for (const segment of scene.segments) {
    for (let i = 1; i < segment.mm.length; i++) {
      const prev = segment.mm[i - 1];
      const cur = segment.mm[i];
      if (prev === undefined || cur === undefined) continue;
      const tPrev = segment.tMs[i - 1] ?? 0;
      const tCur = segment.tMs[i] ?? tPrev;
      pushStroke([prev, cur], rampColor((tPrev + tCur) / 2 / spanMs), WIDTH_PX.gradient, segment.isPtp);
    }
  }

  // The travelled part up to the current moment: per travelled slot,
  // the Segment polyline up to the scene-measured extent — the drawn
  // sample count nearest the moment's TCP, which ends where the TCP
  // marker sits (a count below 2 spans nothing drawable; a PTP Move's
  // slot is 0 — only arrival is guaranteed, ADR 0016).
  const segmentById = new Map(scene.segments.map((s) => [s.segmentIndex, s]));
  scene.travelledSegments.forEach((segmentIndex, slot) => {
    const count = moment.travelled[slot] ?? 0;
    if (count < 2) return;
    const segment = segmentById.get(segmentIndex);
    if (segment === undefined) return;
    pushStroke(segment.mm.slice(0, count), COLORS.travelled, WIDTH_PX.travelled, false);
  });

  // The actual TCP trace under PTP: the forward-kinematics positions of
  // the moments visited so far, one polyline per run (ADR 0016).
  for (const run of scene.traceRuns) {
    const visited: (readonly [number, number, number])[] = [];
    for (const index of run) {
      if (index > momentIndex) break;
      const visitedMoment = scene.moments[index];
      if (visitedMoment !== undefined) visited.push(visitedMoment.tcpMm);
    }
    pushStroke(visited, COLORS.ptpTrace, WIDTH_PX.ptpTrace, false);
  }

  // The robot skeleton at the sampled moment, with its TCP marker.
  pushStroke(moment.chainMm, COLORS.robot, WIDTH_PX.robot, false);
  pushDot(moment.tcpMm, COLORS.tcp, RADIUS_PX.tcp);
  // The Home Point, every frame: locatable from any camera angle.
  pushDot(scene.homeMm, COLORS.home, RADIUS_PX.home);

  // Painter's algorithm: farthest first. The sort is stable, so equal
  // depths keep construction order — the gradient first, then the
  // thicker travelled highlight over it; no flicker between frames.
  painted.sort((a, b) => b.depth - a.depth);

  for (const prim of painted) {
    if (prim.dotRadiusPx > 0) {
      const [x, y] = prim.points[0] as readonly [number, number];
      context.beginPath();
      context.arc(x, y, prim.dotRadiusPx, 0, 2 * Math.PI);
      context.fillStyle = prim.color;
      context.fill();
      continue;
    }
    context.beginPath();
    const first = prim.points[0] as readonly [number, number];
    context.moveTo(first[0], first[1]);
    for (let i = 1; i < prim.points.length; i++) {
      const [x, y] = prim.points[i] as readonly [number, number];
      context.lineTo(x, y);
    }
    context.setLineDash(prim.dashed ? DASH_PX : []);
    context.lineWidth = prim.widthPx;
    context.strokeStyle = prim.color;
    context.stroke();
    context.setLineDash([]);
  }
}

/**
 * Measures the canvas into the camera's {@link Viewport} on every
 * resize (the live measurement keeps the projection reactive, the
 * canvas transform's discipline of ADR 0007). Returns null until the
 * first measurement.
 */
function useCanvasViewport(ref: RefObject<HTMLCanvasElement | null>): Viewport | null {
  const [viewport, setViewport] = useState<Viewport | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => {
      // The content box (client size): the border is the canvas's own
      // frame, not part of the viewport the camera maps into.
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return;
      const next: Viewport = { widthPx: el.clientWidth, heightPx: el.clientHeight };
      setViewport((prev) => (prev !== null && prev.widthPx === next.widthPx && prev.heightPx === next.heightPx ? prev : next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [ref]);
  return viewport;
}

/**
 * The playback dialog: a modal overlay with the camera's viewport, the
 * play/pause control, the «Вписать» reset, the time scrub, and the
 * close action. Opens playing; reaching the plan's real duration
 * pauses on the final frame, and «Пуск» from there restarts from the
 * first frame.
 */
export function MotionPreviewDialog(props: MotionPreviewDialogProps): JSX.Element {
  const { scene, durationMs, onClose } = props;
  /** Whether playback runs; the dialog opens playing. */
  const [playing, setPlaying] = useState(true);
  /** The current moment in plan time, in milliseconds. */
  const [timeMs, setTimeMs] = useState(0);
  /**
   * The same moment, readable and writable without waiting for a
   * render: the playback loop advances from it every frame, and a
   * scrub while playing resumes from the scrubbed moment.
   */
  const timeRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The pointer drag in flight: the last captured position, CSS pixels. */
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  /** The live viewport (ADR 0007: measured, never assumed). */
  const viewport = useCanvasViewport(canvasRef);
  /** The scene's bounds, as the camera fits against them. */
  const bounds = useMemo(() => mmBounds(scene.boundsMm), [scene]);
  /**
   * The default fit: the isometric fit of the whole scene in the live
   * viewport — the same convention the GIF's fixed camera uses, so the
   * reset view is the GIF's view. Derived during render (the canvas
   * camera's discipline): a viewport change refits under the operator.
   */
  const fitCamera = useMemo(() => (viewport !== null ? defaultOrbitCamera(bounds, viewport) : null), [bounds, viewport]);
  /** The operator's explored camera, or null while the default fit stands. */
  const [exploredCamera, setExploredCamera] = useState<OrbitCamera | null>(null);
  const camera = exploredCamera ?? fitCamera;

  /** Sets the plan moment through both the state and the playback loop's reference. */
  const setPlanTime = (ms: number): void => {
    timeRef.current = ms;
    setTimeMs(ms);
  };

  // Playback: wall-clock time advances the plan moment; the scene at
  // that moment is what the GIF shows at the same instant. Reaching
  // the real duration's end pauses on the final moment.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let previous = performance.now();
    const step = (now: number): void => {
      const delta = now - previous;
      previous = now;
      const next = Math.min(durationMs, timeRef.current + delta);
      timeRef.current = next;
      setTimeMs(next);
      if (next >= durationMs) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationMs]);

  // Esc closes the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Paint the scene at the current moment through the camera: every
  // animation frame (the time advances) and every camera move repaints
  // the whole scene. The backing store scales with the device pixel
  // ratio (crisp strokes); the drawing itself stays in CSS pixels via
  // the context transform.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || camera === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const dpr = window.devicePixelRatio || 1;
    const backingWidth = Math.round(camera.viewport.widthPx * dpr);
    const backingHeight = Math.round(camera.viewport.heightPx * dpr);
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScene(context, scene, camera, timeMs, durationMs);
  }, [camera, scene, timeMs, durationMs]);

  // Wheel dolly. React's root wheel listener is passive, so a native
  // non-passive listener is subscribed here — the only way
  // preventDefault (no page scroll behind the dialog) actually works.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || camera === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      setExploredCamera(zoomCamera(camera, event.deltaY));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [camera]);

  /** Pointer drag = orbit: the drag delta's yaw/pitch through the pure camera step. */
  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    dragRef.current = { x: event.clientX, y: event.clientY };
    // Capture keeps the drag alive when the pointer leaves the canvas;
    // the drag itself works without it while the pointer stays inside.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    if (drag === null || camera === null) return;
    setExploredCamera(orbitCamera(camera, event.clientX - drag.x, event.clientY - drag.y));
    dragRef.current = { x: event.clientX, y: event.clientY };
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /**
   * «Вписать» / double-click: back to the default isometric fit of the
   * whole scene — the explored override clears, and the fit (exactly
   * `defaultOrbitCamera` of the bounds in the live viewport) stands
   * again: a fresh default view, no residue of the explored one.
   */
  const handleFit = (): void => {
    setExploredCamera(null);
  };

  /** Starts playback — from the first frame when the end was reached. */
  const handlePlay = (): void => {
    if (timeMs >= durationMs) setPlanTime(0);
    setPlaying(true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Предпросмотр движения"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10,
      }}
    >
      <div
        style={{
          background: "#fff",
          padding: "1rem",
          borderRadius: 6,
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.3)",
        }}
      >
        <h2 style={{ fontSize: "1.1rem", margin: 0 }}>Предпросмотр движения</h2>
        <canvas
          ref={canvasRef}
          width={VIEW_WIDTH_PX}
          height={VIEW_HEIGHT_PX}
          style={{
            width: VIEW_WIDTH_PX,
            height: VIEW_HEIGHT_PX,
            border: "1px solid #ddd",
            background: "#fff",
            touchAction: "none",
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleFit}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button type="button" onClick={playing ? () => setPlaying(false) : handlePlay} style={{ width: 72 }}>
            {playing ? "Пауза" : "Пуск"}
          </button>
          <button type="button" onClick={handleFit} title="Показать всю сцену">
            Вписать
          </button>
          <input
            type="range"
            min={0}
            max={durationMs}
            step={1}
            value={timeMs}
            aria-label="Время"
            onChange={(e) => setPlanTime(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontFamily: "monospace", fontSize: "0.85rem", whiteSpace: "nowrap" }}>
            Время, с: {formatSeconds(timeMs)} / {formatSeconds(durationMs)}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
