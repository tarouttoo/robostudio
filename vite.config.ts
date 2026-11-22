import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Renderer build: the React app under `src/ui` is bundled to
 * `dist/renderer`, which the Electron main process loads in production
 * (in dev it loads the Vite dev server URL instead).
 */
export default defineConfig({
  root: "src/ui",
  // Relative asset paths so the built index.html loads over file:// in
  // the Electron main process (loadFile), not only from a dev server.
  base: "./",
  plugins: [react()],
  server: {
    // Bind explicitly: `localhost` resolves to ::1 on some setups, and
    // the `dev` script's wait-on probes 127.0.0.1.
    host: "127.0.0.1",
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
  },
});
