import { join } from "node:path";

import { APP_NAME } from "../core/version";
import { exportCsvs, type ExportDialogs } from "./export-ipc";
import { openProjectFile, saveProjectFile, type ProjectDialogs } from "./project-ipc";
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";

/** URL of the Vite dev server; set by `npm run dev`, absent in production. */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

/** Whether the IPC handlers are registered (once per app). */
let ipcRegistered = false;

/**
 * Registers the IPC handlers: the Project File save/open dialogs and
 * the CSV export folder picker, plus the file system access behind
 * them, run here in the main process — the sandboxed renderer only
 * ever sees the result records (ADR 0003). Registered once; later
 * windows share the same channels.
 */
function registerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  // The dialog parent is resolved at call time, not captured here: a
  // registered handler outlives any window (macOS re-activate creates a
  // new one), and a destroyed parent would make every dialog throw.
  const parent = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? undefined;
  const dialogs: ProjectDialogs = {
    showSave: () => {
      const options: SaveDialogOptions = {
        title: "Сохранить Файл проекта",
        defaultPath: "project.json",
        filters: [{ name: "Файл проекта", extensions: ["json"] }],
      };
      const owner = parent();
      return owner === undefined ? dialog.showSaveDialog(options) : dialog.showSaveDialog(owner, options);
    },
    showOpen: () => {
      const options: OpenDialogOptions = {
        title: "Открыть Файл проекта",
        filters: [{ name: "Файл проекта", extensions: ["json"] }],
        properties: ["openFile"],
      };
      const owner = parent();
      return owner === undefined ? dialog.showOpenDialog(options) : dialog.showOpenDialog(owner, options);
    },
  };
  ipcMain.handle("project:save", (_event, json: string) => saveProjectFile(dialogs, json));
  ipcMain.handle("project:open", () => openProjectFile(dialogs));
  const exportDialogs: ExportDialogs = {
    showDirectory: () => {
      const options: OpenDialogOptions = {
        title: "Экспорт CSV: выберите папку",
        properties: ["openDirectory", "createDirectory"],
      };
      const owner = parent();
      return owner === undefined ? dialog.showOpenDialog(options) : dialog.showOpenDialog(owner, options);
    },
  };
  ipcMain.handle("export:csvs", (_event, robotCsv: string, rvizCsv: string) =>
    exportCsvs(exportDialogs, robotCsv, rvizCsv),
  );
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
  registerIpc();
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
