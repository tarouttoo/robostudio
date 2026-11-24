// Evidence screenshot: capture the built app's renderer window as a PNG.
//
// Usage (CI, under a virtual display):
//   xvfb-run -a npx electron --no-sandbox scripts/evidence-screenshot.mjs \
//     /tmp/evidence/after.png
//
// Requires `npm run build` first (dist/renderer + dist/main must exist).
// EVIDENCE_WIDTH / EVIDENCE_HEIGHT / EVIDENCE_SETTLE_MS tune the capture.
// The agent prompts (.sandcastle/agent-workflows) and docs/agents/retro.md
// describe when to call this; the window wiring mirrors src/app/main.ts so
// the renderer sees the real preload surface.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BrowserWindow, app } from "electron";

const out = resolve(process.argv[2] ?? "/tmp/evidence/app.png");
const width = Number(process.env.EVIDENCE_WIDTH ?? 1280);
const height = Number(process.env.EVIDENCE_HEIGHT ?? 800);
const settleMs = Number(process.env.EVIDENCE_SETTLE_MS ?? 2000);

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      width,
      height,
      // Visible, not hidden: capturePage of a never-painted window comes
      // back empty; under xvfb "visible" costs nothing.
      show: true,
      webPreferences: {
        preload: resolve("dist/main/preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    await window.loadFile(resolve("dist/renderer/index.html"));
    await new Promise((settle) => setTimeout(settle, settleMs));
    const image = await window.webContents.capturePage();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, image.toPNG());
    const size = image.getSize();
    console.log(`Saved ${out} (${size.width}x${size.height})`);
    app.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
