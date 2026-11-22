import { join } from "node:path";

import { APP_NAME } from "../core/version";
import { BrowserWindow, app } from "electron";

/** URL of the Vite dev server; set by `npm run dev`, absent in production. */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

/**
 * Creates the main application window with a sandboxed renderer: no
 * Node integration, context isolation on, all privileged access behind
 * the preload bridge (ADR 0003).
 */
function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: APP_NAME,
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
  return window;
}

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
