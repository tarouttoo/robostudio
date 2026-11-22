# TypeScript on Electron + React + Vite

robostudio is a TypeScript application on Electron with a React renderer
and Vite tooling. The rewrite replaces a Python (tkinter + numpy/scipy)
prototype; the deciding constraints were a single-language toolchain the
maintainer already runs (the agent pipeline itself is TypeScript), first-
class cross-platform builds for Windows and Linux from GitHub Actions, and
an UI ecosystem rich enough for a drawing canvas and chart views.

## Considered options

- **Tauri + React** — lighter binaries, but adds a Rust toolchain and a
  second language to the project for no capability the product needs;
  rejected.
- **Local web app (npm start → browser)** — zero packaging, but the shop
  machines expect "a program", and file associations / offline behavior
  get awkward; rejected.

## Consequences

- One `package.json` world: CI is lint + typecheck + vitest; releases are
  electron-builder targets on tags.
- Heavier installers than a native shell — accepted; workshop machines are
  not storage-constrained.
- The renderer is sandboxed web code; file system access goes through the
  main process (export dialogs, project files).
