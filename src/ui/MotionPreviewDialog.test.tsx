import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import type { PreviewScene } from "../export";
import { MotionPreviewDialog } from "./MotionPreviewDialog";

/**
 * A crafted scene (the dialog's input is scene data, so the tests feed
 * scene data): two sampled moments — the first sample and one hundred
 * milliseconds in — each with a three-point robot chain, over a small
 * millimetre bounding box. The painting itself is client-side canvas
 * work; this seam pins what the modal renders from the scene.
 */
const SCENE: PreviewScene = {
  segments: [],
  moments: [
    {
      tMs: 0,
      chainMm: [
        [0, 0, 0],
        [40, 0, 60],
        [80, 0, 0],
      ],
      tcpMm: [80, 0, 0],
      travelled: [],
    },
    {
      tMs: 100,
      chainMm: [
        [0, 0, 0],
        [40, 0, 60],
        [120, 0, 0],
      ],
      tcpMm: [120, 0, 0],
      travelled: [],
    },
  ],
  traceRuns: [],
  travelledSegments: [],
  homeMm: [0, 0, 0],
  boundsMm: {
    min: [0, 0, 0],
    max: [120, 0, 60],
  },
};

/** The plan's real duration, in milliseconds. */
const DURATION_MS = 120;

function dialogHtml(): string {
  return renderToString(
    <MotionPreviewDialog scene={SCENE} durationMs={DURATION_MS} onClose={() => {}} />,
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

  it("offers the viewport canvas the Orbit Camera renders through", () => {
    // The canvas is the camera's viewport (CSS-pixel sized, painted
    // client-side); the element declares the viewport's pixel size.
    expect(dialogHtml()).toMatch(/<canvas [^>]*width="720"[^>]*height="540"/);
  });

  it("offers «Вписать» — the reset to the default isometric fit of the whole scene", () => {
    expect(dialogHtml()).toContain("Вписать");
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
