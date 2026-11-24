import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import {
  MOTION_PREVIEW_COLORS,
  MOTION_PREVIEW_HEIGHT,
  MOTION_PREVIEW_WIDTH,
  type MotionPreviewFrame,
} from "../export";
import { MotionPreviewDialog } from "./MotionPreviewDialog";

/**
 * Two crafted frames of the shared renderer (the dialog's input is
 * frame data, so the tests feed frame data): the first sample and one
 * hundred milliseconds in.
 */
const FRAMES: readonly MotionPreviewFrame[] = [
  { tMs: 0, primitives: [] },
  {
    tMs: 100,
    primitives: [{ kind: "dot", points: [[10, 10]], colorIndex: MOTION_PREVIEW_COLORS.tcp, width: 2 }],
  },
];

/** The plan's real duration, in milliseconds. */
const DURATION_MS = 120;

function dialogHtml(): string {
  return renderToString(
    <MotionPreviewDialog frames={FRAMES} durationMs={DURATION_MS} onClose={() => {}} />,
  ).replace(/<!-- -->/g, "");
}

describe("motion preview dialog", () => {
  it("opens as a modal dialog titled Предпросмотр движения and plays on open", () => {
    const html = dialogHtml();
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Предпросмотр движения");
    // Playing on open: the button offers Пауза.
    expect(html).toContain("Пауза");
    expect(html).not.toContain(">Пуск<");
    expect(html).toContain("Закрыть");
  });

  it("shows the shared renderer's canvas at the GIF's frame size", () => {
    // The same 480×360 frames the exported GIF encodes, scaled up for
    // viewing (the canvas paints client-side; the element declares the
    // renderer's exact pixel size).
    expect(dialogHtml()).toContain(
      `<canvas width="${MOTION_PREVIEW_WIDTH}" height="${MOTION_PREVIEW_HEIGHT}"`,
    );
  });

  it("offers a time scrub across the Motion Plan's real duration", () => {
    const html = dialogHtml();
    expect(html).toMatch(/<input type="range"[^>]*min="0"[^>]*max="120"[^>]*value="0"/);
  });

  it("shows the time readout in seconds across the plan's real duration", () => {
    const html = dialogHtml();
    expect(html).toContain("Время, с");
    expect(html).toContain("0.00 / 0.12");
  });
});
