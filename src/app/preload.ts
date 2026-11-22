import { contextBridge, ipcRenderer } from "electron";

import { APP_NAME, APP_VERSION } from "../core/version";

/**
 * The preload bridge: the only surface the sandboxed renderer can reach
 * the main process through. Project File save/open go through the main
 * process — the dialogs and the file system live there; the renderer
 * only exchanges JSON text and result records (ADR 0003). The handlers
 * never throw: they resolve with `{kind: ...}` records.
 */
contextBridge.exposeInMainWorld("robostudio", {
  appName: APP_NAME,
  appVersion: APP_VERSION,
  saveProject: (json: string) => ipcRenderer.invoke("project:save", json),
  openProject: () => ipcRenderer.invoke("project:open"),
});
