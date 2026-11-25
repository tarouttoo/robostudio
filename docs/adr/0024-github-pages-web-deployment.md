# GitHub Pages: the web deployment channel

The renderer is deployed as-is to GitHub Pages at
`https://tarouttoo.github.io/robostudio/`. Every push to `main` rebuilds
and republishes the site automatically — this is the **Web Deployment**
(GLOSSARY), a distribution channel deliberately separate from the Release:
no tags, no draft, no manual publish step, no version stamping. The site
always mirrors the tip of `main`.

The desktop app stays Electron; the site ships only the renderer bundle
(~312 KB, one JS file). The preload Bridge is optional by design (ADR
`0003`): in a plain browser `bridge()` returns `null`, and the privileged
operations — Export, project Save/Open — report themselves unavailable
instead of failing mysteriously. Everything else (drawing, generation,
charts, the Motion Preview dialog) runs identically: the whole domain is
pure TypeScript computing in the visitor's browser; there is no backend.

## Considered options

- **Full browser parity** — Blob downloads for the Robot CSV, the RViz
  CSV and the Motion Preview GIF; `<input type="file">` for Open; a
  download for Save. Deferred: it changes product code, so it must ride
  the pipeline as a Spec.
- **Hiding the degraded buttons in web builds** — rejected for the
  minimal scope: zero product-code changes is the point, and an honest
  «недоступен» message beats silent absence.
- **Tag-gated or manual deploys** — rejected: the operator pushes to
  `main` constantly and wants the URL to mirror that. A tag gate would
  make the web channel a second Release — exactly the confusion the
  glossary separates.
- **Deploying without the lint/typecheck/test gate** — rejected: the site
  ships outward, so unverified code must fail the run (same rationale as
  the release workflow's gate).

## Consequences

- `.github/workflows/deploy-pages.yml` runs on `main` pushes: it runs the
  gate, builds the renderer (`base: "./"` already suits the `/robostudio/`
  subpath), uploads `dist/renderer`, and deploys through the official
  Pages actions. Pages itself is enabled once via the API
  (`build_type: workflow`).
- The site is public: anyone with the URL can open the studio, and no
  data leaves the visitor's machine.
- Browser parity (downloads, `<input type="file">`) is a future Spec —
  not part of this decision.
