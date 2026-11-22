import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The layer structure from ADR 0003: core, kinematics, motion, export,
 * project, app, ui. Dependencies point strictly downwards:
 *
 * - `core` — math core shared by everything; zero runtime dependencies
 *   (ADR 0004), imports nothing from any layer or npm package.
 * - `kinematics` — RobotModel implementations: chain descriptions, FK/IK.
 * - `motion` — Planner implementations: discretization → time-parameterized
 *   joint motion.
 * - `export` — Exporters writing named outputs (Robot CSV, RViz CSV).
 * - `project` — the versioned Project File schema and (de)serialization.
 * - `app` — Electron main process: window lifecycle, preload, sandboxed
 *   renderer shell. Never imports `ui`.
 * - `ui` — React renderer. Never imports `app`; talks to the main process
 *   only through the preload bridge.
 */
const ALLOWED_DEPS = {
  core: [],
  kinematics: ["core"],
  motion: ["core", "kinematics"],
  export: ["core", "motion"],
  project: ["core"],
  app: ["core", "project"],
  ui: ["core", "kinematics", "motion", "export", "project"],
} satisfies Record<string, readonly string[]>;

type Layer = keyof typeof ALLOWED_DEPS;

const SRC_DIR = resolve(import.meta.dirname);
const SPECIFIERS = [
  /\bfrom\s*["']([^"']+)["']/g, // import/export ... from "..."
  /\bimport\s*["']([^"']+)["']/g, // side-effect import "..."
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // await import("...")
];

function* layerSourceFiles(layer: Layer): Generator<string> {
  const entries = readdirSync(join(SRC_DIR, layer), { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    if (!entry.isFile()) continue;
    if (!/\.[cm]?tsx?$/.test(entry.name)) continue;
    // Test files are dev-time artifacts, never shipped: they may import
    // test runners and other layers' internals freely.
    if (/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)) continue;
    yield path;
  }
}

function importedSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const pattern of SPECIFIERS) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1] as string);
    }
  }
  return specifiers;
}

function resolveLayer(file: string, specifier: string): Layer | "src-root" | "external" {
  if (!specifier.startsWith(".")) return "external";
  const target = resolve(dirname(file), specifier);
  const rel = relative(SRC_DIR, target).replace(/\\/g, "/");
  const candidates = [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`];
  for (const candidate of candidates) {
    const layer = candidate.split("/")[0];
    if (layer !== undefined && layer in ALLOWED_DEPS && candidate.includes("/")) {
      return layer as Layer;
    }
  }
  return "src-root";
}

describe("layer structure", () => {
  it("has every layer directory from ADR 0003", () => {
    const layers = readdirSync(SRC_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(layers).toEqual(Object.keys(ALLOWED_DEPS).sort());
  });

  it("has source files in every layer", () => {
    for (const layer of Object.keys(ALLOWED_DEPS) as Layer[]) {
      const files = [...layerSourceFiles(layer)];
      expect(files, `layer ${layer} is empty`).not.toHaveLength(0);
    }
  });

  for (const [layer, allowed] of Object.entries(ALLOWED_DEPS) as [Layer, readonly string[]][]) {
    it(`layer ${layer} imports only ${allowed.length > 0 ? allowed.join(", ") : "nothing"}`, () => {
      const violations: string[] = [];
      for (const file of layerSourceFiles(layer)) {
        for (const specifier of importedSpecifiers(file)) {
          const target = resolveLayer(file, specifier);
          if (target === "src-root") {
            violations.push(`${file}: import "${specifier}" points outside any layer`);
          } else if (target === "external") {
            if (layer === "core") {
              violations.push(`${file}: core has zero runtime dependencies, imports "${specifier}"`);
            }
          } else if (target !== layer && !allowed.includes(target)) {
            violations.push(`${file}: ${layer} may not import layer ${target} ("${specifier}")`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }

  it("ui never imports node built-ins or electron: the sandboxed renderer does no file system access (ADR 0003)", () => {
    const violations: string[] = [];
    for (const file of layerSourceFiles("ui")) {
      for (const specifier of importedSpecifiers(file)) {
        if (specifier.startsWith("node:") || specifier === "electron") {
          violations.push(`${file}: ui imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
