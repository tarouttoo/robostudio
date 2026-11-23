import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The release contract (ADR 0009): pushing a `v*` tag builds exactly the
 * ADR 0009 packaging targets — Windows NSIS installer + portable zip,
 * Linux portable zip — and opens one draft GitHub release carrying all
 * three artifacts, named after the released version. The maintainer
 * explicitly declined Linux installers and AppImage (ADR 0009), so no
 * other target may appear.
 *
 * Release publishing is a one-way door (README, "One-way doors"), so the
 * electron-builder config in package.json and the release workflow are
 * pinned here: a target cannot appear, disappear, or rename silently.
 */

type BuilderConfig = {
  files?: string[];
  directories?: { output?: string };
  npmRebuild?: boolean;
  win?: { target?: string[]; artifactName?: string };
  nsis?: { artifactName?: string };
  linux?: { target?: string[]; artifactName?: string };
};

type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  shell?: string;
};

type ReleaseWorkflow = {
  name: string;
  on: { push?: { tags?: string[] } };
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      needs?: string;
      permissions?: Record<string, string>;
      "runs-on"?: string;
      strategy?: { failFast?: boolean; matrix?: { os?: string[] } };
      steps?: WorkflowStep[];
    }
  >;
};

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
  main: string;
  dependencies?: Record<string, string>;
  description?: string;
  author?: string;
  build?: BuilderConfig;
};

const workflow = parse(
  readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"),
) as ReleaseWorkflow;

const buildJob = workflow.jobs?.build;
const releaseJob = workflow.jobs?.release;
const runs = (job: { steps?: WorkflowStep[] } | undefined): string[] =>
  (job?.steps ?? []).map((step) => step.run ?? "");

const artifactNames = (): (string | undefined)[] => [
  pkg.build?.nsis?.artifactName,
  pkg.build?.win?.artifactName,
  pkg.build?.linux?.artifactName,
];

describe("electron-builder config (package.json build)", () => {
  it("declares exactly the ADR 0009 targets: Windows NSIS + portable zip, Linux zip", () => {
    expect(pkg.build).toBeDefined();
    expect(pkg.build?.win?.target).toEqual(["nsis", "zip"]);
    expect(pkg.build?.linux?.target).toEqual(["zip"]);
  });

  it("adds no non-ADR-0009 target (no mac, no Linux installers, no AppImage)", () => {
    expect(pkg.build?.win?.target?.length).toBe(2);
    expect(pkg.build?.linux?.target?.length).toBe(1);
    expect(pkg.build).not.toHaveProperty("mac");
    expect(JSON.stringify(pkg.build)).not.toMatch(/\b(appimage|deb|rpm|pacman|snap|flatpak)\b/i);
  });

  it("names every artifact after the app and the released version", () => {
    for (const artifactName of artifactNames()) {
      expect(artifactName).toMatch(/^\$\{name\}-\$\{version\}-[a-z-]+\.\$\{ext\}$/);
    }
    // The Windows zip carries the portable marker so the artifact name
    // says what it is (issue #30); the installer already says "setup".
    expect(pkg.build?.win?.artifactName).toContain("win-portable");
    // Three distinct artifacts: the installer, the Windows portable zip,
    // the Linux zip.
    expect(new Set(artifactNames()).size).toBe(3);
  });

  it("packages the built bundles (dist/) into a separate output directory", () => {
    expect(pkg.main).toBe("dist/main/main.js");
    expect(pkg.build?.files).toContain("dist/**/*");
    expect(pkg.build?.directories?.output).toBe("release");
  });

  it("does not rebuild native modules: the app ships fully bundled", () => {
    expect(pkg.build?.npmRebuild).toBe(false);
  });

  it("has no runtime dependencies: nothing but the bundles and the electron runtime ships", () => {
    // ADR 0003: one package.json world where everything is bundled —
    // the renderer by Vite, main/preload by esbuild. electron-builder
    // copies production dependencies into the package unconditionally,
    // so a dependency here ships inside the app even though the bundle
    // never loads it.
    expect(pkg.dependencies).toBeUndefined();
  });

  it("carries the installer metadata (description, author)", () => {
    expect(pkg.description).toBe("CNC-style trajectory studio for the MiKo-mini 3-DOF manipulator.");
    expect(typeof pkg.author).toBe("string");
  });
});

describe("release workflow (.github/workflows/release.yml)", () => {
  it("fires on v* tag pushes only", () => {
    expect(workflow.on?.push?.tags).toEqual(["v*"]);
    expect(Object.keys(workflow.on ?? {})).toEqual(["push"]);
  });

  it("builds the release on Windows and Linux runners", () => {
    expect(buildJob?.strategy?.matrix?.os).toEqual(["windows-latest", "ubuntu-latest"]);
    expect(buildJob?.["runs-on"]).toBe("${{ matrix.os }}");
  });

  it("runs the same quality gate as CI before packaging", () => {
    const steps = runs(buildJob);
    expect(steps.some((run) => run.includes("npm run lint"))).toBe(true);
    expect(steps.some((run) => run.includes("npm run typecheck"))).toBe(true);
    expect(steps.some((run) => run.includes("npm run test:app"))).toBe(true);
  });

  it("stamps the tag version before building so artifact names match the release", () => {
    const steps = runs(buildJob);
    const stamp = steps.findIndex((step) => step.includes("npm version"));
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(steps[stamp]).toContain("--no-git-tag-version");
    expect(steps[stamp]).toContain("${GITHUB_REF_NAME#v}");
    // The load-bearing part of the contract: the stamp happens before the
    // bundles are built and packaged, or the artifact names carry a stale
    // package.json version instead of the tag.
    expect(stamp).toBeLessThan(steps.findIndex((step) => step.includes("npm run build")));
    expect(stamp).toBeLessThan(steps.findIndex((step) => step.includes("electron-builder")));
  });

  it("builds the app bundles, then packages with electron-builder", () => {
    const steps = runs(buildJob);
    expect(steps.some((run) => run.includes("npm run build"))).toBe(true);
    expect(steps.some((run) => run.includes("electron-builder"))).toBe(true);
  });

  it("never publishes from the build legs: only the release job opens the release", () => {
    const run = runs(buildJob).find((step) => step.includes("electron-builder"));
    expect(run).toContain("--publish never");
  });

  it("uploads the per-platform artifacts and fails the leg if none are produced", () => {
    const upload = (buildJob?.steps ?? []).find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload).toBeDefined();
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
  });

  it("fails the release job unless exactly the three ADR 0009 artifacts arrive, named per the config", () => {
    const check = runs(releaseJob).find((run) => run.includes("release-artifacts"));
    expect(check).toContain('"3"');
    expect(check).toContain("*-setup.exe");
    expect(check).toContain("*-win-portable.zip");
    expect(check).toContain("*-linux.zip");
  });

  it("opens a single draft release from every build leg's artifacts", () => {
    expect(releaseJob?.needs).toBe("build");
    const download = (releaseJob?.steps ?? []).find((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(download?.with?.["merge-multiple"]).toBe(true);
    const create = runs(releaseJob).find((run) => run.includes("gh release create"));
    expect(create).toContain("--draft");
    expect(create).toContain("${GITHUB_REF_NAME}");
  });

  it("writes only to contents, and only where writing is needed", () => {
    // The build legs run third-party code (npm ci, electron-builder) and
    // stay read-only; only the release job, which runs gh release create,
    // gets the write it needs.
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(buildJob?.permissions).toBeUndefined();
    expect(releaseJob?.permissions).toEqual({ contents: "write" });
  });
});
