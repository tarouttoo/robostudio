import { describe, expect, it } from "vitest";

import { arcFromCenter, line, point, vec3 } from "../core";
import { ProjectError } from "./errors";
import {
  PROJECT_SCHEMA_VERSION,
  parseProject,
  serializeProject,
  type ProjectContent,
} from "./file";

/** A content covering every Segment kind, on two planes. */
function fullContent(): ProjectContent {
  return {
    view: { plane: "XZ", fixedMm: 2, feedMmMin: 1200 },
    home: vec3(0, 0, 5),
    segments: [
      line({ start: vec3(0, 0, 2), end: vec3(10, 0, 2), feed: 20 }),
      arcFromCenter({
        plane: "XY",
        start: vec3(10, 0, 0),
        end: vec3(0, 10, 0),
        center: vec3(0, 0, 0),
        direction: "CCW",
        feed: 30,
      }),
      point({ target: vec3(1, 2, 3), feed: 40 }),
    ],
  };
}

describe("serializeProject", () => {
  it("writes a versioned JSON with the view settings, Home Point, and canonical Segments", () => {
    const file = serializeProject(fullContent());
    const parsed = JSON.parse(file) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(parsed.view).toEqual({ plane: "XZ", fixedMm: 2, feedMmMin: 1200 });
    expect(parsed.home).toEqual({ x: 0, y: 0, z: 5 });
    expect(parsed.segments).toEqual([
      { kind: "line", start: { x: 0, y: 0, z: 2 }, end: { x: 10, y: 0, z: 2 }, feed: 20 },
      {
        kind: "arc",
        plane: "XY",
        start: { x: 10, y: 0, z: 0 },
        end: { x: 0, y: 0 + 10, z: 0 },
        direction: "CCW",
        center: { x: 0, y: 0, z: 0 },
        feed: 30,
      },
      { kind: "point", target: { x: 1, y: 2, z: 3 }, feed: 40 },
    ]);
  });

  it("stores home as null while unset", () => {
    const file = serializeProject({
      view: { plane: "XY", fixedMm: 0, feedMmMin: 1200 },
      home: null,
      segments: [],
    });
    expect(JSON.parse(file)).toMatchObject({ home: null, segments: [] });
  });
});

describe("parseProject", () => {
  it("round-trips: parse(serialize(content)) restores the full content", () => {
    const content = fullContent();
    expect(parseProject(serializeProject(content))).toEqual(content);
  });

  it("re-derives canonical Arc values (radius, sweep) from the stored definition", () => {
    const content = fullContent();
    const restored = parseProject(serializeProject(content));
    const arc = restored.segments[1];
    expect(arc?.kind).toBe("arc");
    if (arc?.kind !== "arc") return;
    expect(arc.radiusMm).toBe(10);
    expect(arc.sweepRad).toBeCloseTo(Math.PI / 2, 12);
  });

  it("parses a file without the trailing newline", () => {
    const content = fullContent();
    expect(parseProject(serializeProject(content).trimEnd())).toEqual(content);
  });

  it.each([
    [2, "newer"],
    [99, "newer"],
    [0, "unknown"],
    [-1, "unknown"],
  ])("rejects schema version %i (%s) with a readable, named error", (version, kind) => {
    const error = captureError(() => parseProject(serializeWith({ schemaVersion: version })));
    expect(error.tag).toBe("UnsupportedSchemaVersion");
    expect(error.message).toContain(String(version));
    expect(error.message).toContain(String(PROJECT_SCHEMA_VERSION));
    expect(error.message).toMatch(kind === "newer" ? /newer/ : /unknown/);
  });

  it("rejects a missing or non-numeric schemaVersion", () => {
    // JSON.stringify drops undefined fields: the file has no schemaVersion.
    expect(captureError(() => parseProject(serializeWith({ schemaVersion: undefined }))).tag).toBe(
      "InvalidProjectFile",
    );
    expect(captureError(() => parseProject(serializeWith({ schemaVersion: "1" }))).tag).toBe(
      "InvalidProjectFile",
    );
  });

  it("rejects malformed JSON with a readable error, not a raw SyntaxError", () => {
    const error = captureError(() => parseProject("{ not json"));
    expect(error.tag).toBe("InvalidProjectFile");
    expect(error.message).toContain("not valid JSON");
  });

  it("rejects a non-object top level", () => {
    for (const text of ["[]", "42", "\"a string\"", "null"])
      expect(captureError(() => parseProject(text)).tag).toBe("InvalidProjectFile");
  });

  it("rejects an unknown Segment kind by name", () => {
    const base = JSON.parse(serializeProject(fullContent())) as { segments: Array<{ kind: string }> };
    base.segments[0]!.kind = "spline";
    const error = captureError(() => parseProject(JSON.stringify(base)));
    expect(error.tag).toBe("InvalidProjectFile");
    expect(error.message).toContain("spline");
  });

  it("rejects impossible geometry via the core: an arc end off its center's circle", () => {
    // Start (10, 0) fixes radius 10 around the center; an end at (0, 10.5)
    // sits 0.5 mm off that circle — arcFromCenter rejects it at parse time.
    const file = JSON.stringify({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      view: { plane: "XY", fixedMm: 0, feedMmMin: 1200 },
      home: null,
      segments: [
        {
          kind: "arc",
          plane: "XY",
          start: { x: 10, y: 0, z: 0 },
          end: { x: 0, y: 10.5, z: 0 },
          direction: "CCW",
          center: { x: 0, y: 0, z: 0 },
          feed: 20,
        },
      ],
    });
    const error = captureError(() => parseProject(file));
    expect(error.name).toBe("ArcCenterOffCircle");
    expect(error.message).toContain("does not lie on");
  });
});

/** Serializes the fixture content with top-level fields overridden. */
function serializeWith(overrides: Record<string, unknown>): string {
  const base = JSON.parse(serializeProject(fullContent())) as Record<string, unknown>;
  return JSON.stringify({ ...base, ...overrides });
}

/** Runs `run`, returning the thrown error; fails the test when nothing throws. */
function captureError(run: () => unknown): ProjectError {
  try {
    run();
  } catch (e) {
    return e as ProjectError;
  }
  throw new Error("expected the call to throw a ProjectError");
}
