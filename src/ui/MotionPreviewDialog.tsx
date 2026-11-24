/**
 * The Motion Preview playback dialog (Spec user story 27): the
 * operator watches the last successful Generation's motion without
 * leaving the app. The dialog is a thin consumer of the shared preview
 * renderer (ADR 0018) — it receives the frame documents the Generation
 * outcome carries (rendered by `renderMotionPreviewFrames`, the same
 * frames the exported GIF encodes), rasterizes each shown frame
 * through the renderer's own raster step (`rasterizePreviewFrame`),
 * and paints the exact palette pixels onto a canvas. Nothing is
 * plotted or projected here.
 *
 * Playback spans the Motion Plan's real duration (user story 28):
 * wall-clock time selects the frame whose sampled moment has arrived
 * (the pacing of {@link frameIndexAt}), so preview timing matches what
 * the robot will do. The operator pauses/resumes («Пуск»/«Пауза») and
 * scrubs across the duration with the time slider; the readout shows
 * the current moment and the plan duration in seconds.
 */

import { useEffect, useRef, useState, type JSX } from "react";

import {
  MOTION_PREVIEW_HEIGHT,
  MOTION_PREVIEW_PALETTE,
  MOTION_PREVIEW_WIDTH,
  rasterizePreviewFrame,
  type MotionPreviewFrame,
} from "../export";
import { frameIndexAt } from "./preview-playback";

/** Props of the playback dialog: the Generation's frames and their real duration. */
export interface MotionPreviewDialogProps {
  /** The Motion Preview frames of the last successful Generation (the outcome's documents). */
  readonly frames: readonly MotionPreviewFrame[];
  /** The Motion Plan's real duration, in milliseconds — the scrub's full span. */
  readonly durationMs: number;
  /** Called when the operator closes the dialog. */
  readonly onClose: () => void;
}

/** Formats milliseconds as seconds for the readout: two decimals, plain decimal. */
function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

/**
 * The playback dialog: a modal overlay with the renderer's canvas, the
 * play/pause control, the time scrub, and the close action. Opens
 * playing; reaching the plan's real duration pauses on the final
 * frame, and «Пуск» from there restarts from the first frame.
 */
export function MotionPreviewDialog(props: MotionPreviewDialogProps): JSX.Element {
  const { frames, durationMs, onClose } = props;
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
  /** The RGBA buffer the rasterized palette pixels are painted into, allocated once (client-side only). */
  const imageRef = useRef<ImageData | null>(null);

  /** Sets the plan moment through both the state and the playback loop's reference. */
  const setPlanTime = (ms: number): void => {
    timeRef.current = ms;
    setTimeMs(ms);
  };

  // Playback: wall-clock time advances the plan moment; the frame at
  // that moment is what the GIF plays at the same instant. Reaching
  // the real duration's end pauses on the final frame.
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

  // Paint the current frame: the shared renderer's raster step, then
  // its palette indices as opaque RGB pixels — exactly the GIF's pixels.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const frame = frames[frameIndexAt(frames, timeMs)];
    if (frame === undefined) return;
    if (imageRef.current === null) {
      imageRef.current = new ImageData(MOTION_PREVIEW_WIDTH, MOTION_PREVIEW_HEIGHT);
    }
    const image = imageRef.current;
    const indexed = rasterizePreviewFrame(frame);
    const rgba = image.data;
    for (let i = 0; i < indexed.length; i++) {
      const [r, g, b] = MOTION_PREVIEW_PALETTE[indexed[i] ?? 0] ?? [255, 255, 255];
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [frames, timeMs]);

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
          width={MOTION_PREVIEW_WIDTH}
          height={MOTION_PREVIEW_HEIGHT}
          style={{
            width: 720,
            height: 540,
            imageRendering: "pixelated",
            border: "1px solid #ddd",
            background: "#fff",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button type="button" onClick={playing ? () => setPlaying(false) : handlePlay} style={{ width: 72 }}>
            {playing ? "Пауза" : "Пуск"}
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
