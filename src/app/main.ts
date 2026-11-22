import { join } from "node:path";

import { APP_NAME } from "../core/version";
import { openProjectFile, saveProjectFile, type ProjectDialogs } from "./project-ipc";
import { BrowserWindow, app, dialog, ipcMain } from "electron";

/** URL of the Vite dev server; set by `npm run dev`, absent in production. */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

/** Whether the Project File IPC handlers are registered (once per app). */
let projectIpcRegistered = false;

/**
 * Registers the Project File IPC handlers: the save/open dialogs and
 * the file system access run here, in the main process — the sandboxed
 * renderer only ever sees the result records (ADR 0003). Registered
 * once; later windows share the same channels.
 */
function registerProjectIpc(window: BrowserWindow): void {
  if (projectIpcRegistered) return;
  projectIpcRegistered = true;
  const dialogs: ProjectDialogs = {
    showSave: () =>
      dialog.showSaveDialog(window, {
        title: "Сохранить Файл проекта",
        defaultPath: "project.json",
        filters: [{ name: "Файл проекта", extensions: ["json"] }],
      }),
    showOpen: () =>
      dialog.showOpenDialog(window, {
        title: "Открыть Файл проекта",
        filters: [{ name: "Файл проекта", extensions: ["json"] }],
        properties: ["openFile"],
      }),
  };
  ipcMain.handle("project:save", (_event, json: string) => saveProjectFile(dialogs, json));
  ipcMain.handle("project:open", () => openProjectFile(dialogs));
}

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
  registerProjectIpc(window);
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
