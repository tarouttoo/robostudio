# Packaging targets: Windows NSIS + zip, Linux portable zip

Releases publish exactly: Windows NSIS installer and portable zip; Linux
portable zip. The operator machines are Windows boxes and an Arch-based
CachyOS workstation; the maintainer explicitly declined Linux installers
(`deb` is foreign to Arch) and AppImage.

## Considered options

- **AppImage** — runs on Arch (fuse2 is in the repos), but the maintainer
  prefers plain zip: unpack and run, no FUSE assumptions on the target
  machine; rejected for v1.
- **pacman package** — the most native fit for the Arch machine; deferred:
  electron-builder can add the `pacman` target later without touching
  anything else. Revisit when the release cadence justifies it.
- **deb/rpm** — rejected: no Debian-family targets exist in this
  deployment.

## Consequences

- The release workflow builds two Windows targets and one Linux target on
  `v*` tags and opens a draft GitHub release.
- New targets are additive electron-builder configuration plus a workflow
  tweak — no code impact; the decision to keep v1 minimal is cheap to
  reverse.
