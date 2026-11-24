import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_MIKO_MINI_CONFIG } from "../kinematics/miko-mini";
import { createRobotRegistry } from "../kinematics/registry";
import type { RobotModel } from "../kinematics/robot-model";
import { createSplinePlanner } from "../motion/planner";
import { runPipeline } from "./pipeline";
import { FIXTURE_TRAJECTORY } from "./golden/fixture";

/** The default MiKo-mini model from validated configuration. */
function defaultModel(): RobotModel {
  const result = createRobotRegistry([DEFAULT_MIKO_MINI_CONFIG]);
  if (result.status !== "ok") throw new Error(`registry failed: ${result.problems.join("; ")}`);
  const model = result.registry.resolve("miko-mini");
  if (!model) throw new Error("model miko-mini was not resolved");
  return model;
}

/** Reads a committed golden fixture, byte for byte. */
function goldenFile(name: string): string {
  const fixture = readFileSync(join(import.meta.dirname, "golden", name), "utf8");
  if (fixture.includes("\r")) {
    // The committed bytes are the contract (ADR 0006): a CR here means
    // git rewrote the line endings on checkout — the `*.csv` rule in
    // `.gitattributes` must apply to this working tree.
    throw new Error(
      `${name} carries CR bytes: the golden fixtures are byte-level contracts (ADR 0006, bare \\n endings) and must be checked out with LF endings — check .gitattributes`,
    );
  }
  return fixture;
}

describe("golden fixtures (ADR 0006)", () => {
  const model = defaultModel();
  const result = runPipeline({
    trajectory: FIXTURE_TRAJECTORY,
    model,
    planner: createSplinePlanner(model),
  });

  it("exports Robot CSV bytes identical to the committed fixture", () => {
    const fixture = goldenFile("robot-csv-fixture.csv");
    expect(fixture.startsWith("t,q1,q2,q3\n")).toBe(true);
    expect(fixture.split("\n").length - 2).toBe(result.plan.rows.length);
    expect(result.robotCsv).toBe(fixture);
  });

  it("exports RViz CSV bytes identical to the committed fixture", () => {
    const fixture = goldenFile("rviz-csv-fixture.csv");
    expect(fixture.startsWith("t,q1,q2,q3\n")).toBe(true);
    expect(fixture.split("\n").length - 2).toBe(result.plan.rows.length);
    expect(result.rvizCsv).toBe(fixture);
  });
});
