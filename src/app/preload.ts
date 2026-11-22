import { contextBridge } from "electron";

import { APP_NAME, APP_VERSION } from "../core/version";

/**
 * The preload bridge: the only surface the sandboxed renderer can reach
 * the main process through. Exposes static app info; privileged IPC
 * (file dialogs, project files) will be added here, never via
 * `nodeIntegration` (ADR 0003).
 */
contextBridge.exposeInMainWorld("robostudio", {
  appName: APP_NAME,
  appVersion: APP_VERSION,
});
